# Roadmap — background-review-watch v0.6.0 (multi-session) + post-0.6 view modes

Status: planned. v0.5.0 is the catalog entry (pin `e673f95`, initial PR pending).

## Why v0.6

The current compaction state machine is **global**, but compaction is
**per-session and concurrently runnable** ("the compressor serializes attempts
*on the session*" — code comment, verified against the markers). The log
markers already carry `session=<id>` and our regexes already capture it — we
then discard it. Consequence: with two sessions compacting at once, session B's
`done:` line closes session A's "compacting" state early (cosmetic misreport;
no data impact). Single-session use is unaffected, which is why this ships in
v0.6 rather than blocking the v0.5.0 catalog entry.

**Design principle: scope each chip to its *true* scope.**

- Background review daemon: **profile-wide, one at a time**; spawn/complete
  log lines carry no session field → the review + guard chips stay global and
  unlabeled (a session name on them would be false attribution).
- Compaction: becomes **per-session** — keyed by the `session=` field already
  parsed. This simultaneously fixes the interleaving misreport.

## v0.6.0 — per-session compaction, itemized display

1. **Per-session state machine.** Key the existing start/terminal-line logic by
   session id (already captured in `RE_COMP_START` / `RE_COMP_DONE`). Test the
   interleaved A/B case *first* (it is the regression this version exists for).
2. **Session identity.** Titles via `host.request('session.list')`, 60 s cache,
   refresh on unknown ids; fallback label = short id suffix (e.g. `…4f2a`).
   `host.state.busyBySession` (live `Record<sessionId, boolean>`) for
   ordering/liveness — no new log polling needed: the same 3000-line
   `context compression` tail carries all sessions' markers.
3. **Display rule** (what occupies a chip slot):
   visible set = *(currently compacting) ∪ (terminal event < 10 min)*, sorted
   running-first then most-recent; if empty, show exactly one chip for the most
   recent session's last compaction (keeps today's always-visible anchor).
   Chip shape: `● <Name> compacting · 3m 07s` / `● <Name> compact done 2m ago`.
   No permanent per-session *idle* chips — that is the status-bar-saturation
   failure mode for dense multi-session setups.
4. **Overflow.** New setting **Max compaction chips** (default 3, clamped 1–6,
   same sanitize/persist pattern as the v0.5.0 thresholds page). Excess
   sessions collapse into a head chip `+N more` with a tooltip listing name +
   state — never unbounded growth.
5. **Storage v2.** Per-session `lastRec` map; one-way migration from the v1
   global record (kept for the most recent session, dropped if absent).
6. **Nudge fill bar stays global** (documented estimate; whose turns count
   toward the profile-wide daemon is not observable from the plugin side).
7. **Tests.** Interleaved A/B compaction; cap + `+N more` overflow; name
   fallback when a session has no title; storage v1→v2 migration; all v0.5.0
   suites kept green.

## Post-v0.6 — view modes: itemized / consolidated (Arthur, 2026-10-19)

A **"Compaction view"** setting with two options:

- **Itemized** (the v0.6 default above): one chip per active/recent session,
  subject to the cap + overflow chip.
- **Consolidated**: a single `compact` cluster chip, looking like today's v0.5
  chip (`● compacting · 3m 07s` — newest/running session drives the label). On
  **hover**, the tooltip lists every session with an active compaction task:
  name, state, elapsed/last-run — and the rows carry **copyable session
  details** (name + session id), so a user can lift `name (id)` or the raw id
  into prompt-queue's per-card target picker or any other tooling.

Notes for implementation:

- Verify clipboard availability in the packaged renderer
  (`navigator.clipboard.writeText`) before promising click-to-copy; fallback is
  plain monospace text in the tooltip (selectable + right-click copy).
- The consolidated label rule and the hover list both derive from the same
  per-session map — itemized is just a different render of v0.6's data, which
  is why this lands *after* v0.6 rather than as part of it.
- Rationale: dense multi-session setups get one quiet chip with hover
  drill-down; single-session users see no difference either mode.

## Deferred / not planned (yet)

- Per-session nudge countdowns — blocked on harness turn-count semantics.
- Compaction *triggering* or any write-side control — the plugin stays
  observer-only (standing trust contract).
