# OpenCode Goal Plugin

[![GitHub repository](https://img.shields.io/badge/GitHub-sblattj%2Fopencode--goal--plugin-blue?logo=github)](https://github.com/sblattj/opencode-goal-plugin)
[![Fork of prevalentWare/opencode-goal-plugin](https://img.shields.io/badge/fork%20of-prevalentWare%2Fopencode--goal--plugin-lightgrey?logo=github)](https://github.com/prevalentWare/opencode-goal-plugin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **This is a fork.** `sblattj/opencode-goal-plugin` is an independently maintained hard fork of
> [`prevalentWare/opencode-goal-plugin`](https://github.com/prevalentWare/opencode-goal-plugin),
> originally written by Prevalentware and used here under the MIT licence. It carries a fix for goal
> auto-continuation after compaction that upstream does not have. It is **not** affiliated with,
> endorsed by, or supported by the original authors — please do not send them issues about this fork.
> See [Attribution and licence](#attribution-and-licence).

OpenCode Goal Plugin adds Codex-style long-running goal mode to OpenCode. It gives AI coding agents a `/goal` slash command, persistent goal state, completion evidence, idle continuation, and a terminal UI goal indicator so an OpenCode session can keep working toward one explicit objective until it is complete, blocked, or cleared.

If you are searching for an OpenCode goal plugin, goal mode for OpenCode, or a way to keep an OpenCode AI coding agent focused on a long-running task, this repository is the plugin for that workflow.

Links:

- GitHub repository: [`sblattj/opencode-goal-plugin`](https://github.com/sblattj/opencode-goal-plugin)
- Upstream project: [`prevalentWare/opencode-goal-plugin`](https://github.com/prevalentWare/opencode-goal-plugin) (MIT)
- Install source: `github:sblattj/opencode-goal-plugin` — see [Install](#install). **This fork is not published to npm.**

The OpenCode Goal Plugin adds:

- `/goal <objective>` as an OpenCode command for TUI, desktop, and web.
- A sidebar goal indicator with status, elapsed time, and objective.
- Agent tools: `get_goal`, `get_goal_history`, `list_all_goals`, `snapshot_goal`, `create_goal`, `set_goal`, `update_goal_objective`, `update_goal_limits`, `update_goal_status`, `update_goal`, and `clear_goal`.
- Goal close evidence: `complete` requires verified evidence, and `unmet` requires a concrete blocker.
- Persistent per-session goal state with history, checkpoints, budgets, and owner-only file permissions.
- Optional automatic continuation on `session.idle` / `session.status`, with no-progress pause and budget wrap-up safeguards.
- Unattended-question handling: while a goal is active, OpenCode's built-in `question` tool is suppressed so the agent decides and records an assumption instead of stalling on a human.
- Plan-mode safety: goals created from the `plan` agent stay paused, and auto-continue never escapes a Plan-mode session or switches agents on its own.
- Compaction context so active goals are preserved when OpenCode summarizes a long session.

## What This Fork Changes

One behavioural fix, plus the identity and packaging changes that follow from being a fork.

**The symptom.** An active goal stops auto-continuing after auto-compaction, silently. Nothing is logged
to `~/.local/share/opencode/log`; the session simply stops making progress.

**Why it happens.** The plugin deliberately suppresses OpenCode's native post-compaction "continue"
turn so its own goal-specific continuation prompt stays authoritative:

```ts
async "experimental.compaction.autocontinue"(input, output) {
  const goal = await getGoal(input.sessionID)
  if (goal?.status === "active") output.enabled = false
},
```

Having suppressed the native resume, the plugin then relies on a `session.idle` event to drive
`runAutoContinue()`. After a *suppressed* compaction no idle event arrives, so `runAutoContinue()`
never runs — and it is the only path that both clears the stranded `awaitingContinuationProgress`
flag (via `recordAssistantMessage(..., evaluateContinuation=true)`) and reserves the next
continuation. The event-only paths clear `pendingAttempt` but never clear `awaiting`, and that
asymmetry is why the flag strands.

**Observed evidence** (live state in `~/.local/share/opencode-goal-plugin/goals.json`, 2026-08-28): an
active goal with `awaitingContinuationProgress: true` but `pendingAttempt: null`, `autoTurns` frozen at
1 across roughly nine minutes of real work and logged checkpoints, `lastAssistantMessageID` ahead of
`continuationBaselineMessageID` (so work *had* happened), about 4.97M tokens used across many
compactions, and no errors anywhere.

**The fix.** Keep the original intent — native autocontinue stays suppressed — but guarantee a trigger
by scheduling a continuation straight from the compaction hook, under a purpose of its own:

```diff
     async "experimental.compaction.autocontinue"(input, output) {
       const goal = await getGoal(input.sessionID)
-      if (goal?.status === "active") output.enabled = false
+      if (goal?.status === "active") {
+        output.enabled = false
+        if (autoContinue)
+          scheduleSettledContinuation(
+            input.sessionID,
+            continuationDelayFromSnapshot(minInterval, goal.lastContinuationAt),
+            true,
+            "compaction",
+          )
+      }
     },
```

The scheduled timer fires `runAutoContinue()` once the turn settles, which clears the stranded
`awaiting` flag and reserves a fresh continuation. `reserveContinuation`'s `min_continue_interval` guard
prevents a double-continue.

The re-arm passes `replace = true`, and that argument is load-bearing rather than incidental.
`scheduleSettledContinuation` returns early when an entry already exists for the session, so with
`replace = false` this call is a **silent no-op** whenever a continuation is already scheduled — the
existing entry survives with whatever purpose it already had, and the `"compaction"` purpose below is
never applied. Replacing cannot push the deadline out, because `continuationDelayFromSnapshot` computes
an absolute wake time from `lastContinuationAt` rather than a fresh interval from now.

**The purpose matters, and `0.2.0` through `0.3.0` got it wrong.** Those versions scheduled this re-arm
as `"recovery"`. A `"recovery"` timer is a *transport-dead* timer: model output proves the transport came
back, so every progress path cancels it on sight. After a compaction the model resumes almost immediately
— usually with a tool call — so the re-arm was destroyed by the same in-window output it existed to
outlive, and the goal stranded with `status: "active"`, `stopReason: null`, `autoTurns` frozen and budget
remaining. `0.3.1` gives the re-arm its own `"compaction"` purpose, which the four progress-cancellation
paths spare (`PROGRESS_SAFE_PURPOSES` in `src/server.ts`). The transport-dead timer is unchanged and
still cancels on output.

**`0.3.1` was necessary but not sufficient, and `0.3.2` finishes it.** `0.3.1` kept scheduling the
re-arm with `replace = false`, so the whole fix was dropped whenever a continuation was already
scheduled and the `"compaction"` purpose never reached the map. That is why the failure read as
intermittent: the first compaction of a session lands on an empty schedule map and works, while a later
one usually does not, so a session would survive one compaction and strand on the next.

**Scope.** `src/server.ts` exports two implementations. `"experimental.compaction.autocontinue"` is
registered only in the **v1** `server` export; `setupV2` never registers a compaction hook, so there is
no equivalent bug on the OpenCode 2 path. The v1 path is the one that runs against OpenCode 1.x.

**How far this is verified.** Unit tests, typecheck, lint and the build all pass, and a regression test
drives the compaction hook followed by immediate tool and assistant output, asserting the continuation is
still reserved; that test fails against the pre-`0.3.1` tree. A second regression test arms a
non-progress-safe timer first and then compacts, reproducing the dropped re-arm; it fails against the
pre-`0.3.2` tree. Both shipped bundles were driven through their scenario directly against a control:
`0.3.0` emits zero continuations where `0.3.1` emits one, and `0.3.1` emits zero where `0.3.2` emits one
once a timer is already pending. A
live goal surviving a real compaction inside a running OpenCode session over many hours has still **not**
been observed end to end — that gap is what let the `"recovery"` purpose ship in `0.2.0`. The change has
not been submitted upstream, so upstream carries neither the fix nor any statement about this behaviour.

**Packaging changes.** The package is renamed to `@sblattj/opencode-goal-plugin` so a `bun add` of this
fork no longer claims upstream's `node_modules/@prevalentware/opencode-goal-plugin` slot, and the
homepage, bugs, and repository URLs point at this repository. The built `dist/server.js` is committed
here on purpose, because a `github:` install runs no build step.

## Why Use This OpenCode Goal Plugin?

Use this plugin when you want OpenCode to behave more like a goal-driven coding agent instead of a one-prompt assistant. A goal stays visible, survives session compaction, can continue automatically when the session becomes idle, and can only be closed with explicit evidence or a concrete blocker.

Common use cases:

- Keep an OpenCode agent focused during long refactors, migrations, reviews, or test-fixing sessions.
- Track one explicit objective across TUI, desktop, and web OpenCode surfaces.
- Require completion evidence before a goal is marked done.
- Preserve the current goal when OpenCode summarizes or compacts a long conversation.

## Install

**There is no npm package for this fork.** `opencode plugin @sblattj/opencode-goal-plugin` will not
work, and neither will a bare `github:` entry in the `plugin` array — see
[Why a bare `github:` entry does not work](#why-a-bare-github-entry-does-not-work). Install by
vendoring the repository and pointing OpenCode at the built `dist/server.js` file.

Requirements: [Bun](https://bun.sh) and OpenCode `>= 1.17.1`.

### Option 1: Vendor It With Bun (Recommended)

From your project root:

```bash
bun add github:sblattj/opencode-goal-plugin
```

That installs the fork at `node_modules/@sblattj/opencode-goal-plugin`, built bundle included. Then
point OpenCode at the bundle. Paths in the `plugin` array are resolved relative to the project
directory:

`opencode.json`:

```json
{
  "plugin": ["./node_modules/@sblattj/opencode-goal-plugin/dist/server.js"]
}
```

`tui.json` (OpenCode 1 only — the TUI sidebar loads from a separate config target and a **different**
entrypoint file):

```json
{
  "plugin": ["./node_modules/@sblattj/opencode-goal-plugin/src/tui.ts"]
}
```

The two config targets take different files on purpose. When OpenCode installs a plugin by npm package
name it picks the right entrypoint out of the `exports` map (`./server` and `./tui`); a file path
skips that map, so each target has to name its own file. The server hooks, tools, and goal state work
without the TUI entry — it only adds the sidebar indicator and command-palette item.

To install it for every project instead, put **absolute** paths in your global
`~/.config/opencode/opencode.json` and `~/.config/opencode/tui.json` rather than relative ones.

### Option 2: Clone And Build

```bash
git clone https://github.com/sblattj/opencode-goal-plugin.git
cd opencode-goal-plugin
bun install
bun run build    # optional: dist/server.js is committed
```

Then reference the absolute paths from your OpenCode config:

`opencode.json`:

```json
{
  "plugin": ["/absolute/path/to/opencode-goal-plugin/dist/server.js"]
}
```

`tui.json`:

```json
{
  "plugin": ["/absolute/path/to/opencode-goal-plugin/src/tui.ts"]
}
```

This is the fastest way to iterate on the plugin itself, because an edit plus `bun run build` is
immediately live on the next OpenCode start. Confirm what OpenCode actually resolved, rather than the
file you edited — OpenCode merges every config file it finds and *concatenates* array keys, so a
leftover entry elsewhere will load a second copy of the plugin:

```bash
opencode debug config | python3 -c "import json,sys; print(json.load(sys.stdin)['plugin'])"
```

### OpenCode 2 Beta

Use this section only when running `opencode2`. This tree carries upstream's OpenCode 2 support,
developed against OpenCode 2 preview `0.0.0-next-17055` while remaining compatible with OpenCode 1.

OpenCode 2 uses `plugins` (not `plugin`) and the global `cli.json` (not `tui.json`). Do not mix the two
configuration formats.

The config below adapts upstream's npm-package instructions to this fork's file-path install. **It has
not been exercised against an `opencode2` build**, unlike the OpenCode 1 instructions above; if
OpenCode 2 rejects a path where it expects a package specifier, please
[open an issue](https://github.com/sblattj/opencode-goal-plugin/issues).

`opencode.json`:

```json
{
  "plugins": ["./node_modules/@sblattj/opencode-goal-plugin/dist/server.js"]
}
```

`~/.config/opencode/cli.json`:

```json
{
  "plugins": ["/absolute/path/to/node_modules/@sblattj/opencode-goal-plugin/src/tui.ts"]
}
```

OpenCode 2 does not read the V1 `tui.json` file. The server entrypoint comes from `opencode.json`, while the sidebar and palette integration come from `~/.config/opencode/cli.json`.

OpenCode 2 plugin APIs are still beta. This package pins its V2 development contract to the preview version above; later previews may require a compatible plugin update. V2 currently supports the goal command, tools, persistent state, usage accounting, idle continuation, Plan-mode safety, and TUI sidebar/palette integration. Goal-specific compaction context and recovery of already-running child sessions after a plugin restart remain V1-only because the current V2 plugin context does not expose equivalent hooks or history queries. This fork's compaction fix is likewise V1-only.

### Why A Bare `github:` Entry Does Not Work

Two shorter-looking config entries both fail, which is why the instructions above go through a file
path. Checked against OpenCode 1.18.23:

- `"plugin": ["github:sblattj/opencode-goal-plugin"]` is accepted into OpenCode's resolved config but
  never installs anything usable. It produces a cache directory at
  `~/.cache/opencode/packages/github:sblattj/opencode-goal-plugin/` holding only a partial dependency
  tree — no `package.json`, no installed package, no `dist/server.js` — so there is nothing to import.
  An npm-style entry, by contrast, gets a generated `package.json` and a complete install in the same
  cache location.
- `"plugin": ["@sblattj/opencode-goal-plugin"]` makes OpenCode try to install that name **from npm**
  into its own cache rather than resolving it from your project's `node_modules`. This fork is not on
  npm, so the install 404s and leaves an empty
  `~/.cache/opencode/packages/@sblattj/opencode-goal-plugin@latest/` directory.

`bun add github:sblattj/opencode-goal-plugin` **does** work — it is only OpenCode's own plugin
resolver that cannot take either form. That is why Option 1 uses Bun to fetch and a file path to load.

## Options

In OpenCode 1, server options use the package-and-options tuple in `opencode.json`:

```json
{
  "plugin": [
    [
      "./node_modules/@sblattj/opencode-goal-plugin/dist/server.js",
      {
        "auto_continue": true,
        "defer_while_tasks_active": true,
        "max_auto_turns": 25,
        "min_continue_interval_seconds": 3,
        "max_turn_time": 300,
        "max_prompt_failures": 3,
        "default_token_budget": 200000,
        "max_goal_duration_seconds": 1800,
        "no_progress_token_threshold": 50,
        "max_no_progress_turns": 2,
        "restricted_agents": ["plan"],
        "allow_goal_execution_from_plan": false,
        "question_policy": "decide"
      }
    ]
  ]
}
```

In OpenCode 2, use the plugin object form instead:

```json
{
  "plugins": [
    {
      "package": "./node_modules/@sblattj/opencode-goal-plugin/dist/server.js",
      "options": {
        "auto_continue": true,
        "max_auto_turns": 25,
        "default_token_budget": 200000,
        "restricted_agents": ["plan"]
      }
    }
  ]
}
```

Defaults:

- `auto_continue`: `true`
- `defer_while_tasks_active`: `true`; when enabled, goal auto-continuation waits for active OpenCode Task child sessions and their orchestrator reconciliation before sending the next goal prompt.
- `max_auto_turns`: `25`
- `min_continue_interval_seconds`: `3`
- `max_turn_time`: unset by default; set a positive number of seconds to retry one active-goal continuation prompt when a model turn remains busy for that long. Each new busy event resets the watchdog. Idle, built-in retry, session deletion, active Task children, and restricted agents suppress the retry. Watchdog retries are independent of `min_continue_interval_seconds` and never consume auto-turn or no-progress budgets, but recognized transport failures still count toward the `max_prompt_failures` ceiling.
- `max_prompt_failures`: `3`; consecutive transport or no-response continuation failures pause the goal at this ceiling. Prompt delivery alone does not reset the count; substantive assistant or tool progress, a new goal, or an explicit resume does.
- `default_token_budget`: unset by default; when set, new goals inherit this token budget.
- `max_goal_duration_seconds`: unset by default; when set, new goals inherit this elapsed-time safety limit.
- `no_progress_token_threshold`: `50`; output-token floor used to judge whether a goal continuation turn made progress.
- `max_no_progress_turns`: `2`; consecutive low-progress goal continuation turns before pausing. Only turns produced by a reserved goal continuation count — ordinary low-output assistant messages (for example short tool-call-only turns from PTY or status checks) never increment this counter.
- `register_command`: `true`
- `command_name`: `"goal"`
- `restricted_agents`: `["plan"]`; agents (matched case-insensitively) treated as planning-only for goal execution.
- `allow_goal_execution_from_plan`: `false`; when `true`, disables Plan-mode goal restrictions entirely.
- `question_policy`: `"decide"`; what happens to OpenCode's built-in `question` tool while a goal's status is `active`. `"decide"` blocks the tool and tells the model to pick the answer it would have recommended, say in one line what it chose, and record it as an assumption. `"deny"` blocks the tool and tells the model not to guess: resolve it from the worktree and the objective, or close the goal as `unmet` with a concrete blocker. `"allow"` blocks nothing and adds no policy text. An absent or unrecognized value falls back to `"decide"`. See [Questions while a goal is active](#questions-while-a-goal-is-active).

## Goal Workflow

Use `/goal <objective>` in a fresh OpenCode chat to create a long-running goal:

```text
/goal review the frontend and translate visible English UI text to Spanish
```

Bare `/goal` reports the current goal state. `/goal history` reports lifecycle history and recent checkpoints. `/goal edit <objective>` updates the current objective. `/goal pause` pauses the goal without clearing it, and `/goal resume` resumes it. `/goal clear` clears the goal; `/goal stop`, `/goal off`, `/goal reset`, `/goal none`, and `/goal cancel` are clear aliases. The TUI also includes a `Goal` command-palette entry for viewing, refreshing, pausing, resuming, showing history, or clearing the current goal state without creating a new goal.

You can also ask the agent to formulate the objective and call `set_goal` itself, for example: "set your own goal to finish this refactor safely." The tool uses the agent-written objective but still only creates a goal when explicitly requested.

When writing the objective, include the scope, non-goals, and verification path when they matter. The agent is reminded to audit real files, command output, tests, or PR state before closing the goal.

The `update_goal` tool can close a goal in two ways:

- `status: "complete"` with `evidence` when every requirement is actually achieved.
- `status: "unmet"` with `blocker` when the objective cannot be achieved or is blocked by missing external input.

The plugin also uses safety states while keeping the goal available for review or resume:

- `budgetLimited` when a token budget is exhausted.
- `usageLimited` when an auto-turn or elapsed-time budget is exhausted.
- `paused` when the user pauses, auto-continue repeatedly fails, or repeated low-progress goal continuation turns are detected. No-progress accounting is scoped to goal continuation turns: each reserved continuation is evaluated once, when its turn completes, and unrelated assistant activity in the session never pauses the goal.

When a safety limit is reached, the plugin sends one wrap-up prompt asking for a concise handoff instead of silently continuing forever.

### Extending A Goal That Hit A Limit

A safety limit is adjustable, not terminal. `update_goal_limits` edits a non-closed
goal's limits in place, keeping its `history`, `checkpoints`, `createdAt`, and
elapsed accounting — the four things `clear_goal` + `create_goal` throws away.

Each limit takes **either** an absolute value **or** an increment, never both in
one call:

| Argument | Effect |
| --- | --- |
| `max_duration_seconds`, `token_budget`, `max_auto_turns` | Set the cap absolutely. `null` removes the cap entirely. |
| `additional_seconds`, `additional_tokens`, `additional_auto_turns` | Raise the cap by that much above **whichever is larger, the cap or the amount already used**. |
| `reset_elapsed` | Opt-in. Zeroes the elapsed clock so the goal starts a fresh one. |

The increment anchors on usage rather than on the cap because an overrun goal is
the normal case. A goal stopped at 42478s elapsed against a 36000s cap gains
nothing from `36000 + 3600`; the result is still below the elapsed value and the
goal re-limits on the next continuation. Anchoring on the larger of the two always
buys the full runway asked for.

`update_goal_status` accepts the same three increments, so raising a cap and
resuming is one call:

```jsonc
// Refused: elapsed already exceeds the cap, so resuming would re-limit at once.
{ "status": "active" }
// → { "resume_refused": true, "limited_by": "duration",
//     "exhausted_limits": [{ "kind": "duration", "used": 42478, "cap": 36000 }] }

// Buys 2h of runway and resumes in the same call.
{ "status": "active", "additional_seconds": 7200 }
```

Resuming a goal whose limit is already exhausted is **refused** rather than
accepted-then-reverted. Earlier versions flipped the goal to `active` for one
instant and re-limited on the next continuation, which reported a resume that
never happened. Every goal snapshot now carries `exhaustedLimits`, `limitKind`,
and `remainingSeconds` so the exhausted cap can be identified without parsing
`stopReason`. `limitKind` is derived on read and never persisted: `status` stays
the same six values it has always been, so a state file written by this version
still loads in an older plugin.

`snapshot_goal` exports the whole goal as markdown — the objective verbatim, plus
limits, usage, checkpoints, and full history — for preserving state before any
destructive change.

## Questions While A Goal Is Active

OpenCode ships a built-in `question` tool: the model calls it to ask you something mid-turn, and the turn blocks until a human answers. A goal is built to run unattended across many auto-continued turns, so one question call parks the whole goal until somebody happens to look at the terminal. While a goal's status is `active`, the plugin suppresses that tool and tells the model what to do instead. `question_policy` chooses which instruction it gets:

- `"decide"` (the default) — the model picks the answer it would have recommended, says in one line what it chose and why, records it as an assumption in its turn summary, and keeps working. An assumption you can correct afterwards is worth more than a stalled goal.
- `"deny"` — the model is told not to guess. It resolves the ambiguity from the worktree and the objective, and if it is genuinely at an impasse it closes the goal with `update_goal` status `"unmet"` and a concrete blocker.
- `"allow"` — the pre-existing behavior: nothing is blocked and no policy text is added.

`opencode.json`:

```json
{
  "plugin": [
    [
      "./node_modules/@sblattj/opencode-goal-plugin/dist/server.js",
      {
        "question_policy": "deny"
      }
    ]
  ]
}
```

The policy only applies to an `active` goal. A paused, budget-limited, usage-limited, complete, or unmet goal — and any session with no goal at all — asks questions exactly as it did before, because those are the states where you are back in the loop.

Enforcement is layered. The policy text is appended to the goal-mode system reminder, and that is the only part that tells the model what to do *instead* of asking. On OpenCode 2 the `question` tool is then dropped from the tool set offered to the session, so the model never sees it. OpenCode 1 cannot hide a tool per session, so the call is blocked instead: the plugin throws from the `tool.execute.before` hook, and the thrown text — carrying the same instruction — is what comes back to the model as the failed tool's error.

If you never want questions at all, goal or no goal, you do not need this plugin for it. OpenCode's own config takes `"permission": {"question": "deny"}` (or the equivalent `"tools": {"question": false}`), globally or per agent. That is the blunter instrument: it is unconditional, and it answers the model with a bare `Permission denied: question` rather than telling it what to do instead. `question_policy` exists for the case where you want questions back the moment the goal is paused.

Every block is recorded. It increments a `questionsSuppressed` counter on the goal and writes a history entry naming the blocked question, so `get_goal` and `get_goal_history` show what the agent wanted to ask before it decided for itself, and the goal snapshot carried through compaction reports `Questions suppressed: N`.

## Plan Mode Safety

OpenCode Plan mode is a user-controlled safety boundary, and goal mode must not become an escape hatch out of it. The plugin enforces that boundary in several layers:

- Goals created with `create_goal` or `set_goal` from the `plan` agent are recorded as `paused` with stop reason `plan mode`, never as active implementation goals. The tool response tells the agent to ask the user to switch to Build mode and resume the goal.
- Automatic idle continuation is suppressed while the last user prompt or the latest assistant turn came from a restricted agent. If a previously active goal idles under Plan mode, it is paused visibly instead of continuing autonomously.
- Resuming a goal (`update_goal_status` with `active`, or `update_goal_objective` with `status: "active"`) is refused from Plan mode, so a prompt-injected instruction inside repository content cannot self-escalate a planning session into Build-mode execution. Switching to Build mode and resuming is an explicit user action; resuming from Build updates the tracked agent so continuation restarts pinned to Build.
- Continuation prompts are pinned to the agent recorded from the last user prompt (`body.agent`), so auto-continue never silently switches the session to a different agent or mode.
- Every session receives the same compact Goal Mode system policy, regardless of whether a goal exists or which lifecycle state it is in. Dynamic objectives, limits, counters, and stop details stay in goal-tool results, continuation prompts, and compaction context; Plan-mode and safety-limit enforcement remains server-side.

The set of planning-only agents is configurable with `restricted_agents` (default `["plan"]`). Setting `allow_goal_execution_from_plan` to `true` opts out of all of these restrictions; the secure default is `false`.

## State

Goal state is stored at:

```text
$XDG_DATA_HOME/opencode-goal-plugin/goals.json
```

If `XDG_DATA_HOME` is not set, the default is:

```text
~/.local/share/opencode-goal-plugin/goals.json
```

Set `OPENCODE_GOAL_STATE_PATH` to use a custom file.

That directory name comes from a literal in `src/state.ts`, not from the package name, so it is
unchanged by this fork's rename. An existing install's goal state carries over as is.

The state file is written atomically through a same-directory temp file: the final path is only ever replaced by a fully-flushed file, so after a crash the state is the previous or the new valid version, never a torn one. The file is created with owner-only permissions where the host filesystem supports them, and the temp name is a random UUID opened exclusively so concurrent writers cannot collide.

Ordinary fsync improves crash consistency but is not `F_FULLFSYNC`, so sudden power loss on macOS/APFS is not an absolute durability guarantee; where the platform cannot fsync the parent directory, a crash may leave the old or the new state file (both valid), never a partially-written one. Existing active goals recover from disk with their full objective, budget, history, and checkpoint metadata.

If the rename succeeds but syncing the parent directory reports a genuine I/O error, the mutation reports a write failure even though the new valid state may already be present. This avoids claiming durability that the filesystem did not confirm.

## Attribution And Licence

This project is a hard fork of
[`prevalentWare/opencode-goal-plugin`](https://github.com/prevalentWare/opencode-goal-plugin), created
and originally authored by **Prevalentware**. Essentially all of the design and implementation in this
repository — goal lifecycle, tools, persistence, Plan-mode safety, the TUI indicator, the tests, and
this documentation — is their work. The fork adds one behavioural fix and the packaging changes
described in [What this fork changes](#what-this-fork-changes).

It is a *hard* fork rather than a GitHub fork: the history was cloned into a fresh repository. Upstream
remains wired up as the `upstream` git remote, so changes can be pulled forward with
`git fetch upstream && git merge upstream/main`.

The upstream project is MIT licensed, and this fork stays MIT licensed. The [`LICENSE`](LICENSE) file is
unmodified and still carries the original copyright notice, as the MIT licence requires. Nothing here
implies that Prevalentware endorses, reviewed, or supports this fork. **Bugs found in this fork belong
in [this repository's issue tracker](https://github.com/sblattj/opencode-goal-plugin/issues), not
upstream's.**

## Credits

- **Prevalentware** — original author of `prevalentWare/opencode-goal-plugin`, which this repository forks.
- This plugin follows Codex's native goal-mode semantics where OpenCode plugin hooks allow it.
- Several hardening ideas were adapted from William Ricchiuti's [`willytop8/OpenCode-goal-plugin`](https://github.com/willytop8/OpenCode-goal-plugin), especially lifecycle history, checkpoints, no-progress safeguards, budget wrap-up behavior, and strict-provider-safe system prompt merging. Thank you, William.

## Development

```bash
bun install
bun run test
bun run lint
bun run typecheck
bun run build
```

`bun run build` writes `dist/server.js`, which is **committed on purpose**: OpenCode and Bun run no build
step on a `github:` or file-path install, so the bundle has to be in the repository. Rebuild and commit
`dist/server.js` in the same change whenever `src/server.ts` or its imports change.

## Releases

Releases are cut as [GitHub releases](https://github.com/sblattj/opencode-goal-plugin/releases) and
described in [`CHANGELOG.md`](CHANGELOG.md). The artifact is the committed, self-contained
`dist/server.js` — point OpenCode's `plugin` array at it, or at a checkout of the tag you want.

**On version numbers.** This fork carries upstream's full history, so `git tag` in a local clone lists
upstream's `v0.1.x` tags. None of them were ever releases of *this* repository, and none were pushed
here — `git ls-remote --tags origin` was empty until `v0.2.0`. **`0.2.0` is this fork's first
release**, numbered above every inherited tag so the two lines cannot collide or be confused.

This fork does not publish to npm; there is no `@sblattj/opencode-goal-plugin` package on the
registry, and installs come from this repository directly. The inherited `publish.yml` workflow
targets npm and is now `workflow_dispatch` only — a push-triggered run could only ever fail. Running
it would need both an npm package and a Trusted Publisher configured against
`sblattj/opencode-goal-plugin`; treat it as inactive. Typecheck, lint and tests still run on every
pull request via `ci.yml`.

## Report A Bug Or Contribute

- **Bugs and feature requests:** open an issue at
  [`sblattj/opencode-goal-plugin/issues`](https://github.com/sblattj/opencode-goal-plugin/issues/new/choose).
  Include your OpenCode version, how you installed the plugin, and reproduction steps.
- **Security issues:** do not open a public issue. See [SECURITY.md](SECURITY.md).
- **Pull requests:** see [CONTRIBUTING.md](CONTRIBUTING.md) for the local gates and code style.
- **Bugs that also exist upstream:** they are welcome here, but the upstream project is the right place
  to get them fixed for everyone — please report those to
  [`prevalentWare/opencode-goal-plugin`](https://github.com/prevalentWare/opencode-goal-plugin/issues)
  as well.

## Notes

OpenCode plugin modules are target-specific. This package exports separate modules for server hooks/tools and TUI UI:

```json
{
  "exports": {
    "./server": "./dist/server.js",
    "./tui": "./src/tui.ts"
  }
}
```

Codex goal mode has deeper runtime integration for thread lifecycle control. This plugin implements the same workflow using OpenCode plugin hooks. Token usage is read from OpenCode step-finish usage when available and falls back to message token metadata or text estimation when exact usage is unavailable. Continuation is driven by OpenCode idle events, including `session.idle` and `session.status` idle notifications. The optional `max_turn_time` watchdog can retry one goal continuation prompt when a model turn remains busy, without consuming the goal's auto-turn, no-progress, or prompt-failure budgets. By default, continuation is deferred while OpenCode Task child sessions are active or their terminal result still needs an orchestrator turn. During compaction, the plugin disables OpenCode's generic synthetic auto-continue while an active goal exists so the goal-specific continuation prompt remains authoritative, and — in this fork — schedules its own recovery continuation so the goal is not stranded.

The goal sidebar shows the current status, elapsed time, token usage, auto-continue count, latest checkpoint, latest status message, stop reason, and objective when a goal is active, paused, or safety-limited. Closed goals remain visible briefly through the latest tool state as achieved or unmet.
