// background-review-watch — status chip + nudge countdown for Hermes background self-improvement runs,
// plus compaction and foreground-completion guards for local-model workloads.
//
// Disk plugin (loaded uncompiled): only @hermes/plugin-sdk / react / react/jsx-runtime resolve.
//
// What it shows (status bar, right cluster):
//   review chip (always):
//     idle    → "review idle"   + fill bar: turns since last review / nudge interval
//     running → "review running · 2m 14s" (pulsing dot, accent color)
//     just done → "review done 3s ago" + the summary text in the tooltip
//     stale   → "review stale · 16h 10m" (warning dot) — a spawn marker with no terminal
//               line older than the review-stale ceiling (default 4h, configurable). The
//               review process died without logging (gateway reboot/kill/OOM); nothing is
//               running, slot is free. Capped in BOTH layers: poll-side classification AND
//               render time (v0.5.0), so a frozen "running" state self-corrects at render.
//   compaction chip (always):
//     running → "compacting · 4m 12s" (pulsing dot, accent color)
//     just done → "compact done 3m ago" / "compact failed 2m ago" (reduction or failure in tooltip)
//     idle    → "compact idle · last 5d 2h" + the last committed reduction or failure class
//               in the tooltip. The last terminal state is persisted via ctx.storage so it
//               survives log-window rotation, hot reloads, and app restarts.
//     stale   → "compact stale · <age>" when a start marker sits over its orphan ceiling
//               (default 60 min, configurable) with no terminal line — capped in both layers.
//
// Data sources (all read-only, no Python backend, no gateway restart):
//   - host.onEvent('review.summary')        → live review completion + summary text
//   - host.onEvent('message.start')         → turn ticks for the review countdown
//   - host.onEvent('message.complete')      → foreground delivery boundary
//   - host.logs({ file:'agent', search:… }) → markers, self-rescheduling poll (20 s when
//     healthy, 5 s fast-retry after two missed cycles); every read is wrapped in an 8 s
//     timeout so a stalled reader degrades to a fail-open retry instead of freezing state:
//       'bg-review'            → review start/complete markers
//       'context compression'  → batch compaction started/done/attempt-telemetry markers
//       'Micro-compaction'     → per-turn micro-compact pass results
//   - host.request('config.get')            → nudge intervals (best-effort, defaults 10/15)
//
// Detection model: at most one background review runs at a time (a new turn supersedes an
// in-flight one, and superseded runs still log a `complete` line). So:
//   review running  <=>  latest "thread=bg-review:<pid>" start ts  >  latest complete/failed ts
// Resilience: that equality assumes every spawn eventually logs a terminal line. It does not —
// the review is a THREAD inside the gateway process (thread ident, not pid), and a reboot or
// kill mid-review dies with no log at all (observed 2026-10-14: spawn 19:34, PC reboot 19:47,
// no terminal line ever; chip pinned "running" for 16h+). A spawn older than the review-stale
// ceiling with no terminal line is therefore reported as `stale` (diagnostic), not `running`.
//
// Poll liveness (v0.5.0): the log reads above are the ONLY source of truth, and a stalled
// reader used to wedge them forever — live incident 10-16/17: state frozen at "running"
// anchored on a start whose terminal line had been on disk for hours; the v0.4.1 render cap
// relabeled it "compact stale · 30h+" (correct label, unrecovered state). Now: (1) every
// host.logs call has an 8 s timeout (a stall is a rejection the fail-open catch absorbs, and
// the next cycle retries), and (2) the poll loop self-reschedules — two cycles without a
// successful reconcile drop the cadence to 5 s until one succeeds, then back to 20 s. When a
// stalled reader recovers, the next successful poll re-derives state from the live log.
//
// Compaction runs one at a time too (the compressor serializes attempts on the session).
// A batch attempt logs `context compression started:` at attempt start and exactly one
// terminal line at attempt end: `context compression done:` (committed) and/or the
// `context compression attempt telemetry:` JSON line (covers both committed and aborted,
// carries failure_class + total_duration_ms). So:
//   compaction running <=> latest start ts > latest terminal (done/telemetry) ts
//
// agent.log markers (verified 2026-09-27 against agent/conversation_compression.py:4011/4223/1498,
// agent/turn_finalizer.py:302/304, and 10 historical attempts in agent.log 09-20..09-26):
//   start:   "<ts> INFO agent.conversation_compression: context compression started: session=… messages=N tokens=~… model=… focus=…"
//   done:    "<ts> INFO … context compression done: session=… messages=A->B rough_tokens=~… awaiting_real_usage=true"
//   terminal:"<ts> INFO … context compression attempt telemetry: {"…","commit_status":"committed|aborted","failure_class":"stall_interrupted|…","total_duration_ms":…,…}"
//   micro ok:   "<ts> INFO agent.turn_finalizer: Micro-compaction: A -> B messages"
//   micro fail: "<ts> WARNING agent.turn_finalizer: Micro-compaction failed: <err>"

import { host, STATUSBAR_AREAS, Tip, ListRow } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useSyncExternalStore, useState, useEffect } from 'react'

const POLL_MS = 20000 // log poll cadence when healthy (idle cost: a few tiny server-side-filtered REST calls)
const RECENT_DONE_MS = 600000 // keep the "done Xs ago" label for 10 min, then plain idle
const RECENT_COMP_MS = 600000 // keep the compaction chip 10 min after a finish
const RECENT_GUARD_MS = 600000 // keep completion-boundary diagnostics visible for 10 min

