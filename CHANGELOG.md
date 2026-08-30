# Changelog

All notable changes to this fork are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

This is a hard fork of [`prevalentWare/opencode-goal-plugin`](https://github.com/prevalentWare/opencode-goal-plugin)
(MIT). It carries upstream's full history, so `git tag` lists upstream's `v0.1.x`
tags — none of which were ever published as releases of this repository. **`0.2.0`
is this fork's first release**, and the fork's version line starts above every
inherited tag so the two cannot be confused or collide.

The fork is consumed as a local file path and is **not published to npm**. There
is no `@sblattj/opencode-goal-plugin` package; `dist/server.js` is committed and
self-contained, and that file is the artifact.

## [0.3.1] — 2026-08-30

### Fixed

- **A goal could still strand silently after a compaction — inside the very fix
  this fork exists for.** `0.2.0` added a post-compaction re-arm, because
  suppressing OpenCode's native autocontinue also suppresses the `session.idle`
  that normally drives `runAutoContinue`. It scheduled that re-arm with the
  `"recovery"` purpose. But `"recovery"` means *transport-dead timer*: model
  output proves the transport came back, so every progress path cancels it on
  sight. After a compaction the model resumes almost immediately — usually with a
  tool call — so the re-arm was destroyed by the same in-window output it existed
  to outlive. The goal was left `active`, with `stopReason: null`, `autoTurns`
  frozen, budget and time remaining, and no further continuation ever emitted. It
  reads as a hang, and only a user nudge recovers it.

  The re-arm now has its own `"compaction"` purpose, spared by the four
  progress-cancellation paths via `PROGRESS_SAFE_PURPOSES`. The transport-dead
  `"recovery"` timer is unchanged and still cancels on output — the existing
  tests covering that behaviour all still pass.

  One of the four cancellation sites is a tool-output path whose guard
  *specifically admitted* `"recovery"`, which made it the likeliest of the four to
  reach the re-arm first, since a tool call is the usual first output after a
  compaction. It is guarded too.

  Verified with a control rather than by assertion: the shipped `0.3.0` bundle,
  driven through a compaction followed by immediate tool and assistant output,
  emits zero continuations and leaves `autoTurns` at 0; the `0.3.1` bundle emits
  the continuation and advances it. The new regression test fails against the
  pre-`0.3.1` tree.

  Reported against the fork's `0.2.x` line. `0.3.0` did not fix it: the
  compaction hook and the purpose union are byte-identical between `0.2.0` and
  `0.3.0`, so upgrading to `0.3.0` for this bug would have changed nothing.

## [0.3.0] — 2026-08-30

Hitting a wall-clock limit used to be functionally the same as losing the goal.
A goal capped at 36000s that ran to 42478s elapsed — with 98% of its 300M token
budget still unspent — could not be given more runway by any tool: `update_goal_status`
could not grant time, `update_goal_objective` edited only the objective text, and
`update_goal` only closed the goal. The single workaround was `clear_goal` +
`create_goal`, which discards `history[]`, `checkpoints[]`, and elapsed accounting
and forces the entire objective to be re-passed verbatim.

### Added

- **`update_goal_limits`** edits a non-closed goal's `maxDurationSeconds`,
  `tokenBudget`, and `maxAutoTurns` in place, preserving `history[]`,
  `checkpoints[]`, `createdAt`, and elapsed accounting. Each limit takes either an
  absolute value (`null` clears the cap) or an increment; passing both for one
  limit is rejected rather than silently resolved.
- **Resume-with-increment.** `update_goal_status` accepts `additional_seconds`,
  `additional_tokens`, and `additional_auto_turns`, so raising a cap and resuming
  is one atomic call instead of two. An increment anchors on whichever is larger,
  the cap or the amount already used: `36000 + 3600` would still sit below 42478s
  elapsed and re-limit immediately, so the anchor has to be the usage.
- **`snapshot_goal`** exports a goal as markdown — the objective verbatim, plus
  limits, usage, checkpoints, and full history — so state can be preserved before
  any destructive change without hand-rolling a file.
- **`reset_elapsed`** (opt-in, on both tools) zeroes the elapsed clock for the
  "same goal, fresh clock" case.
- Goal snapshots carry `exhaustedLimits`, `limitKind`, and `remainingSeconds`, so
  a caller can tell a duration-limited goal from a token-limited one without
  parsing `stopReason`. These are derived on read and never persisted: `GoalStatus`
  is a persisted `Schema.Literal`, and adding a status value there would make a
  new state file undecodable by an older plugin — which fails the whole file, not
  just the new goal.

### Fixed

- **Resuming an exhausted goal reported a resume that never happened.**
  `update_goal_status { status: "active" }` on a goal past its duration cap set the
  status to `active`, returned success, and then re-limited on the very next
  continuation, because elapsed time still exceeded the cap. The resume is now
  refused up front: the goal keeps its limited status and the result carries
  `resume_refused`, `limited_by`, and the exhausted limits with their real numbers.
- **Limit messages named the cap but not the overrun.** A stop reason read
  `max duration reached (36000s)` with no indication that 42478s had elapsed.
  Stop reasons now read `elapsed 42478s >= duration cap 36000s`, and both the
  wrap-up prompt and the tool results state the remediation — raise the limit,
  do not clear and recreate the goal.

## [0.2.1] — 2026-08-29

### Fixed

- **The README advertised eight of the nine agent tools.** `update_goal_status`
  — the tool behind `/goal pause` and `/goal resume` — was missing from the tool
  list, and had been for as long as that tool has existed. The list is corrected,
  and a test now derives the expectation from the plugin's own tool registry
  rather than from a second hand-maintained list, so the next tool added cannot
  repeat the omission.

## [0.2.0] — 2026-08-29

The first release of the fork. It contains everything that has diverged from
upstream `0aa2514`.

### Added

- **`question_policy` — a goal that runs unattended no longer stops to ask
  questions it cannot get answered.** OpenCode's built-in `question` tool blocks
  the turn until a human answers, which parks an auto-continuing goal until
  somebody happens to look at the terminal. While a goal's status is `active`,
  the tool is suppressed and the model is told what to do instead:
  - `"decide"` (the default) — pick the answer you would have recommended, say in
    one line what you chose and why, record it as an assumption, and keep working.
  - `"deny"` — do not guess; resolve it from the worktree and the objective, or
    close the goal with `update_goal` status `"unmet"` and a concrete blocker.
  - `"allow"` — the previous behavior; nothing is blocked.

  The policy is in force only while the goal is `active`. A paused,
  budget-limited, usage-limited, complete or unmet goal — and any session with no
  goal — asks questions exactly as before, because those are the states where the
  user is back in the loop.

  Enforcement is layered. The policy text is appended to the goal-mode system
  reminder, and that is the only part that says what to do *instead* of asking.
  On the v2 plugin API the tool is then deleted from the set offered to the
  session, so the model never sees it. The v1 API cannot hide a tool per session,
  so the call is blocked instead: the plugin throws from `tool.execute.before`,
  and the thrown text — carrying the same instruction — is what comes back to the
  model as the failed tool's error.

- **An audit trail for suppressed questions.** Each block increments
  `questionsSuppressed` on the goal and writes a history entry naming the question
  that was blocked, so `get_goal` and `get_goal_history` show what the agent
  wanted to ask before it decided for itself. The count renders in the TUI goal
  sidebar and in the goal snapshot carried through compaction.

- **A test that the shipped bundle stays self-contained**, so the loader failure
  fixed below cannot silently return.

### Fixed

- **The plugin could not be loaded at all.** `dist/server.js` was built with
  `--external effect --external zod`, so it imported both as bare specifiers and
  needed a `node_modules` beside it. A checkout without one failed to load —
  silently, with nothing in the OpenCode log — which meant the compaction fix
  below had never actually run. The build no longer externalizes runtime
  dependencies; the bundle is self-contained and imports only Node builtins.
  `@opencode-ai/plugin` stays external because it is type-only.

- **An active goal stopped auto-continuing after auto-compaction.** The plugin
  suppresses OpenCode's native post-compaction continuation so its own
  goal-specific prompt stays authoritative, but suppressing it also suppresses the
  `session.idle` event that drives `runAutoContinue`, stranding the
  `awaitingContinuationProgress` flag. The `experimental.compaction.autocontinue`
  hook now schedules the recovery continuation itself, mirroring the
  `session.error` recovery path.

### Changed

- **The package is `@sblattj/opencode-goal-plugin`.** Renamed from
  `@prevalentware/opencode-goal-plugin`, with homepage, bugs and repository
  pointing at this fork. Attribution to the original author is kept in
  `contributors` and the `LICENSE` is untouched. The plugin id
  (`local.goal-mode.server`) and the state path
  (`~/.local/share/opencode-goal-plugin/goals.json`) are unchanged, so existing
  goal state survives the rename.

- **`publish.yml` is `workflow_dispatch` only.** This fork publishes nothing to
  npm, so a push-triggered run could only ever fail. Typecheck, lint and tests
  still run on every pull request via `ci.yml`.

[0.3.1]: https://github.com/sblattj/opencode-goal-plugin/releases/tag/v0.3.1
[0.3.0]: https://github.com/sblattj/opencode-goal-plugin/releases/tag/v0.3.0
[0.2.1]: https://github.com/sblattj/opencode-goal-plugin/releases/tag/v0.2.1
[0.2.0]: https://github.com/sblattj/opencode-goal-plugin/releases/tag/v0.2.0
