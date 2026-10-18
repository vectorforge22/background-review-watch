# PR description draft (INITIAL) — NousResearch/hermes-agent: plugin-catalog/bg-review-watch.yaml

> Draft, 2026-10-19. Paste everything below the line into the PR body.
> Entry file: `plugin-catalog/bg-review-watch.yaml` (mirror kept in this repo at
> `docs/catalog-submission/bg-review-watch.yaml`).
> **Owner submission**: the PR author (vectorforge22) owns the plugin repo.
> Pin: `e673f95acf46a5c7026cba484accd4c7d6e9a79c` — vectorforge22/bg-review-watch
> `unreleased` (v0.5.0). `hermes plugins validate` passes at that commit
> (manifest OK, loadable `desktop/plugin.js`, **security scan safe**, no core
> override, desktop surface inside the plugin SDK).

---

**Plugin:** Background Review & Completion Watch — **new entry**, v0.5.0
(owner-submitted).

## What does this PR do?

Adds the catalog entry for a renderer-only desktop plugin that makes two
otherwise-invisible daemons visible: Hermes's **background self-improvement
review** and **batch context compaction**. On a local-model setup both are
silent — the review replays the conversation on the main model for 20–30 min
(perf: up to hours), holding the single inference slot, and the only gateway
event is the completion summary, which can arrive long after it started. The
plugin adds three status-bar chips:

