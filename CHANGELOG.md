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

[0.2.1]: https://github.com/sblattj/opencode-goal-plugin/releases/tag/v0.2.1
[0.2.0]: https://github.com/sblattj/opencode-goal-plugin/releases/tag/v0.2.0