// Orphan-spawn ceilings — DEFAULTS. Both are user-configurable (minutes) via
// Settings ▸ Plugins ▸ Thresholds and persist in ctx.storage (SETTINGS_KEY).
// Verified local-model review runs on this box: 22 min and 26 min (agent.log, 10-14 pairs);
// 4h leaves wide headroom over anything healthy. Above the ceiling, "running" can only mean
// the process died without logging — report stale, not running.
const DEFAULT_REVIEW_STALE_MIN = 4 * 60
// Orphan ceiling for COMPACTION (default). Measured runs on this box: ~5 min (10-14 18:34)
// and ~8 min (10-15 19:32, ~200K tokens). A start marker older than the ceiling with no
// terminal line can only mean a run that died without logging (process/gateway fault) —
// report stale, never "running". The chip ALSO caps at render time, so even a frozen poll
// state cannot display an unbounded "compacting" (incident 10-15: chip pinned
// "compacting · 3h+" although the terminal line had been on disk for hours — poll-side
// classification alone could not surface it).
const DEFAULT_COMPACT_STALE_MIN = 60
const MIN_STALE_MIN = 1
const MAX_STALE_MIN = 7 * 24 * 60 // a ceiling above one week is meaningless

const SETTINGS_KEY = 'background-review-watch.settings.v1'       // ctx.storage: { v, reviewStaleMin, compactStaleMin }
const REVIEW_LAST_KEY = 'background-review-watch.review-last.v1' // ctx.storage: last terminal review record
const COMPACT_LAST_KEY = 'background-review-watch.compact-last.v1' // ctx.storage key for the last terminal compaction

// Log reads must not hang forever: a stalled reader used to freeze the poll state (the
// 10-16/17 "compact stale · 30h+" incident — see header). An 8 s timeout turns a stall into
// a fail-open retry; the self-rescheduling timer in ensureWired() retries fast while polls
// are unhealthy and re-derives state from the live log on recovery.
const LOG_TIMEOUT_MS = 8000
// Poll liveness: more than two missed cycles without a successful reconcile → fast-retry cadence.
const UNHEALTHY_AFTER_MS = 2 * POLL_MS
const FAST_RETRY_MS = 5000

// Reject if `promise` does not settle within `ms`. The original promise is left to run to
// completion (read-only tail) — its late result is simply ignored.
function withTimeout(promise, ms, label) {
  let t
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t))
}

// Single source of truth for "this compaction state is over its orphan budget".
// Used by reconcileCompaction (poll side) AND CompactionChip (render side — the
// backstop that works even when poll state is frozen).
function compactStale(mode, startedAt, now, limitMs = DEFAULT_COMPACT_STALE_MIN * 60000) {
  return mode === 'running' && startedAt != null && now - startedAt > limitMs
}
// Review-side twin of the render-time cap (v0.5.0): a frozen "review running" state must
// degrade to stale at render time too, not count up unbounded — before v0.5.0 the review
// chip had only the poll-side classification (the compaction chip got both layers in 0.4.1).
function reviewStale(mode, startedAt, now, limitMs = DEFAULT_REVIEW_STALE_MIN * 60000) {
  return mode === 'running' && startedAt != null && now - startedAt > limitMs
}

// Sanitize user-provided thresholds (Settings page). Minutes; clamped to [MIN, MAX],
// defaults win on junk. Pure — safe to call from the render path.
function sanitizeSettings(raw) {
  const get = (k, def) => {
    const n = Number(raw && raw[k])
    return Number.isFinite(n) && n >= MIN_STALE_MIN ? Math.min(MAX_STALE_MIN, Math.floor(n)) : def
  }
  return {
    v: 1,
    reviewStaleMin: get('reviewStaleMin', DEFAULT_REVIEW_STALE_MIN),
    compactStaleMin: get('compactStaleMin', DEFAULT_COMPACT_STALE_MIN),
  }
}

const RE_START = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+.*OpenAI client created.*thread=bg-review:(\d+)/
const RE_DONE = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+.*(Background review complete|Background memory\/skill review failed)(?:.*result=(\w+))?/
const RE_TURN = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+.*Turn ended/

const RE_COMP_START = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+.*context compression started: session=(\S+) messages=(\d+) tokens=~?([\d,]+)/
const RE_COMP_DONE = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+.*context compression done: session=(\S+) messages=(\d+)->(\d+)/
const RE_COMP_TEL = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+.*context compression attempt telemetry: (.*)$/
const RE_MICRO_OK = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+.*Micro-compaction: (\d+) -> (\d+) messages/
const RE_MICRO_FAIL = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+.*Micro-compaction failed: (.+)/
const RE_TICKER_TIMEOUT = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+.*usage ticker stop timed out: session=(\S+)/

function lineText(l) {
  return typeof l === 'string' ? l : (l && (l.line || l.message || l.text)) || ''
}
function ts(s) {
  const d = new Date(s.replace(' ', 'T').replace(',', '.')) // agent.log timestamps are local time
  return isNaN(d) ? null : d.getTime()
}
function lineTs(text) {
  const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d+)/.exec(text)
  return m ? ts(m[1]) : null
}
function ago(ms) {
  if (ms == null) return '…'
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}
function fmtTokens(n) {
  if (n == null) return '?'
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}
function trimSummary(t) {
  const s = (t || '').trim()
  return s.length > 160 ? `${s.slice(0, 157)}…` : s
}

