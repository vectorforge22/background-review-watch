import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('./desktop/plugin.js', import.meta.url), 'utf8')
const version = readFileSync(new URL('./VERSION', import.meta.url), 'utf8').trim()
assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'VERSION must be valid SemVer')

// ── synthetic agent.log ────────────────────────────────────────────────────
// One orphaned bg-review spawn 5h ago (no terminal line) → chip must say STALE.
// One completed compaction 3d ago → chip must say "compact idle · last 3d …".
const HOUR = 3600 * 1000
const DAY = 24 * HOUR
const pad = (n, w = 2) => String(n).padStart(w, '0')
const logTs = msOffsetAgo => {
  const d = new Date(Date.now() - msOffsetAgo)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())},042`
}
const SPAWN_LINE = `${logTs(5 * HOUR)} INFO run_agent: OpenAI client created (agent_init, shared=True) thread=bg-review:33108 provider=custom base_url=http://127.0.0.1:8080/v1 model=Qwen38-27b-q8`
const COMP_DONE_LINE = `${logTs(3 * DAY)} INFO agent.conversation_compression: context compression done: session=test_sess messages=120->45 rough_tokens=~55000 awaiting_real_usage=true`
const COMP_TEL_LINE = `${logTs(3 * DAY + 500)} INFO agent.conversation_compression: context compression attempt telemetry: {"commit_status":"committed","failure_class":null,"total_duration_ms":241000}`
// v0.4.1 case: orphaned compaction start 2h ago, no terminal line → STALE, not running.
const COMP_START_ORPHAN = `${logTs(2 * HOUR)} INFO agent.conversation_compression: context compression started: session=test_sess messages=210 tokens=~199,555 model=Qwen38-27b-q8 focus=None`
let reviewLines = [SPAWN_LINE] // mutable — later steps clear it to drive the idle path
let compLines = [COMP_DONE_LINE, COMP_TEL_LINE]

// fake ctx.storage: an in-memory map standing in for window.localStorage
const store = {}
const storage = {
  get: async (k) => (k in store ? store[k] : null),
  set: (k, v) => { store[k] = v; return Promise.resolve() },
}

const eventHandlers = new Map()
const host = {
  logs: async ({ search }) => ({
    lines:
      search === 'bg-review' ? reviewLines
      : search === 'context compression' ? compLines
      : [] // 'Turn ended', 'Micro-compaction', ticker — quiet
  }),
  onEvent(type, handler) {
    eventHandlers.set(type, handler)
    return () => eventHandlers.delete(type)
  },
  request: async () => ({}),
}

function synthetic(exports) {
  const names = Object.keys(exports)
  return new vm.SyntheticModule(names, function initialize() {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value)
  })
}

const modules = new Map([
  ['@hermes/plugin-sdk', synthetic({
    host,
    STATUSBAR_AREAS: { right: 'statusBar.right' },
    Tip: function Tip(props) { return { type: 'Tip', props } }, // pass-through so labels/children stay walkable
    ListRow: function ListRow(props) { return { type: 'ListRow', props } }, // v0.5.0 settings rows — pass-through too
  })],
  ['react/jsx-runtime', synthetic({
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
  })],
  ['react', synthetic({
    useEffect: () => {},
    useState: initial => [initial, () => {}],
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  })],
])

const pluginModule = new vm.SourceTextModule(source, { identifier: 'background-review-watch/desktop/plugin.js' })
await pluginModule.link(specifier => {
  const linked = modules.get(specifier)
  assert.ok(linked, `unexpected import: ${specifier}`)
  return linked
})
await pluginModule.evaluate()

const plugin = pluginModule.namespace.default
assert.equal(plugin.id, 'background-review-watch')
assert.equal(plugin.defaultEnabled, true)
// test-only named exports live on the namespace, not the default object
const texp = pluginModule.namespace
assert.equal(typeof texp.__compactStaleForTests, 'function', '__compactStaleForTests exported')
assert.equal(typeof texp.__reviewStaleForTests, 'function', '__reviewStaleForTests exported (v0.5.0)')
assert.equal(typeof texp.__sanitizeSettingsForTests, 'function', '__sanitizeSettingsForTests exported (v0.5.0)')
assert.equal(typeof texp.__withTimeoutForTests, 'function', '__withTimeoutForTests exported (v0.5.0)')
assert.equal(typeof texp.__reconcileCompactionForTests, 'function', '__reconcileCompactionForTests exported')
assert.equal(typeof texp.__reconcileForTests, 'function', '__reconcileForTests exported (v0.5.0)')

