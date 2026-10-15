// bg-review-watch — status chip + nudge countdown for Hermes background self-improvement runs,
// plus compaction and foreground-completion guards for local-model workloads.
//
// Disk plugin (loaded uncompiled): only @hermes/plugin-sdk / react / react/jsx-runtime resolve.
//
// What it shows (status bar, right cluster):
//   review chip (always):
//     idle    → "review idle"   + fill bar: turns since last review / nudge interval
//     running → "review running · 2m 14s" (pulsing dot, accent color)
//     just done → "review done 3s ago" + the summary text in the tooltip
//     stale   → "review stale · 16h 10m (no end line)" (warning dot) — a spawn marker
//               with no terminal line older than STALE_REVIEW_MS. The review process died
//               without logging (gateway reboot/kill/OOM); nothing is running, slot is free.
//   compaction chip (always):
//     running → "compacting · 4m 12s" (pulsing dot, accent color)
//     just done → "compact done 3m ago" / "compact failed 2m ago" (reduction or failure in tooltip)
//     idle    → "compact idle · last 5d 2h" + the last committed reduction or failure class
//               in the tooltip. The last terminal state is persisted via ctx.storage so it
//               survives log-window rotation, hot reloads, and app restarts.
//
// Data sources (all read-only, no Python backend, no gateway restart):
//   - host.onEvent('review.summary')        → live review completion + summary text
//   - host.onEvent('message.start')         → turn ticks for the review countdown
//   - host.onEvent('message.complete')      → foreground delivery boundary
//   - host.logs({ file:'agent', search:… }) → markers, 20s poll:
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
// no terminal line ever; chip pinned "running" for 16h+). A spawn older than STALE_REVIEW_MS
// with no terminal line is therefore reported as `stale` (diagnostic), not `running`.
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

import { host, STATUSBAR_AREAS, Tip } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useSyncExternalStore, useState, useEffect } from 'react'

const POLL_MS = 20000 // log poll cadence (idle cost is a few tiny server-side-filtered REST calls)
const RECENT_DONE_MS = 600000 // keep the "done Xs ago" label for 10 min, then plain idle
const RECENT_COMP_MS = 600000 // keep the compaction chip 10 min after a finish
const RECENT_GUARD_MS = 600000 // keep completion-boundary diagnostics visible for 10 min
// Orphan-spawn ceiling. Verified local-model review runs on this box: 22 min and
// 26 min (agent.log, 10-14 pairs); 4h leaves wide headroom over anything healthy.
// Above it, "running" can only mean the process died without logging — report stale, not running.
const STALE_REVIEW_MS = 4 * 60 * 60 * 1000
// Orphan ceiling for COMPACTION. Measured runs on this box: ~5 min (10-14 18:34)
// and ~8 min (10-15 19:32, ~200K tokens). A start marker older than 60 min with no
// terminal line can only mean a run that died without logging (process/gateway
// fault) — report stale, never "running". The chip ALSO caps at render time, so
// even a frozen poll state cannot display an unbounded "compacting" (incident
// 10-15: chip pinned "compacting · 3h+" although the terminal line had been on
// disk for hours — poll-side classification alone could not surface it).
const STALE_COMP_MS = 60 * 60 * 1000
// Single source of truth for "this compaction state is over its orphan budget".
// Used by reconcileCompaction (poll side) AND CompactionChip (render side — the
// backstop that works even when poll state is frozen).
function compactStale(mode, startedAt, now) {
  return mode === 'running' && startedAt != null && now - startedAt > STALE_COMP_MS
}
const COMPACT_LAST_KEY = 'bg-review-watch.compact-last.v1' // ctx.storage key for the last terminal compaction

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
    const rev = await host.logs({ file: 'agent', lines: 200, search: 'bg-review' })
    const lines = (rev && (rev.lines || rev.data || rev.logs)) || []
    const { start, done, result } = collectReviewMarkers(lines)

    // turns since the last completion (only needed when idle)
    let turns = state.turnsSince
    if (done != null) {
      const tr = await host.logs({ file: 'agent', lines: 5000, search: 'Turn ended' })
      const tlines = ((tr && (tr.lines || tr.data || tr.logs)) || []).map(lineText)
      turns = tlines.filter((t) => {
        const m = RE_TURN.exec(t)
        return m && ts(m[1]) > done
      }).length
    }

    // `live` = the log evidence says a review is in flight; `stale` = that claim is old
    // enough that only process death explains it (no terminal line survives a reboot/kill).
    const live = start != null && (done == null || start > done)
    const stale = live && now - start > STALE_REVIEW_MS
    const overlap = start != null && state.foregroundStartedAt != null &&
      start >= state.foregroundStartedAt &&
      (state.foregroundCompletedAt == null || start < state.foregroundCompletedAt)
    set({
      mode: stale ? 'stale' : live ? 'running' : 'idle',
      startedAt: live ? (state.startedAt || start) : null,
      doneAt: done,
      doneResult: done != null && result != null ? result : state.doneResult,
      // Only a genuinely running review holds the slot; stale/idle report the real countdown.
      turnsSince: live && !stale ? 0 : turns,
      reviewOverlapAt: overlap ? start : state.reviewOverlapAt,
    })
  } catch {
    /* fail-open: keep last state on a REST blip */
  }
}