// ── plugin-global state (shared by the chips; module-scoped = survives chip re-mounts) ──
let state = {
  mode: 'idle', // 'idle' | 'running' | 'stale' (orphaned spawn marker, slot free)
  startedAt: null,
  doneAt: null,
  doneResult: null,
  doneSummary: null,
  turnsSince: 0,
  memInterval: 10,
  skillInterval: 15,
  lastPoll: 0,
  foregroundStartedAt: null,
  foregroundCompletedAt: null,
  reviewOverlapAt: null,
  tickerRecoveryAt: null,
  tickerRecoverySession: null,
  guardLastPoll: 0,
  staleReviewMs: DEFAULT_REVIEW_STALE_MIN * 60000, // user-configurable (Settings ▸ Thresholds)
  staleCompactMs: DEFAULT_COMPACT_STALE_MIN * 60000,
  reviewLastRec: null, // { v, endedAt, result, summary } — persisted via ctx.storage
  compact: {
    mode: 'idle', // 'idle' | 'running'
    startedAt: null,
    startTokens: null,
    endedAt: null,
    committed: null, // true = committed, false = aborted, null = unknown
    failure: null,
    doneFrom: null,
    doneTo: null,
    lastMicroAt: null,
    microDetail: null,
    lastPoll: 0,
    lastRec: null, // { v, endedAt, committed, failure, doneFrom, doneTo } — persisted via ctx.storage
  },
}
// Liveness marker for the poll loop (module-scoped, not render-relevant): when the LAST
// successful reconcile processed data. The self-rescheduling timer compares Date.now()
// against this to decide POLL_MS vs FAST_RETRY_MS.
let lastGoodPoll = Date.now()
let subs = new Set()
function set(patch) {
  state = { ...state, ...patch }
  subs.forEach((f) => f())
}
function setCompact(patch) {
  state = { ...state, compact: { ...state.compact, ...patch } }
  subs.forEach((f) => f())
}

// ctx of the current plugin registration (for storage); null under the smoke test.
let engineCtx = null

async function hydrateSettings() {
  if (!engineCtx || !engineCtx.storage) return
  try {
    const rec = await engineCtx.storage.get(SETTINGS_KEY)
    if (rec && rec.v === 1) applySettings(rec)
  } catch { /* storage blip — defaults stand */ }
}

function persistSettings(rec) {
  if (!engineCtx || !engineCtx.storage) return
  engineCtx.storage.set(SETTINGS_KEY, rec).catch(() => {})
}

// Sanitize + persist + apply. Called from the Settings page (user value) and hydrate (stored value).
function applySettings(raw) {
  const s = sanitizeSettings(raw)
  persistSettings(s)
  set({ staleReviewMs: s.reviewStaleMin * 60000, staleCompactMs: s.compactStaleMin * 60000 })
}

async function hydrateLastCompact() {
  if (!engineCtx || !engineCtx.storage) return
  try {
    const rec = await engineCtx.storage.get(COMPACT_LAST_KEY)
    if (rec && rec.v === 1 && typeof rec.endedAt === 'number') setCompact({ lastRec: rec })
  } catch { /* storage blip — "compact idle" stands until a fresh terminal line lands */ }
}

function persistLastCompact(rec) {
  if (!engineCtx || !engineCtx.storage) return
  engineCtx.storage.set(COMPACT_LAST_KEY, rec).catch(() => {})
}

async function hydrateReviewLast() {
  if (!engineCtx || !engineCtx.storage) return
  try {
    const rec = await engineCtx.storage.get(REVIEW_LAST_KEY)
    if (rec && rec.v === 1 && typeof rec.endedAt === 'number') set({ reviewLastRec: rec })
  } catch { /* storage blip — the tooltip stands without history */ }
}

function persistReviewLast(rec) {
  if (!engineCtx || !engineCtx.storage) return
  engineCtx.storage.set(REVIEW_LAST_KEY, rec).catch(() => {})
}

function collectReviewMarkers(lines) {
  let start = null
  let done = null
  let result = null
  for (const text of lines.map(lineText)) {
    let m = RE_DONE.exec(text)
    if (m) {
      const t = lineTs(text) || ts(m[1])
      if (t && (done == null || t > done)) { done = t; result = m[3] != null ? m[3] : null }
      continue
    }
    m = RE_START.exec(text)
    if (m) {
      const t = lineTs(text) || ts(m[1])
      if (t && (start == null || t > start)) start = t
    }
  }
  return { start, done, result }
}

// Telemetry JSON fields (keys are sorted in the log line; match by key, not position)
function parseCompactionTelemetry(json) {
  const cs = /"commit_status"\s*:\s*"(\w+)"/.exec(json)
  if (!cs) return null
  const fc = /"failure_class"\s*:\s*"(\w+)"/.exec(json)
  const dm = /"total_duration_ms"\s*:\s*(\d+)/.exec(json)
  return {
    committed: cs[1] === 'committed',
    failure: cs[1] === 'aborted' ? (fc ? fc[1] : null) : null,
    durationMs: dm ? +dm[1] : null,
  }
}

