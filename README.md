# Background Review & Completion Watch

Current version: **0.5.0**. See [CHANGELOG.md](CHANGELOG.md) for release history.

A [Hermes Desktop](https://hermes-agent.nousresearch.com) plugin that makes the
**background self-improvement review visible**: a status-bar chip that shows
whether a review is running, when the last one finished (and what it produced),
and a **fill bar counting down the turns until the next nudge fires**.
It also watches the foreground/review boundary introduced to keep a local
single-inference slot from starting review work before the reply is terminal,
and shows the lifecycle of batch context compaction.

Motivation: the background review is a silent daemon thread — the only gateway
event is the completion summary, which can arrive hours after it started.
Before this plugin, a multi-hour local-model review was a surprise: no
indicator, no way to know it was eating the main inference slot.

## What it shows

Status bar, right cluster:

| State | Chip |
|---|---|
| Idle | `● review idle` + fill bar `Nt` — turns since last review / nudge interval (bar fills as the next nudge approaches) |
| Running | `● review running · 2m 14s` (pulsing accent dot, live elapsed time) |
| Just finished | `● review done 3s ago` — tooltip carries the summary text (e.g. "Skill 'x' created · …") |
| **Review stale** | `● review stale · 16h 10m` (warning) — a spawn marker with no terminal line older than the review-stale ceiling (default 4 h). The gateway died mid-review; nothing is running and the slot is free. Capped at poll time AND render time. |
| **Compacting (v0.2.0+)** | `● compacting · 4m 12s` (pulsing accent dot) while a batch context compaction runs; then `● compact done 3m ago` / `● compact failed 2m ago` for 10 min. Tooltip: committed reduction (`168 → 77 messages`) or failure class (`stall_interrupted`, `explicit_interrupt`, …), plus the last micro-compact pass when Stage A runs. |
| **Compact stale (v0.4.1+)** | `● compact stale · <age>` (warning) — a start marker over the compaction-stale ceiling (default 60 min) with no terminal line: the run died without logging, or the log reader froze (the poll self-recovers since v0.5.0). The badge is capped at render time, so a frozen state can never display an unbounded "compacting". |
| **Ticker recovery (v0.3.0+)** | `● reply guard recovered · 3s ago` for 10 min when bounded foreground cleanup detects a stuck usage ticker. The completed reply continues; the tooltip points to the captured stack in `agent.log`. Hidden on healthy runs. |
| **Ordering violation (v0.3.0+)** | `● review overlap · 3s ago` if review startup predates the foreground `message.complete` event. This is a diagnostic failure signal, not a normal running state. |

Hover for details: last result, next-nudge countdown for both memory
(default 10 turns) and skill (default 15 turns) nudges; on the review chip the
idle tooltip also names when the **last background review finished** and what
it produced (persisted, so it survives log rotation).

## Configuration (v0.5.0+)

**Settings ▸ Plugins ▸ Background Review & Completion Watch ▸ Thresholds** —
the two orphan ceilings, in minutes, applied live without a reload:

| Setting | Default | Sizing rationale |
|---|---|---|
| Review stale ceiling | 240 min | measured healthy local-model review runs: 22–26 min; 4 h is wide headroom. Above it, "running" can only mean the process died without logging. |
| Compaction stale ceiling | 60 min | measured healthy batch compactions: ~4–8 min at ~200 K tokens. Above it, a start marker with no terminal line is reported as stale, never "compacting". |

Raise them only if you see false `stale` on unusually long runs (very large
contexts, slower hardware). Values persist in plugin storage and are clamped to
1 min – 7 days; a **Reset** row restores the defaults. On hosts without a
plugin settings page (older builds) the built-in defaults simply apply.

## How it detects (no Python backend, no gateway restart)

Read-only, renderer-only:

- **Live completion** — `host.onEvent('review.summary')` (seconds before the log line).
- **Turn ticks** — `host.onEvent('message.start')` advances the countdown.
- **Foreground completion** — paired `message.start` / `message.complete`
  events define the delivery window. A review start inside that window is
  reported as an ordering violation.
- **Bounded-cleanup recovery** — polls the core diagnostic marker
  `usage ticker stop timed out`; the core log carries the blocked thread stack.
- **Running state** — 20 s poll of `host.logs({ file:'agent', search:'bg-review' })`:
  spawn marker `OpenAI client created … thread=bg-review:<pid>` vs completion
  `Background review complete: … result=skill|none` / `Background memory/skill
  review failed`. `running ⇔ latest spawn ts > latest completion ts` (at most
  one review runs at a time; a new turn supersedes an in-flight one, and
  superseded runs still log a completion line).
- **Intervals** — `host.request('config.get')`, best-effort with 10/15 defaults.

The spawn-marker anchor (`OpenAI client created`) is load-bearing: the
`retired`/`closed` teardown lines also carry `thread=bg-review:<pid>` and
arrive *after* the completion line — a bare `thread=bg-review:(\d+)` match
would flip the chip to "running" forever. Verified against 17 historical runs.

**Poll liveness (v0.5.0).** Every log read is wrapped in an 8 s timeout, and the
poll loop self-reschedules: after two cycles without a successful reconcile it
retries at 5 s cadence until one succeeds, then returns to 20 s. Before v0.5.0
a stalled log reader froze state forever (live incident: "compact stale · 30h+"
anchored on a run whose terminal line had been on disk for hours) — the render-
time caps labeled it correctly but nothing recovered the state; now recovery is
automatic and re-derives everything from the live log.

## Install

Disk plugin (no build step): copy `desktop/plugin.js` and `plugin.yaml` into
`$HERMES_HOME/desktop-plugins/bg-review-watch/` — the app hot-reloads within
seconds. Enable in **Capabilities → Plugins** (on by default).

Or via install link: `hermes://plugin/install?repo=<owner>/bg-review-watch&enable=1`

## Cost

~3 REST calls per 20 s while idle (server-side filtered tails, each capped at
8 s), 1 s timer for the elapsed-time tick while a review runs, plus three event
listeners. No sockets, no Python, no state written beyond three small plugin-
storage records (settings + last compaction + last review).

## Files

- `plugin.yaml` — manifest (name / version / description / floor)
- `desktop/plugin.js` — the whole plugin (single ESM file, loaded uncompiled)
- `test-plugin.mjs` — dependency-free loader/registration smoke test
- `VERSION` — authoritative machine-readable plugin version
- `CHANGELOG.md` — release history reconstructed from Git commits

## Validate

```powershell
node --check plugin.js
node --experimental-vm-modules test-plugin.mjs
```

## Notes / limitations

- Countdown assumes user-driven turns (a nudge fires after N user turns since
  the last review); it is an estimate, not the harness's internal counter.
- Log markers were verified against the 2026-09 build
  (`agent/background_review.py`, `logs/agent.log`). If a Hermes build renames
  the `thread=bg-review` markers, the poll degrades to "idle" (fail-open) —
  the live `review.summary` path keeps working.
- Compaction markers verified 2026-09-27 against
  `agent/conversation_compression.py` (started/done/attempt-telemetry) and
  `agent/turn_finalizer.py` (Micro-compaction), plus 13 historical telemetry
  lines in `agent.log`. "Running" = latest `context compression started:`
  newer than the latest terminal line (`done:` or telemetry JSON, which
  covers both committed and aborted attempts).
- The review replays the conversation on the main local model, so "running"
  also means the local model is busy — this plugin does not throttle the
  review; the harness knobs (`auxiliary.background_review.*`, nudge
  intervals) do.
- The v0.3.0 completion guard is observational. Correctness remains in Hermes core;
  disabling this plugin does not disable the delivery barrier or bounded ticker
  shutdown.

## License

MIT