- **Review chip** — `review running · 2m 14s` (live elapsed), `review done 3s
  ago` (tooltip carries the model's summary), `review idle` with a turn-countdown
  fill bar to the next nudge, and `review stale · <age>` for an orphaned spawn
  marker (gateway died mid-review; the slot is free).
- **Compaction chip** — always visible: `compacting · 4m 12s`, then
  `compact done/failed` with the committed reduction (`168 → 77 messages`) or
  failure class in the tooltip; `compact stale · <age>` for a start marker over
  the ceiling with no terminal line. The last run is persisted, so the chip
  survives log rotation and restarts.
- **Guard chip** — `reply guard recovered` (bounded usage-ticker cleanup fired)
  and `review overlap` (ordering violation: review started before foreground
  completion). Diagnostics only; hidden on healthy runs.

v0.5.0 (the pinned version) adds a Settings page that tunes both orphan
ceilings (defaults 240 min / 60 min, applied live), an 8 s timeout + self-
rescheduling poll loop so a stalled log reader can no longer wedge state, a
render-time stale cap on the review chip (twin of v0.4.1's compaction cap), and
a persisted last-review record.

**SDK surfaces used (Desktop SDK only):** `ctx.register` status-bar chip
contributions (three); `host.onEvent('review.summary')`,
`host.onEvent('message.start')`, `host.onEvent('message.complete')`;
`host.logs({ file:'agent', search, lines })` — filtered read-only tails,
windows 100–5000 per marker class; `host.request('config.get')` (best-effort
nudge intervals, 10/15 fallback); `ctx.storage` (three small records: settings +
last compaction + last review); `ctx.registerSettingsPage` (optional Settings ▸
Thresholds page; runtime-guarded — older hosts without the seam simply keep the
built-in defaults).

Single static `desktop/plugin.js` (~955 lines, ESM); no build step, no Python
half, no dependencies beyond `@hermes/plugin-sdk` + react, no self-updating
code.

## Rule 13 disclosures (what a user would want to know before installing)

- **Reads `agent.log`** via `host.logs`: read-only filtered tails of the user's
  own log (`bg-review`, `Turn ended`, `usage ticker stop timed out`, `context
  compression`, `Micro-compaction` markers). Only timestamps/markers are
  parsed; nothing is stored beyond the three small plugin-storage records and
  shown in tooltips. That log can contain other sessions' content — disclosed
  here and in the README.
- **Observer-only**: the chips never trigger, throttle, truncate, or otherwise
  touch a review, compaction, or live session. Display only.
- **No network calls** beyond the local Hermes gateway RPCs listed above; no
  credential access; no telemetry.
- **Untrusted input**: the `review.summary` text is model output — it is shown
  in a tooltip for review only, never acted on. The plugin has no directive or
  command surface at all.
- **Fail-open by design**: any log-read error or timeout degrades to
  `review idle` / last-persisted state; the plugin can never wedge a session.

## Related Issue

N/A — owner-initiated new catalog entry; no tracking issue exists. (Sibling
plugin prompt-queue was added via [#131983](https://github.com/NousResearch/hermes-agent/pull/131983); the two form a logical pair — prompt-queue gates on
review completion, bg-review-watch shows what that gate is waiting for.)

## Type of Change

- [ ] 🐛 Bug fix (non-breaking change that fixes an issue)
- [x] ✨ New feature (non-breaking change that adds functionality)
- [ ] 🔒 Security fix (undisclosed vulnerabilities in [SECURITY.md](https://github.com/NousResearch/hermes-agent/blob/main/SECURITY.md) §3.1 scope go to [Security Advisories](https://github.com/NousResearch/hermes-agent/security/advisories/new) first, not a public PR)
- [ ] 📝 Documentation update
- [ ] ✅ Tests (adding or improving test coverage)
- [ ] ♻️ Refactor (no behavior change)
- [ ] 🎯 New skill (bundled or hub)

## Changes Made

- `plugin-catalog/bg-review-watch.yaml` — **the only file this PR changes**:
  new entry, `tier: community`, `category: desktop`,
  `requires_hermes: ">=0.21.5"`, `version: "0.5.0"`, exact-SHA pin
  `e673f95acf46a5c7026cba484accd4c7d6e9a79c`, two sha-pinned screenshots,
  empty capability lists (renderer-only).

What the pinned version contains, by file in the plugin repo:
`desktop/plugin.js` (the whole plugin), `plugin.yaml` (manifest),
`test-plugin.mjs` (committed node:vm regression suite), `README.md`,
`CHANGELOG.md`, `VERSION`, `LICENSE`, `docs/screenshots/` (both captures).

## How to Test

1. Clone at the pin:
   `git clone https://github.com/vectorforge22/bg-review-watch && cd bg-review-watch && git checkout e673f95acf46a5c7026cba484accd4c7d6e9a79c`
2. `node --experimental-vm-modules test-plugin.mjs` → passes: orphan spawn →
   stale → cleared by `review.summary`; always-on compaction chip with
   persisted last run; both render-time stale caps incl. custom ceilings;
   settings sanitization; 8 s log-read timeout; persisted review record
   reaching the idle tooltip; Settings page registration/render. Node 18+; no
   dependencies.
3. `hermes plugins validate <path-to-clone>` → `Validation passed` (security
   scan safe, no core override, desktop surface inside the plugin SDK).
4. Optional live check: copy `desktop/plugin.js` + `plugin.yaml` to
   `$HERMES_HOME/desktop-plugins/bg-review-watch/`; the chips appear within
   seconds and track a real review/compaction cycle.

## Checklist

### Code

- [x] I've read the [Contributing Guide](https://github.com/NousResearch/hermes-agent/blob/main/CONTRIBUTING.md)
- [x] My commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`fix(scope):`, `feat(scope):`, etc.) — single commit: `chore(plugin-catalog): add bg-review-watch v0.5.0 entry (e673f95)`
- [x] I searched for [existing PRs](https://github.com/NousResearch/hermes-agent/pulls) to make sure this isn't a duplicate — no existing or open `bg-review-watch` entry; catalog audited 2026-10 (401 entries at upstream HEAD + live search); nearest neighbors (`agent-log`, `hermes-monitor`, `context-audit`) cover different surfaces
- [x] My PR contains **only** changes related to this fix/feature (no unrelated commits) — one catalog YAML file
- [ ] I've run `pytest tests/ -q` and all tests pass — N/A: single-file catalog YAML, no Python touched; CI's gate remains authoritative
- [ ] `python scripts/check` passes (the blocking lint and code-health checks CI runs) — N/A: same reason; catalog metadata is outside the lint surface
- [x] I've added tests for my changes (required for bug fixes, strongly encouraged for features) — the pinned version ships a committed node:vm regression suite (`test-plugin.mjs`) covering every state transition and both stale ceilings; a catalog entry itself has no pytest surface
- [x] I've tested on my platform: Windows 11 (Hermes desktop v0.22.0+119; local Qwen3.8-27B via llama.cpp, one inference slot — the plugin's target environment), incl. live recovery from a frozen compaction state

### Documentation & Housekeeping

- [x] I've updated relevant documentation (README, `docs/`, docstrings) — or N/A — README at the pinned SHA carries the full chip table, detection mechanics, configuration, and trust notes
- [ ] I've updated `cli-config.yaml.example` if I added/changed config keys — or N/A — N/A (no config keys; all state lives in plugin storage)
- [ ] I've updated `CONTRIBUTING.md` or `AGENTS.md` if I changed architecture or workflows — or N/A — N/A (no hermes-agent architecture or workflow change)
- [x] I've considered cross-platform impact (Windows, macOS) per the [compatibility guide](https://github.com/NousResearch/hermes-agent/blob/main/CONTRIBUTING.md#cross-platform-compatibility) — or N/A — renderer-only JS with no platform APIs; all log access goes through the `host.logs` gateway RPC; developed and live-tested on Windows 11
- [ ] I've updated tool descriptions/schemas if I changed tool behavior — or N/A — N/A (no hermes-agent tool behavior change)

## Screenshots / Logs

- **Attached:** two status-bar strips at the pinned SHA (also in
  `docs/screenshots/`): `status-bar-idle.png` — real state, `review idle` with
  the nudge fill bar and `compact idle · last 33h 5m`; `review-running.png` —
  `review running · 3m 46s` alongside the idle compaction chip (seeded inertly
  for the capture; seed removed and verified by hash afterwards, nothing sent).
- **Log:** `hermes plugins validate` at `e673f95` → `Validation passed` —
  security scan safe · no core override · desktop surface stays inside the
  plugin SDK.

---

## Internal pre-submit checklist (delete before submitting)

- [ ] Re-run `hermes plugins validate` against a fresh clone at the pinned SHA
      (not just the working tree) — cheap insurance
- [ ] README at the pinned SHA renders acceptably (it's the catalog page)
- [ ] Fetch `PULL_REQUEST_TEMPLATE.md` from upstream main at paste time and
      mirror any section/checkbox drift (this draft tracks the 2026-10-14
      checkout; template verified identical on 2026-10-19)
- [ ] Arthur approves the PR description wording
- [ ] Push `unreleased` + `main` on vectorforge22/bg-review-watch first — the
      pin and both raw.githubusercontent screenshot URLs are dead until then
- [ ] Fork NousResearch/hermes-agent → add `plugin-catalog/bg-review-watch.yaml`
      (bytes from `docs/catalog-submission/bg-review-watch.yaml`) → open PR with
      the description above (commit: `chore(plugin-catalog): add bg-review-watch
      v0.5.0 entry (e673f95)`)
- [ ] Catalog CI needs maintainer "Approve and run" per head commit — batch
      pushes, never push WIP
- [ ] After merge: note the listing URL in the README; update vault SOT
      (`projects/` plugin notes) with entry + pin