function collectCompactionMarkers(lines) {
  let start = null
  let startTokens = null
  let telTs = null
  let tel = null // { committed, failure, durationMs } of the newest telemetry line
  let doneTs = null
  let doneFrom = null
  let doneTo = null
  for (const text of lines.map(lineText)) {
    let m = RE_COMP_DONE.exec(text)
    if (m) {
      const t = ts(m[1])
      if (t && (doneTs == null || t > doneTs)) { doneTs = t; doneFrom = +m[3]; doneTo = +m[4] }
      continue
    }
    m = RE_COMP_TEL.exec(text)
    if (m) {
      const t = ts(m[1])
      const parsed = parseCompactionTelemetry(m[2] || '')
      if (t && parsed && (telTs == null || t > telTs)) { telTs = t; tel = parsed }
      continue
    }
    m = RE_COMP_START.exec(text)
    if (m) {
      const t = ts(m[1])
      if (t && (start == null || t > start)) { start = t; startTokens = m[4] ? +m[4].replace(/,/g, '') : null }
    }
  }
  const endTs = Math.max(telTs || 0, doneTs || 0) || null
  return { start, startTokens, end: endTs, tel, doneFrom, doneTo }
}

function collectMicroMarkers(lines) {
  let at = null
  let detail = null
  for (const text of lines.map(lineText)) {
    let m = RE_MICRO_OK.exec(text)
    if (m) {
      const t = ts(m[1])
      if (t && (at == null || t > at)) { at = t; detail = `${m[2]} → ${m[3]} msgs` }
      continue
    }
    m = RE_MICRO_FAIL.exec(text)
    if (m) {
      const t = ts(m[1])
      if (t && (at == null || t > at)) { at = t; detail = `failed: ${m[2].slice(0, 80)}` }
    }
  }
  return { at, detail }
}

async function reconcile() {
  const now = Date.now()
  if (now - state.lastPoll < 5000) return // debounce overlapping calls
  state.lastPoll = now
  try {
    const rev = await withTimeout(host.logs({ file: 'agent', lines: 200, search: 'bg-review' }), LOG_TIMEOUT_MS, 'agent.log poll (bg-review)')
    const lines = (rev && (rev.lines || rev.data || rev.logs)) || []
    const { start, done, result } = collectReviewMarkers(lines)

    // turns since the last completion (only needed when idle)
    let turns = state.turnsSince
    if (done != null) {
      const tr = await withTimeout(host.logs({ file: 'agent', lines: 5000, search: 'Turn ended' }), LOG_TIMEOUT_MS, 'agent.log poll (Turn ended)')
      const tlines = ((tr && (tr.lines || tr.data || tr.logs)) || []).map(lineText)
      turns = tlines.filter((t) => {
        const m = RE_TURN.exec(t)
        return m && ts(m[1]) > done
      }).length
    }

    // `live` = the log evidence says a review is in flight; `stale` = that claim is old
    // enough (over the configurable ceiling) that only process death explains it — no
    // terminal line survives a reboot/kill. The render-time cap in Chip is the twin
    // backstop for frozen state (v0.5.0).
    const live = start != null && (done == null || start > done)
    const stale = live && now - start > state.staleReviewMs
    const overlap = start != null && state.foregroundStartedAt != null &&
      start >= state.foregroundStartedAt &&
      (state.foregroundCompletedAt == null || start < state.foregroundCompletedAt)

    // Persist the newest terminal review (log path: result from the marker, no summary
    // text — the live review.summary event path writes the richer record; it wins on ties
    // because it is never older than the marker's own timestamp).
    let lastRec = state.reviewLastRec
    if (done != null && (!lastRec || done > (lastRec.endedAt || 0) || (done === (lastRec.endedAt || 0) && !lastRec.summary))) {
      lastRec = {
        v: 1,
        endedAt: done,
        result: result != null ? result : (lastRec && lastRec.result) || null,
        summary: (lastRec && lastRec.summary) || null,
      }
      persistReviewLast(lastRec)
    }

    set({
      mode: stale ? 'stale' : live ? 'running' : 'idle',
      startedAt: live ? (state.startedAt || start) : null,
      doneAt: done,
      doneResult: done != null && result != null ? result : state.doneResult,
      // Only a genuinely running review holds the slot; stale/idle report the real countdown.
      turnsSince: live && !stale ? 0 : turns,
      reviewOverlapAt: overlap ? start : state.reviewOverlapAt,
      reviewLastRec: lastRec,
    })
    lastGoodPoll = Date.now()
  } catch {
    /* fail-open: keep last state on a REST blip or a timed-out read (the liveness
       cadence in ensureWired notices via lastGoodPoll and retries fast) */
  }
}

async function reconcileGuard() {
  const now = Date.now()
  if (now - state.guardLastPoll < 5000) return
  state.guardLastPoll = now
  try {
    const result = await withTimeout(host.logs({ file: 'agent', lines: 100, search: 'usage ticker stop timed out' }), LOG_TIMEOUT_MS, 'agent.log poll (ticker)')
    const lines = (result && (result.lines || result.data || result.logs)) || []
    let at = null
    let session = null
    for (const text of lines.map(lineText)) {
      const m = RE_TICKER_TIMEOUT.exec(text)
      const t = m ? ts(m[1]) : null
      if (t && (at == null || t > at)) { at = t; session = m[2] }
    }
    set({ tickerRecoveryAt: at, tickerRecoverySession: session })
    lastGoodPoll = Date.now()
  } catch {
    /* fail-open: keep last state on a REST blip */
  }
}

