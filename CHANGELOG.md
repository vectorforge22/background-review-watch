# Changelog

All notable changes to this plugin are documented here.

The project uses [Semantic Versioning](https://semver.org/). The first two
versions below are reconstructed from the repository history; version 0.3.0 is
the first release to carry an explicit `VERSION` file.

## [0.4.1] - 2026-10-15

### Fixed

- **Unbounded "compacting" display** (incident 2026-10-15): the chip pinned
  `compacting · 3h+` although the run's terminal line had been on disk hours
  earlier (a compaction started 16:08 and committed 16:13; the badge kept
  counting up for over three more hours, and a queued prompt was sent while it
  still claimed the slot — the badge was stale, not running). Compaction
  `running` state now carries a 60-minute orphan ceiling (measured runs on this
  box: ~5 min and ~8 min):
  - **Poll side** — a start marker older than 60 min with no terminal line
    classifies as a new `stale` mode, shown amber as `compact stale · <age>`.
  - **Render side (the real backstop)** — the chip caps at render time via the
    shared `compactStale()` check: even if the reconcile poll is frozen (dead
    poll loop or stuck log reader), the chip re-renders every second and
    self-corrects to the stale label. The 10-15 freeze could not have been
    surfaced by poll-side logic alone, which is why the cap exists in both
    layers.

The stale tooltip names the failure classes (run died without logging vs log
reader frozen) and says to treat the badge as a false alarm when no compaction
was observed — verify via `agent.log "context compression"`.

## [0.4.0] - 2026-10-15

### Added

- **`review stale` state**: a background-review spawn marker with no terminal
  line older than 4h (measured healthy runs: 22–26 min) is now reported as
  `review stale · <age>` in warning color instead of `review running`. The
  review is a thread inside the gateway process, so a PC reboot or kill
  mid-review dies without logging anything — previously that pinned the chip
  at "running" forever (observed: spawn 10-14 19:34, reboot 19:47, chip stuck
  at "review running · 16h 10m" while the GPU sat idle). A stale review holds
  no slot: the nudge countdown bar shows again and self-clears when the next
  review completes.
- **Always-visible compaction chip**: the chip now renders in every state.
  Idle shows `compact idle · last <age>` with the last committed reduction
  (or failure class) in the tooltip; running/recent states are unchanged.
- Persist the newest terminal compaction record (`ctx.storage`, key
  `bg-review-watch.compact-last.v1`) so "last compacted" survives the 3000-line
  log window rolling past, hot reloads (fresh module), and app restarts.
- `ago()` now rolls hours into days past 48h (`1d 4h`), for long-lived idle labels.

### Changed

- Smoke test covers the new behaviors end-to-end against synthetic log lines:
  orphaned spawn → `review stale`, a `review.summary` event clears it, and the
  compaction chip renders an idle "last <age>" line from a persisted-style record.

## [0.3.0] - 2026-10-02

### Added

- Observe `message.start` and `message.complete` as the foreground reply
  boundary, and surface a `review overlap` diagnostic if a background review
  starts before foreground completion.
- Surface `usage ticker stop timed out` recovery markers for ten minutes so a
  completed reply does not silently hide a stuck ticker cleanup.
- Add a dependency-free loader and registration smoke test covering all three
  status-bar contributions and their event wiring.

### Changed

- Rename the displayed plugin from **Background Runner Watch** to
  **Background Review & Completion Watch** to reflect the wider scope.
- Preserve log timestamp milliseconds when comparing review lifecycle events,
  reducing false ordering results for events within the same second.

## [0.2.0] - 2026-09-27

### Added

- Add the compaction status chip for running, completed, and failed batch
  context compression attempts.
- Show committed message reduction, failure class, and the latest
  micro-compaction result in the tooltip.

### Changed

- Correct the compaction timing guidance using measured local-model runtime.

## [0.1.0] - 2026-09-24

### Added

- Initial Hermes Desktop disk plugin.
- Add the background-review status chip with running elapsed time and recent
  completion summary.
- Add the turn-based memory and skill nudge countdown bar.
- Detect review lifecycle through live events and filtered `agent.log` polls.

[0.4.0]: https://github.com/vectorforge22/bg-review-watch/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/vectorforge22/bg-review-watch/compare/eb49f35...v0.3.0
[0.2.0]: https://github.com/vectorforge22/bg-review-watch/compare/7a222e1...eb49f35
[0.1.0]: https://github.com/vectorforge22/bg-review-watch/commit/7a222e12df8d2e71d2e9860df851753b967e5e28