const contributions = []
let dispose = () => {}
plugin.register({
  register: contribution => contributions.push(contribution),
  onDispose: callback => { dispose = callback },
  storage,
})

assert.deepEqual(contributions.map(item => item.id), ['chip', 'chip-compact', 'chip-guard'])
assert.ok(eventHandlers.has('message.start'))
assert.ok(eventHandlers.has('message.complete'))
assert.ok(eventHandlers.has('review.summary'))

// let the initial reconcile() / reconcileCompaction() promises settle
await new Promise(resolve => setTimeout(resolve, 100))

// walk a fake-jsx tree and collect every string child — labels + tooltips land here
function collectText(node, out = []) {
  if (node == null || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { node.forEach(child => collectText(child, out)); return out }
  if (node.props) {
    for (const value of Object.values(node.props)) collectText(value, out)
  }
  return out
}

// The contribution's render() returns a JSX element {type, props}; the fake runtime
// never invokes it, so call the one function level ourselves (Chip/CompactionChip/GuardChip).
function renderedText(item) {
  const el = item.render()
  let node = el
  while (node && typeof node.type === 'function') node = node.type(node.props)
  return collectText(node).join(' | ')
}

const chip = contributions.find(item => item.id === 'chip')
const compactChip = contributions.find(item => item.id === 'chip-compact')

// 1. orphaned spawn older than the review-stale ceiling → "review stale", NOT "review running"
let text = renderedText(chip)
assert.ok(text.includes('review stale'), `expected stale label, got: ${text}`)
assert.ok(!text.includes('review running'), `stale chip must not claim the slot: ${text}`)

// 2. a review.summary event clears the stale state → "review done" — AND (v0.5.0) persists
//    the last-review record with its summary text.
eventHandlers.get('review.summary')({ text: 'Background review complete result=none' })
await new Promise(resolve => setTimeout(resolve, 20))
text = renderedText(chip)
assert.ok(text.includes('review done'), `expected review done after summary event, got: ${text}`)
const revRec = store['background-review-watch.review-last.v1']
assert.ok(revRec && revRec.v === 1, 'review-last record persisted on the live event path')
assert.equal(revRec.result, 'none', 'persisted result parsed from the summary text')
assert.ok(String(revRec.summary).includes('Background review complete'), 'persisted summary carries the text')

// 3. compaction chip is ALWAYS rendered (no null branch) and shows the last completion age
const compactText = renderedText(compactChip)
assert.ok(compactText.includes('compact idle · last 3d'), `expected persisted last-compaction label, got: ${compactText}`)

// 4. v0.4.1 poll side: orphaned compaction start (2h, no terminal line) → "compact stale",
//    NOT "compacting". (Sleep clears the 5s reconcile debounce; then drive one poll.)
compLines = [COMP_START_ORPHAN]
await new Promise(resolve => setTimeout(resolve, 5300))
await texp.__reconcileCompactionForTests()
text = renderedText(compactChip)
assert.ok(text.includes('compact stale'), `expected stale compaction label, got: ${text}`)
assert.ok(!text.includes('compacting ·'), `stale compaction must not claim the slot: ${text}`)
assert.ok(text.includes('false alarm'), `stale tooltip should name the false-alarm path: ${text}`)

// 5. v0.4.1 render side: the shared cap fires on an over-age 'running' state even when
//    the poll never ran (frozen state — the 10-15 failure mode).
const cs = texp.__compactStaleForTests
const nowMs = Date.now()
assert.equal(cs('running', nowMs - 61 * 60 * 1000, nowMs), true, 'over-budget running → stale')
assert.equal(cs('running', nowMs - 59 * 60 * 1000, nowMs), false, 'under-budget running stays running')
assert.equal(cs('idle', nowMs - 3 * HOUR, nowMs), false, 'idle is never stale')
assert.equal(cs('stale', nowMs - 3 * HOUR, nowMs), false, 'stale input is idempotent')
assert.equal(cs('running', null, nowMs), false, 'no start marker → not stale')
// v0.5.0: the ceiling is a parameter (Settings page) — same function, custom budget.
assert.equal(cs('running', nowMs - 61 * 60 * 1000, nowMs, 120 * 60 * 1000), false, 'custom ceiling widens the budget')
assert.equal(cs('running', nowMs - 121 * 60 * 1000, nowMs, 120 * 60 * 1000), true, 'custom ceiling still caps over-age')

// 6. v0.5.0 render side, review chip: the twin cap (frozen "review running" — the failure
//    class of the 10-14 16h incident that the compaction cap got first in 0.4.1).
const rs = texp.__reviewStaleForTests
assert.equal(rs('running', nowMs - 241 * 60 * 1000, nowMs), true, 'review over default ceiling → stale')
assert.equal(rs('running', nowMs - 239 * 60 * 1000, nowMs), false, 'review under default ceiling stays running')
assert.equal(rs('idle', nowMs - 10 * HOUR, nowMs), false, 'idle is never stale')
assert.equal(rs('running', null, nowMs), false, 'no start marker → not stale')
assert.equal(rs('running', nowMs - 5 * HOUR, nowMs, 4 * HOUR), true, 'custom (smaller) ceiling caps sooner')

// 7. v0.5.0 settings sanitization: defaults win on junk, values clamp to [1, 7d] minutes.
const ss = texp.__sanitizeSettingsForTests
assert.deepEqual(ss({}), { v: 1, reviewStaleMin: 240, compactStaleMin: 60 }, 'no input → defaults')
assert.deepEqual(ss({ reviewStaleMin: 'junk' }), { v: 1, reviewStaleMin: 240, compactStaleMin: 60 }, 'junk → default')
assert.equal(ss({ reviewStaleMin: 999999 }).reviewStaleMin, 7 * 24 * 60, 'above max → clamped to one week')
assert.equal(ss({ compactStaleMin: -5 }).compactStaleMin, 60, 'negative → default')
assert.equal(ss({ reviewStaleMin: 30.7 }).reviewStaleMin, 30, 'fractional minutes floored')
assert.deepEqual(ss({ reviewStaleMin: 90, compactStaleMin: 30 }), { v: 1, reviewStaleMin: 90, compactStaleMin: 30 }, 'clean values pass through')

// 8. v0.5.0 log-read timeout: a hung reader rejects instead of wedging the poll cycle.
const wt = texp.__withTimeoutForTests
await assert.rejects(wt(new Promise(() => {}), 50, 'test read'), /timed out/, 'hung read times out')
assert.equal(await wt(Promise.resolve('ok'), 100, 'test read'), 'ok', 'fast read passes through')

// 9. v0.5.0 settings page: registered via ctx.registerSettingsPage and renders the three rows.
const contributions2 = []
const settingsPages = []
plugin.register({
  register: contribution => contributions2.push(contribution),
  onDispose: () => {},
  storage,
  registerSettingsPage: page => { settingsPages.push(page) },
})
assert.equal(settingsPages.length, 1, 'exactly one settings page registered')
assert.equal(settingsPages[0].id, 'thresholds')
let pageNode = settingsPages[0].render()
while (pageNode && typeof pageNode.type === 'function') pageNode = pageNode.type(pageNode.props)
const pageText = collectText(pageNode).join(' | ')
assert.ok(pageText.includes('Review stale ceiling'), `settings page renders the review row: ${pageText}`)
assert.ok(pageText.includes('Compaction stale ceiling'), `settings page renders the compaction row: ${pageText}`)
assert.ok(pageText.includes('Restore defaults'), `settings page renders the reset row: ${pageText}`)

// 10. v0.5.0 persisted last review reaches the idle tooltip after a clean poll (the log
//     path sees no markers → idle, and the persisted record from step 2 must show through).
reviewLines = []
await new Promise(resolve => setTimeout(resolve, 5300))
await texp.__reconcileForTests()
text = renderedText(chip)
assert.ok(text.includes('review idle'), `expected plain idle after clean poll, got: ${text}`)
assert.ok(text.includes('Last background review finished'), `idle tooltip carries the persisted last review: ${text}`)

dispose()
assert.equal(eventHandlers.size, 0)
console.log(`background-review-watch v${version} smoke test passed`)