async function reconcileCompaction() {
  const now = Date.now()
  if (now - state.compact.lastPoll < 5000) return
  state.compact.lastPoll = now
  try {
    // 3000-line window: a batch compaction can run 20+ min, and the log keeps
    // accumulating unrelated lines while it runs — the start line must stay in view.
    const c = await withTimeout(host.logs({ file: 'agent', lines: 3000, search: 'context compression' }), LOG_TIMEOUT_MS, 'agent.log poll (compaction)')
    const clines = (c && (c.lines || c.data || c.logs)) || []
    const { start, startTokens, end, tel, doneFrom, doneTo } = collectCompactionMarkers(clines)

    const running = start != null && (end == null || start > end)

    // newest terminal wins: telemetry covers both committed and aborted
    let endedAt = null
    let committed = null
    let failure = null
    if (end != null) {
      endedAt = end
      if (tel) { committed = tel.committed; failure = tel.failure }
      else committed = true // only a `done` line (committed path) was in the window
    }

    // Persist the newest terminal state so "last compacted" survives the 3000-line log
    // window rolling past, hot reloads (fresh module), and app restarts.
    let lastRec = state.compact.lastRec
    if (end != null && (!lastRec || end > (lastRec.endedAt || 0))) {
      lastRec = { v: 1, endedAt: end, committed, failure, doneFrom, doneTo }
      persistLastCompact(lastRec)
    }

    const mc = await withTimeout(host.logs({ file: 'agent', lines: 500, search: 'Micro-compaction' }), LOG_TIMEOUT_MS, 'agent.log poll (micro)')
    const mlines = (mc && (mc.lines || mc.data || mc.logs)) || []
    const micro = collectMicroMarkers(mlines)

    // Poll-side stale classification against the configurable ceiling (the render-time cap
    // in CompactionChip is the backstop for frozen state — see compactStale).
    const compStale = running && compactStale('running', state.compact.startedAt || start, now, state.staleCompactMs)

    setCompact({
      mode: compStale ? 'stale' : running ? 'running' : 'idle',
      startedAt: running ? (state.compact.startedAt || start) : null,
      startTokens: running ? (state.compact.startTokens || startTokens) : null,
      endedAt,
      committed,
      failure,
      doneFrom,
      doneTo,
      lastMicroAt: micro.at,
      microDetail: micro.detail,
      lastRec,
    })
    lastGoodPoll = Date.now()
  } catch {
    /* fail-open: keep last state on a REST blip or a timed-out read */
  }
}

function loadIntervals() {
  host.request('config.get', {})
    .then((cfg) => {
      const raw = JSON.stringify(cfg || {})
      const mem = raw.match(/"nudge_interval"\s*:\s*(\d+)/)
      const skill = raw.match(/"creation_nudge_interval"\s*:\s*(\d+)/)
      set({
        memInterval: mem ? Math.max(1, +mem[1]) : 10,
        skillInterval: skill ? Math.max(1, +skill[1]) : 15,
      })
    })
    .catch(() => {}) // defaults stand
}

let wiring = null
function ensureWired() {
  if (wiring) return
  wiring = (function wire() {
    lastGoodPoll = Date.now() // initial cycle is in flight from the calls below
    loadIntervals()
    reconcile()
    reconcileCompaction()
    reconcileGuard()
    const offs = [
      host.onEvent('message.start', () => {
        set({
          foregroundStartedAt: Date.now(),
          foregroundCompletedAt: null,
          ...(state.mode !== 'running' ? { turnsSince: state.turnsSince + 1 } : {}),
        })
      }),
      host.onEvent('message.complete', () => {
        set({ foregroundCompletedAt: Date.now() })
      }),
      host.onEvent('review.summary', (ev) => {
        const text = (ev && (ev.text || (ev.data && ev.data.text))) || ''
        const m = /result=(\w+)/.exec(text)
        // Live completion: the richest record (carries the summary text). Persist it —
        // the log path in reconcile() keeps it on ties and never overwrites a newer one.
        const rec = { v: 1, endedAt: Date.now(), result: m ? m[1] : null, summary: text }
        persistReviewLast(rec)
        set({
          mode: 'idle',
          startedAt: null,
          doneAt: Date.now(),
          doneResult: m ? m[1] : null,
          doneSummary: text,
          turnsSince: 0,
          reviewLastRec: rec,
        })
      }),
    ]
    // Self-rescheduling poll (v0.5.0): a bare setInterval kept ticking even when every
    // cycle died inside a hung log read, which is how the 10-16/17 frozen state happened.
    // This timer only ever schedules the NEXT tick after the current cycle settles (the
    // withTimeout wrappers guarantee it settles), and drops to FAST_RETRY_MS while no
    // reconcile has succeeded within UNHEALTHY_AFTER_MS — so a stalled reader recovers
    // on its own, and recovery re-derives state from the live log.
    let pollTimer = null
    const scheduleNext = (delayMs) => {
      if (!wiring) return // torn down while scheduling
      pollTimer = setTimeout(tick, delayMs)
    }
    const tick = () => {
      if (!wiring) return
      Promise.allSettled([reconcile(), reconcileCompaction(), reconcileGuard()]).then(() => {
        if (!wiring) return
        const overdue = Date.now() - lastGoodPoll > UNHEALTHY_AFTER_MS
        scheduleNext(overdue ? FAST_RETRY_MS : POLL_MS)
      })
    }
    scheduleNext(POLL_MS)
    return () => {
      if (pollTimer) clearTimeout(pollTimer)
      offs.forEach((off) => off && off())
      wiring = null
    }
  })()
}

