import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('./plugin.js', import.meta.url), 'utf8')
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
let compLines = [COMP_DONE_LINE, COMP_TEL_LINE]

const eventHandlers = new Map()
const host = {
  logs: async ({ search }) => ({
    lines:
      search === 'bg-review' ? [SPAWN_LINE]
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

const pluginModule = new vm.SourceTextModule(source, { identifier: 'bg-review-watch/plugin.js' })
await pluginModule.link(specifier => {
  const linked = modules.get(specifier)
  assert.ok(linked, `unexpected import: ${specifier}`)
  return linked
})
await pluginModule.evaluate()

const plugin = pluginModule.namespace.default
assert.equal(plugin.id, 'bg-review-watch')
assert.equal(plugin.defaultEnabled, true)
// test-only named exports live on the namespace, not the default object
const texp = pluginModule.namespace
assert.equal(typeof texp.__compactStaleForTests, 'function', '__compactStaleForTests exported')
assert.equal(typeof texp.__reconcileCompactionForTests, 'function', '__reconcileCompactionForTests exported')

// ctx without storage (engine must guard — mirrors the sandbox when storage is absent).
const contributions = []
let dispose = () => {}
plugin.register({
  register: contribution => contributions.push(contribution),
  onDispose: callback => { dispose = callback },
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

// 1. orphaned spawn older than STALE_REVIEW_MS → "review stale", NOT "review running"
let text = renderedText(chip)
assert.ok(text.includes('review stale'), `expected stale label, got: ${text}`)
assert.ok(!text.includes('review running'), `stale chip must not claim the slot: ${text}`)

// 2. a review.summary event clears the stale state → "review done"
eventHandlers.get('review.summary')({ text: 'Background review complete result=none' })
await new Promise(resolve => setTimeout(resolve, 20))
text = renderedText(chip)
assert.ok(text.includes('review done'), `expected review done after summary event, got: ${text}`)

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

dispose()
assert.equal(eventHandlers.size, 0)
console.log(`bg-review-watch v${version} smoke test passed`)