async function reconcileGuard() {
  const now = Date.now()
  if (now - state.guardLastPoll < 5000) return
  state.guardLastPoll = now
  try {
    const result = await host.logs({ file: 'agent', lines: 100, search: 'usage ticker stop timed out' })
    const lines = (result && (result.lines || result.data || result.logs)) || []
    let at = null
    let session = null
    for (const text of lines.map(lineText)) {
      const m = RE_TICKER_TIMEOUT.exec(text)
      const t = m ? ts(m[1]) : null
      if (t && (at == null || t > at)) { at = t; session = m[2] }
    }
    set({ tickerRecoveryAt: at, tickerRecoverySession: session })
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
    const c = await host.logs({ file: 'agent', lines: 3000, search: 'context compression' })
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

    const mc = await host.logs({ file: 'agent', lines: 500, search: 'Micro-compaction' })
    const mlines = (mc && (mc.lines || mc.data || mc.logs)) || []
    const micro = collectMicroMarkers(mlines)

    // Poll-side stale classification (the render-time cap in CompactionChip is the
    // backstop for frozen state — see STALE_COMP_MS).
    const compStale = running && compactStale('running', state.compact.startedAt || start, now)

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
  } catch {
    /* fail-open: keep last state on a REST blip */
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
        set({
          mode: 'idle',
          startedAt: null,
          doneAt: Date.now(),
          doneResult: m ? m[1] : null,
          doneSummary: text,
          turnsSince: 0,
        })
      }),
    ]
    const poll = setInterval(() => { reconcile(); reconcileCompaction(); reconcileGuard() }, POLL_MS)
    return () => {
      clearInterval(poll)
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

  let dotColor = 'var(--ui-text-quaternary)'
  let textColor = 'var(--ui-text-tertiary)'
  let label
  let detail

  if (s.mode === 'running') {
    dotColor = 'var(--ui-accent)'
    textColor = 'var(--ui-accent)'
    label = `review running · ${ago(now - s.startedAt)}`
    detail = 'Background self-improvement review is in progress. It replays the recent conversation on the local model and may update memory/skills. The bar shows the nudge countdown for the next run.'
  } else if (s.mode === 'stale') {
    dotColor = 'var(--ui-warning, #d97706)'
    textColor = dotColor
    label = `review stale · ${ago(now - s.startedAt)}`
    detail = 'A background review spawned but never logged a completion line — the gateway process most likely rebooted or was killed mid-review, so no inference is actually running and the local-model slot is free. It self-clears when the next review completes. If you expected one to finish, check agent.log around the start time.'
  } else if (s.doneAt != null && now - s.doneAt < RECENT_DONE_MS) {
    label = `review done ${ago(now - s.doneAt)} ago`
    detail = (s.doneSummary || `Last background review finished (result: ${s.doneResult || 'none'}).`) +
      `\nNext nudge in ${memLeft} turns — memory ${s.turnsSince}/${s.memInterval}, skill ${s.turnsSince}/${s.skillInterval}`
  } else {
    label = 'review idle'
    detail = `No background review running. Next nudge in ${memLeft} turns — memory ${s.turnsSince}/${s.memInterval}, skill ${s.turnsSince}/${s.skillInterval}`
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
            animation: s.mode === 'running' ? 'bgrw-pulse 1.2s ease-in-out infinite' : 'none',
          },
        }),
        jsx('span', { children: label }),
        // Bar shows on idle AND stale — only a live review suppresses the countdown.
        s.mode !== 'running' ? jsxs('span', {
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
  const mode = compactStale(c.mode, c.startedAt, now) ? 'stale' : c.mode

  let dotColor = 'var(--ui-accent)'
  let label
  let detail

  if (mode === 'stale') {
    dotColor = 'var(--ui-warning, #d97706)'
    label = `compact stale · ${ago(now - c.startedAt)}`
    detail = `A compaction start marker is ${ago(now - c.startedAt)} old with no terminal (done/telemetry) line after it. A healthy batch run on this box takes ~4–8 min, so either a run died without logging (process/gateway fault) or the log reader froze.\n` +
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

// Test-only exports (smoke test drives the render-side cap without module internals).
export { compactStale as __compactStaleForTests }
export { reconcileCompaction as __reconcileCompactionForTests }

export default {
  id: 'bg-review-watch',
  name: 'Background Review & Completion Watch',
  defaultEnabled: true,
  register(ctx) {
    engineCtx = ctx
    ensureWired()
    hydrateLastCompact() // async; resolves into state.compact.lastRec before the chip needs it
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