// Hidden on healthy runs. A visible guard chip means either the bounded
// foreground cleanup recovered a stalled ticker, or ordering regressed and a
// review model started before the terminal foreground event.
function GuardChip() {
  const s = useWatch()
  const now = useNow()
  const overlapRecent = s.reviewOverlapAt != null && now - s.reviewOverlapAt < RECENT_GUARD_MS
  const recoveryRecent = s.tickerRecoveryAt != null && now - s.tickerRecoveryAt < RECENT_GUARD_MS
  if (!overlapRecent && !recoveryRecent) return null

  const overlap = overlapRecent && (!recoveryRecent || s.reviewOverlapAt >= s.tickerRecoveryAt)
  const color = overlap ? 'var(--ui-danger, #dc2626)' : 'var(--ui-warning, #d97706)'
  const label = overlap
    ? `review overlap · ${ago(now - s.reviewOverlapAt)} ago`
    : `reply guard recovered · ${ago(now - s.tickerRecoveryAt)} ago`
  const detail = overlap
    ? 'A background review started before the foreground message.complete boundary. This violates the single-inference-slot ordering contract; inspect agent.log before sending another long turn.'
    : `Foreground delivery continued after a usage ticker failed to stop within its bounded cleanup window${s.tickerRecoverySession ? ` (session ${s.tickerRecoverySession})` : ''}. The completed reply was preserved; inspect the logged ticker stack to diagnose the blocked sampler.`

  return jsx(Tip, {
    label: detail,
    children: jsxs('span', {
      style: {
        display: 'inline-flex', alignItems: 'center', gap: '5px', height: '100%',
        padding: '0 6px', fontSize: '0.6875rem', color, whiteSpace: 'nowrap',
      },
      children: [
        jsx('span', { style: { width: '6px', height: '6px', borderRadius: '50%', background: color, display: 'inline-block' } }),
        jsx('span', { children: label }),
      ],
    }),
  })
}

function useWatch() {
  ensureWired()
  return useSyncExternalStore(
    (cb) => { subs.add(cb); return () => subs.delete(cb) },
    () => state,
    () => state,
  )
}

function useNow(intervalMs = 1000) {
  const [v, setV] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setV(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return v
}

function FillBar({ frac, width = 44 }) {
  const f = Math.max(0, Math.min(1, frac || 0))
  return jsx('span', {
    'aria-hidden': true,
    style: {
      display: 'inline-block',
      width: `${width}px`,
      height: '4px',
      borderRadius: '2px',
      background: 'var(--ui-stroke-secondary)',
      overflow: 'hidden',
      verticalAlign: 'middle',
    },
    children: jsx('span', {
      style: {
        display: 'block',
        height: '100%',
        width: `${(f * 100).toFixed(1)}%`,
        background: 'var(--ui-accent)',
        borderRadius: '2px',
        transition: 'width 400ms ease',
      },
    }),
  })
}

function Chip() {
  const s = useWatch()
  const now = useNow()

  const memLeft = Math.max(0, s.memInterval - s.turnsSince)
  const barFrac = s.turnsSince / s.memInterval

  // Render-time stale cap (v0.5.0): the twin of CompactionChip's backstop — the chip
  // re-renders every second via useNow, so even if reconcile's state is frozen at
  // 'running' (poll loop dead or log reader stuck), an over-ceiling start self-corrects
  // HERE without waiting for a poll. Before v0.5.0 this chip had the poll-side
  // classification only and could display "review running" unbounded.
  const mode = reviewStale(s.mode, s.startedAt, now, s.staleReviewMs) ? 'stale' : s.mode

  let dotColor = 'var(--ui-text-quaternary)'
  let textColor = 'var(--ui-text-tertiary)'
  let label
  let detail

  const rec = s.reviewLastRec
  if (mode === 'running') {
    dotColor = 'var(--ui-accent)'
    textColor = 'var(--ui-accent)'
    label = `review running · ${ago(now - s.startedAt)}`
    detail = 'Background self-improvement review is in progress. It replays the recent conversation on the local model and may update memory/skills. The bar shows the nudge countdown for the next run.'
  } else if (mode === 'stale') {
    dotColor = 'var(--ui-warning, #d97706)'
    textColor = dotColor
    label = `review stale · ${ago(now - s.startedAt)}`
    detail = `A background review spawned but never logged a completion line, and its start marker is now over the ${Math.round(s.staleReviewMs / 60000)}-min ceiling. The gateway process most likely rebooted or was killed mid-review, so no inference is actually running and the local-model slot is free. It self-clears when the next review completes. If you expected one to finish, check agent.log around the start time.`
  } else if (s.doneAt != null && now - s.doneAt < RECENT_DONE_MS) {
    label = `review done ${ago(now - s.doneAt)} ago`
    const summary = s.doneSummary || (rec && rec.summary) || ''
    detail = (summary || `Last background review finished (result: ${s.doneResult || 'none'}).`) +
      `\nNext nudge in ${memLeft} turns — memory ${s.turnsSince}/${s.memInterval}, skill ${s.turnsSince}/${s.skillInterval}`
  } else {
    label = 'review idle'
    detail = `No background review running. Next nudge in ${memLeft} turns — memory ${s.turnsSince}/${s.memInterval}, skill ${s.turnsSince}/${s.skillInterval}` +
      (rec ? `\nLast background review finished ${ago(now - rec.endedAt)} ago (result: ${rec.result || 'none'})` +
        (rec.summary ? ` — ${trimSummary(rec.summary)}` : '') : '')
  }

  return jsxs(Tip, {
    label: detail,
    children: jsxs('span', {
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        height: '100%',
        padding: '0 6px',
        fontSize: '0.6875rem',
        color: textColor,
        whiteSpace: 'nowrap',
      },
      children: [
        jsx('span', {
          style: {
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: dotColor,
            display: 'inline-block',
            animation: mode === 'running' ? 'bgrw-pulse 1.2s ease-in-out infinite' : 'none',
          },
        }),
        jsx('span', { children: label }),
        // Bar shows on idle AND stale — only a live review suppresses the countdown.
        mode !== 'running' ? jsxs('span', {
          style: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
          children: [
            jsx(FillBar, { frac: barFrac }),
            jsx('span', { style: { color: 'var(--ui-text-quaternary)' }, children: `${memLeft}t` }),
          ],
        }) : null,
      ],
    }),
  })
}

// Compaction chip: always rendered. Running or within RECENT_COMP_MS of a finish it shows
// the live/recent label; otherwise a quiet idle line with the LAST completion (persisted),
// so "when did we last compact" is always one glance away.
function CompactionChip() {
  const s = useWatch()
  const now = useNow()
  const c = s.compact

  const recentEnd = c.endedAt != null && now - c.endedAt < RECENT_COMP_MS

  // Render-time stale cap (v0.4.1): the chip re-renders every second via useNow, so
  // even if reconcileCompaction's state is frozen at 'running' (poll loop dead or log
  // reader stuck — incident 10-15: "compacting · 3h+" with the terminal line already
  // on disk), an over-age start self-corrects HERE without waiting for a poll.
  // v0.5.0: the ceiling is the user-configurable one (Settings ▸ Thresholds).
  const mode = compactStale(c.mode, c.startedAt, now, s.staleCompactMs) ? 'stale' : c.mode

  let dotColor = 'var(--ui-accent)'
  let label
  let detail

  if (mode === 'stale') {
    dotColor = 'var(--ui-warning, #d97706)'
    label = `compact stale · ${ago(now - c.startedAt)}`
    detail = `A compaction start marker is ${ago(now - c.startedAt)} old — over the ${Math.round(s.staleCompactMs / 60000)}-min orphan ceiling — with no terminal (done/telemetry) line after it. A healthy batch run on this box takes ~4–8 min, so either a run died without logging (process/gateway fault) or the log reader froze (the poll self-recovers since v0.5.0). ` +
      'If you did not see compaction happen, treat the badge as a false alarm — verify with agent.log "context compression".'
  } else if (mode === 'running') {
    label = `compacting · ${ago(now - c.startedAt)}`
    detail = `Batch context compaction in progress — the local model is summarizing the session middle (started at ~${fmtTokens(c.startTokens)} tokens).\n` +
      'First measured run (197K-token session) committed in ~4 min. The single inference slot is busy until it commits, so queued messages will wait.\n' +
      'Nothing is lost: a checkpoint is archived first, and the transcript stays searchable via session_search.'
  } else if (!recentEnd) {
    // Quiet idle. The last terminal state comes from the persisted record (survives window
    // rotation / hot reloads); absent only before this install's first completion.
    dotColor = 'var(--ui-text-quaternary)'
    const last = c.lastRec
    label = last ? `compact idle · last ${ago(now - last.endedAt)}` : 'compact idle'
    detail = last
      ? (last.committed === false
        ? `Last batch compaction was aborted (${last.failure || 'unknown failure'}) — the session was left unchanged and it retries on the next trigger.`
        : (last.doneFrom != null
          ? `Last compaction committed: ${last.doneFrom} → ${last.doneTo} messages.`
          : 'Last compaction committed.'))
      : 'No batch context compression has completed since this plugin started keeping records. The chip goes live the moment one starts.'
  } else if (c.committed === false) {
    dotColor = 'var(--ui-warning, #d97706)'
    label = `compact failed ${ago(now - c.endedAt)} ago`
    detail = `Compaction was aborted (${c.failure || 'unknown failure'}) — the session was left unchanged and will retry on the next compaction trigger.`
  } else {
    dotColor = 'var(--ui-text-secondary)'
    label = `compact done ${ago(now - c.endedAt)} ago`
    detail = (c.doneFrom != null
      ? `Compaction committed: ${c.doneFrom} → ${c.doneTo} messages.`
      : 'Compaction committed.')
  }
  if (c.lastMicroAt != null && c.microDetail) {
    detail += `\nLast micro-compact pass: ${ago(now - c.lastMicroAt)} ago (${c.microDetail})`
  }

  return jsxs(Tip, {
    label: detail,
    children: jsxs('span', {
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        height: '100%',
        padding: '0 6px',
        fontSize: '0.6875rem',
        color: dotColor,
        whiteSpace: 'nowrap',
      },
      children: [
        jsx('span', {
          style: {
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: dotColor,
            display: 'inline-block',
            animation: mode === 'running' ? 'bgrw-pulse 1.2s ease-in-out infinite' : 'none',
          },
        }),
        jsx('span', { children: label }),
      ],
    }),
  })
}

// Settings ▸ Plugins ▸ Thresholds — the two orphan ceilings, in minutes. Theme vars only;
// values commit on blur (mid-typing is not persisted) and are sanitized by sanitizeSettings.
const INPUT_STYLE = {
  width: '96px', padding: '4px 8px', fontSize: '0.75rem',
  color: 'var(--foreground)', background: 'transparent',
  border: '1px solid var(--border)', borderRadius: '6px',
}
const BUTTON_STYLE = {
  padding: '4px 12px', fontSize: '0.75rem', cursor: 'pointer',
  color: 'var(--foreground)', background: 'transparent',
  border: '1px solid var(--border)', borderRadius: '6px',
}

function minOf(ms) {
  return Math.round(ms / 60000)
}

function ThresholdsPage() {
  const s = useWatch()
  const current = () => ({ reviewStaleMin: minOf(s.staleReviewMs), compactStaleMin: minOf(s.staleCompactMs) })
  const commit = (key) => (e) => { applySettings({ ...current(), [key]: e.target.valueAsNumber }) }
  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column' },
    children: [
      jsx(ListRow, {
        title: 'Review stale ceiling (minutes)',
        description: `Minutes before a background review without a completion line reports "review stale" instead of "review running". Default ${DEFAULT_REVIEW_STALE_MIN} — measured healthy local-model runs here take 22–26 min. Raise it only if you see false "stale" on unusually long runs.`,
        action: jsx('input', {
          key: `rev-${s.staleReviewMs}`,
          type: 'number', min: MIN_STALE_MIN, max: MAX_STALE_MIN, step: 5,
          defaultValue: minOf(s.staleReviewMs), style: INPUT_STYLE, onBlur: commit('reviewStaleMin'),
        }),
      }),
      jsx(ListRow, {
        title: 'Compaction stale ceiling (minutes)',
        description: `Minutes before a compaction start without a terminal line reports "compact stale" instead of "compacting". Default ${DEFAULT_COMPACT_STALE_MIN} — measured healthy batch runs here take ~4–8 min.`,
        action: jsx('input', {
          key: `cmp-${s.staleCompactMs}`,
          type: 'number', min: MIN_STALE_MIN, max: MAX_STALE_MIN, step: 5,
          defaultValue: minOf(s.staleCompactMs), style: INPUT_STYLE, onBlur: commit('compactStaleMin'),
        }),
      }),
      jsx(ListRow, {
        title: 'Restore defaults',
        description: `Review ${DEFAULT_REVIEW_STALE_MIN} min · compaction ${DEFAULT_COMPACT_STALE_MIN} min.`,
        action: jsx('button', {
          type: 'button', style: BUTTON_STYLE, children: 'Reset',
          onClick: () => applySettings(current()),
        }),
      }),
    ],
  })
}

// Test-only exports (smoke test drives the render-side caps, sanitization and timeout
// without module internals).
export { compactStale as __compactStaleForTests }
export { reviewStale as __reviewStaleForTests }
export { sanitizeSettings as __sanitizeSettingsForTests }
export { withTimeout as __withTimeoutForTests }
export { reconcileCompaction as __reconcileCompactionForTests }
export { reconcile as __reconcileForTests }

export default {
  id: 'background-review-watch',
  name: 'Background Review & Completion Watch',
  defaultEnabled: true,
  register(ctx) {
    engineCtx = ctx
    ensureWired()
    hydrateSettings() // async; thresholds apply on resolve (defaults stand until then)
    hydrateLastCompact() // async; resolves into state.compact.lastRec before the chip needs it
    hydrateReviewLast() // async; resolves into state.reviewLastRec for the idle/done tooltips
    const wiringTeardown = wiring // module-scoped; survives chip remounts
    ctx.register({
      id: 'chip',
      area: STATUSBAR_AREAS.right,
      order: 140,
      render: () => jsx(Chip, {}),
    })
    ctx.register({
      id: 'chip-compact',
      area: STATUSBAR_AREAS.right,
      order: 141,
      render: () => jsx(CompactionChip, {}),
    })
    ctx.register({
      id: 'chip-guard',
      area: STATUSBAR_AREAS.right,
      order: 142,
      render: () => jsx(GuardChip, {}),
    })
    // Optional seam: hosts without registerSettingsPage (older builds) skip the page —
    // the chips still work with the built-in defaults.
    if (typeof ctx.registerSettingsPage === 'function') {
      ctx.registerSettingsPage({
        id: 'thresholds',
        title: 'Thresholds',
        icon: 'watch',
        order: 10,
        render: () => jsx(ThresholdsPage, {}),
      })
    }
    // pulse keyframe (cosmetic; scoped to this plugin's lifetime)
    let styleEl = null
    try {
      styleEl = document.createElement('style')
      styleEl.textContent = '@keyframes bgrw-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }'
      document.head.appendChild(styleEl)
    } catch {
      /* no DOM — skip */
    }
    ctx.onDispose(() => {
      if (wiringTeardown) wiringTeardown()
      if (styleEl && styleEl.remove) styleEl.remove()
    })
  },
}
