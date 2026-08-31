# HANDOFF — why this fork exists, and what's left to do

**Repo:** `sblattj/opencode-goal-plugin` (**public** since 2026-08-28; it was created private)
**Upstream:** `prevalentWare/opencode-goal-plugin` (MIT) — kept as the `upstream` git remote
**Created:** 2026-08-28
**Status:** **the compaction-recovery fix is APPLIED, built, and shipped to `main`** (`e4adfab`,
2026-08-28), and OpenCode on this host is wired to it. What remains for that fix is the optional
upstream PR and a live behavioural confirmation — see §6. **A second, independent stranding
mechanism — a task-deferral gate that could dead-stop auto-continue with no compaction
involved — was diagnosed and fixed in `0.3.4`. See §9.**

This is a **hard fork**, not a GitHub fork. It was created private, and GitHub forks of a public repo
cannot be made private, so the history was cloned and pushed to a fresh repo (`isFork=false`). The repo
has since been made **public**, but it remains a hard fork rather than a GitHub fork. Upstream is still
wired up, so syncing later is `git fetch upstream && git merge upstream/main`.

---

## 1. The bug

An **active goal stops auto-continuing after auto-compaction**, silently — no error in
`~/.local/share/opencode/log`, the session just stops making progress.

The plugin deliberately suppresses OpenCode's native post-compaction "continue" turn so its own
goal-specific continuation prompt stays authoritative. In this tree that is:

```ts
// src/server.ts — the "experimental.compaction.autocontinue" hook (v1 `server` export)
async "experimental.compaction.autocontinue"(input, output) {
  const goal = await getGoal(input.sessionID)
  if (goal?.status === "active") output.enabled = false
},
```

Having suppressed the native resume, the plugin relies on a `session.idle` event to drive
`runAutoContinue()`. After a *suppressed* compaction no idle event arrives, so `runAutoContinue()`
never runs — and it is the only path that both (a) clears the stranded
`awaitingContinuationProgress` flag (via `recordAssistantMessage(..., evaluateContinuation=true)`)
and (b) reserves the next continuation. The event-only paths call `recordAssistantMessage`
*without* `evaluateContinuation`, so they clear `pendingAttempt` but never clear `awaiting`. That
asymmetry is why the flag strands.

**Observed evidence** (live state in `~/.local/share/opencode-goal-plugin/goals.json`, 2026-08-28):
an active goal with `awaitingContinuationProgress: true` but `pendingAttempt: null`, `autoTurns`
frozen at 1 across ~9 minutes of real work and logged checkpoints, `lastAssistantMessageID` ahead of
`continuationBaselineMessageID` (so work *had* happened), ~4.97M tokens used (many compactions), and
no errors anywhere.

**Correction (2026-08-30):** the premise in the paragraph above — that suppressing OpenCode's
native post-compaction continue (`output.enabled = false`) also suppresses the `session.idle`
event — is **host-traced FALSE**. Traced end to end against opencode's own source: the compaction
task's loop-exit lives in `session/compaction.ts`, whose `enabled: false` branch simply skips
adding a synthetic continuation message and falls through to `"continue"`; back in
`session/prompt.ts`'s turn loop, with nothing new queued the ordinary turn-exit condition fires on
the very next check — the same branch that ends *any* normal turn; and the runner's own
`onExit`/`finishRun` path (`session/run-state.ts` → `effect/runner.ts`) publishes `session.status`
(idle) and the legacy `session.idle` exactly as it does after every other turn, compaction or not.
Disabling native autocontinue removes only the extra in-window continuation turn; it never touches,
gates, or bypasses idle publishing. So the 0.2.0 recovery re-arm this section documents, and the
0.3.1–0.3.3 fixes that hardened it (purpose bookkeeping, replace semantics, bounded-retry
displacement — see CHANGELOG), remain real and are **not reverted or weakened** by this
correction: they fixed genuine bugs in the recovery-timer mechanism 0.2.0 introduced. What is
corrected is only the *reason it was believed necessary* — and, more importantly, the belief that
compaction-purpose bookkeeping was the *sole* stranding mechanism for auto-continue. It was not:
`0.3.4` found and fixed a second, unrelated stranding family in the task-deferral gate that strands
auto-continue on ordinary idle boundaries, with no compaction involved at all. See §9.

## 2. The fix (applied in `e4adfab`)

Keep the author's intent — native autocontinue stays suppressed — but **guarantee a trigger**, by
scheduling a `"recovery"` continuation straight from the compaction hook. This mirrors the
`session.error` recovery pattern already in the same file.

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
+            false,
+            "recovery",
+          )
+      }
     },
```

Why it is safe: the scheduled timer fires `runAutoContinue()` once the turn settles, which clears
the stranded `awaiting` flag and reserves a fresh continuation. `scheduleSettledContinuation(…,
false, …)` will not stack on an existing scheduled continuation, and `reserveContinuation`'s
`min_continue_interval` guard prevents a double-continue. All four identifiers (`autoContinue`,
`minInterval`, `scheduleSettledContinuation`, `continuationDelayFromSnapshot`) are already in scope
in `src/server.ts` — verified in this tree, not assumed. `continuationDelayFromSnapshot` tolerates a
missing `lastContinuationAt` and falls back to a short settle delay.

**Rejected alternative, do not do it:** also clearing `awaiting` in the event-only
`recordAssistantMessage` path. That would disable the legitimate `max_no_progress_turns` auto-pause
safety feature.

## 3. Build and ship it (done)

```bash
bun install
bun run build      # bun build ./src/server.ts --outdir ./dist --target bun --external @opencode-ai/plugin --external effect --external zod
bun test
bun run typecheck
node --check dist/server.js
```

**`dist/` is gitignored in this tree and MUST be committed here.** OpenCode installs plugins with
Bun, Bun does **not** run a build on a `github:` install, and `package.json` maps
`exports["./server"] → ./dist/server.js`. So a `github:` install of this fork resolves to a missing
file unless the built bundle is in the repo:

Result on 2026-08-28: `bun test` 213 pass / 0 fail, `tsc --noEmit` clean, `eslint`
clean, `node --check dist/server.js` clean, and `grep scheduleSettledContinuation
dist/server.js` shows the scheduled recovery call inside the compiled compaction
hook. Committed as `e4adfab` on `main`.

**Correction to the paragraph above:** `dist/server.js` was ALREADY tracked in this
tree (committed upstream in `2aabd27`, `8acc2e4`, `27b8d32`), so the `github:`
install was never actually resolving to a missing file, and the `git add -f` was
unnecessary. `.gitignore`'s `dist/` line only ever suppressed *untracked* files, so
its real effect was to hide future `dist/` changes from `git status`. The line was
removed anyway — that is the right cleanup.

Note the version number history. `package.json` said `0.1.1` while upstream's npm package shipped
`0.1.39`, because upstream's published version is computed in CI by `scripts/resolve-ci-version.ts` —
the in-repo number was never upstream's release number. **Superseded 2026-08-29:** the fork now cuts
its own GitHub releases, so the number is no longer inert. It is `0.2.0`, set deliberately above every
inherited `v0.1.x` tag so the fork's line cannot collide with or be mistaken for upstream's. Those
inherited tags are local-only — `git ls-remote --tags origin` is empty — and this repository had no
releases at all before `v0.2.0`. See `CHANGELOG.md`.

## 4. Point OpenCode at this fork (done on this host)

Two things the original version of this section got wrong, both found by
`opencode debug config` rather than by reasoning:

**`github:` in OpenCode's `plugin` array does not work — for two different reasons,
one of which is now fixed.** While the repo was private, Bun could not resolve it at
all, through an unauthenticated GitHub API call:

```
$ bun add github:sblattj/opencode-goal-plugin
error: GET https://api.github.com/repos/sblattj/opencode-goal-plugin/tarball/ - 404
error: github:sblattj/opencode-goal-plugin failed to resolve
```

That half is fixed: now that the repo is public, `bun add github:sblattj/opencode-goal-plugin`
succeeds and installs the built bundle.

But OpenCode's own plugin resolver still cannot take it (verified on OpenCode 1.18.19,
2026-08-28 — corrected 2026-08-30 from a mistaken 1.18.23; see the version-history note in §9). `"plugin": ["github:sblattj/opencode-goal-plugin"]` is accepted into the
resolved config and then produces
`~/.cache/opencode/packages/github:sblattj/opencode-goal-plugin/` containing only a
partial dependency tree — no `package.json`, no installed package, no `dist/server.js`.
The package-name form fails too: `"plugin": ["@sblattj/opencode-goal-plugin"]` makes
OpenCode try an **npm** install into its own cache instead of reading the project's
`node_modules`, which 404s and leaves an empty
`~/.cache/opencode/packages/@sblattj/opencode-goal-plugin@latest/`.

So the file-path form is the one in use — which is also the fastest way to
iterate:

```jsonc
"plugin": ["/Users/<you>/code/opencode-goal-plugin/dist/server.js"]
```

**OpenCode MERGES its config files, and for an array key it concatenates.** On
this host `$OPENCODE_CONFIG` points at `~/.dotai/adapters/opencode/opencode.jsonc`,
but `~/.config/opencode/opencode.json` also carried a `plugin` entry, and the
resolved config contained BOTH — the patched fork *and* the unpatched npm package,
two copies of the same plugin. Changing only one file is not enough. Check the
resolved value, never the file you edited:

```bash
opencode debug config | python3 -c "import json,sys; print(json.load(sys.stdin)['plugin'])"
# -> ['file:///Users/<you>/code/opencode-goal-plugin/dist/server.js']    # exactly one entry
```

## 5. Two loose ends

- **The temporary cache hotfix is already gone.** Checked 2026-08-28: the cached bundle
  (`~/.cache/opencode/packages/@prevalentware/opencode-goal-plugin@latest/.../dist/server.js`,
  mtime Aug 24) has the *unpatched* hook — `output.enabled = false` and nothing else. A cache
  refresh ate the hotfix, which is precisely the failure mode this fork exists to escape.
  Nothing to clean up.
- **Upstream PR — still open, deliberately.** The fix belongs upstream so the fork can eventually
  be dropped. Suggested title: *"Active goals stop auto-continuing after auto-compaction (native
  autocontinue suppressed, no idle trigger)."* Include the §1 evidence. Not opened here because
  a PR against a third-party public repo is an outward-facing act that is the repo owner's call,
  not an agent's.

Unrelated housekeeping seen on the same machine: `~/.local/share/opencode-goal-plugin/` accumulates
orphaned `goals.json.*.tmp` files (atomic-writer temps left by hard-killed processes sharing one
global `goals.json`). `find ~/.local/share/opencode-goal-plugin -name 'goals.json.*.tmp' -delete`
— run 2026-08-28, removed 0 files; the directory holds only `goals.json`.

## 6. What is left

1. **Behavioural confirmation.** Everything so far proves the patched bundle is the
   one OpenCode resolves and that it imports cleanly with the compaction hook present
   (`bun -e` import shows `{id, server, setup}`, `id: local.goal-mode.server`, and the
   hook in the v1 `server` source). What has NOT been observed is a real goal surviving
   a real compaction. To close it: start a goal, let context grow until compaction fires,
   and confirm `autoTurns` keeps incrementing in
   `~/.local/share/opencode-goal-plugin/goals.json`.
2. **The upstream PR**, per §5.

### Scope note the original handoff missed: v1 vs v2

`src/server.ts` exports two implementations — `export default { id, server, setup: setupV2 }`.
`"experimental.compaction.autocontinue"` is registered **only** in the v1 `server` export;
`setupV2` registers tool/session hooks and an event subscription and never registers a
compaction hook, so there is no equivalent bug there. Which one runs matters, and it resolves
cleanly — but not for the reason originally given here.

**Correction (2026-08-30):** the original version of this note argued the v1 path is live
because the package's runtime dependency is `@opencode-ai/plugin ^1.17.1` while `setupV2` is
written against `@opencode-ai/plugin-v2`, a prerelease kept only as a devDependency, and cited
the host as OpenCode **1.18.23**. Both the host version and the mechanism were wrong. The host
measured directly (a dogfooding session, 2026-08-30) runs **1.18.19**, and the real mechanism —
traced against opencode's own plugin loader source, not inferred from `package.json` — is the
**loader**, not the dependency graph: OpenCode's legacy plugin loader reads only `mod.default`,
detects the shape `{id, server, tui}`, and invokes `.server` — it never reads `.setup`
(`readV1Plugin` in opencode's `plugin/shared.ts`, called from `applyPlugin` in
`plugin/index.ts`). A plain string entry in the config's `plugin` array — the form this fork's
README instructs — always resolves and loads with `kind: "server"`, which is exactly the code
path that ignores `.setup`. `.setup` is read only by a second, independent loader — the
always-on v2 "config-plugin" loader (`packages/core/src/config/plugin/external.ts`) that boots
unconditionally on every location, not behind any version gate. That loader *does* re-import
this exact `dist/server.js` a second time and does attempt to decode it against its own schema
(`{id, effect}` or `{id, setup}`), but the module only exports `{id, server, tui}`, so the
decode fails and the whole per-plugin attempt is silently swallowed
(`Effect.ignoreCause`) — no v2 hook registration happens, and no error surfaces anywhere a
plugin author would see it. Net effect matches the original note's conclusion (`setupV2` is
unreachable, v1 `server` is the live export) — the dependency-version argument just never
established it; it happened to land on the right answer by an unverified route. Two entrypoint
imports per location boot, one of which always no-ops for this plugin, is worth knowing if
`dist/server.js` ever grows import-time side effects.

---

| Item | Value |
|---|---|
| This repo | `sblattj/opencode-goal-plugin` (public, hard fork) |
| Upstream | `prevalentWare/opencode-goal-plugin` (MIT), remote `upstream` |
| File edited | `src/server.ts` — the `"experimental.compaction.autocontinue"` hook (v1 `server` export only) |
| Build | `bun run build` → `dist/server.js` (must be committed here) |
| Wire-up | local file path — OpenCode's `plugin` array takes neither `github:` nor a bare package name |
| State file | `~/.local/share/opencode-goal-plugin/goals.json` |

---

## 7. `question_policy` — no questions while a goal is active (2026-08-29)

**Ask:** while a goal is active, opencode should stop asking the user questions — or, if it is
about to, be told to recommend an answer and go with it.

**Shipped:** a `question_policy` option, `"allow" | "decide" | "deny"`, defaulting to `"decide"`.
It is in force only while `goal.status === "active"`; a paused, limited, or closed goal — or a
session with no goal — asks questions exactly as before. README documents it under
*Questions While A Goal Is Active*.

### What was proven, and how

The design turned on two questions about opencode 1.18.19 (misreported as 1.18.23 when this
section was written; corrected 2026-08-30, see the version-history note in §9) that could not
be answered from the plugin API types. Both were settled against the shipped binary and a live
run, not inferred.

1. **Throwing from `tool.execute.before` is safe and the message reaches the model.** The bundle's
   hook dispatcher has no try/catch (`for (let H of B.hooks) { ... yield* v.promise(async () => V(K,U)) }`),
   so the rejection travels out of the tool's `execute` into the ai-sdk tool executor, which turns
   it into a `tool-error` part carrying `error.message`. Confirmed live: a throwaway plugin that
   throws for the `read` tool produced `✗ Read hello.txt failed`, the model quoted the thrown
   message back verbatim, and `opencode run` exited **0**. The turn survives; one tool call fails.
2. **The end-to-end behaviour is what was asked for.** A real `opencode run` against the built
   plugin, with a goal set and the policy at its default, answered:
   *"with the goal now active the question policy blocks asking entirely (this goal runs
   unattended). Per that policy, I decided instead: sort by name (stable, conventional default).
   Assumption recorded — say the word and I'll switch to date."*

### Two mechanisms were rejected, both for the same reason

Neither can be made conditional on *this session's* goal, so neither can lift when a goal pauses.

- **Registering a plugin tool with the id `question`.** It does override the built-in — the registry
  is an object keyed by tool id and the plugin entry is appended last, so it simply wins, with no
  collision check. But plugin tools are registered once per process, so it would replace the tool in
  every session.
- **The `permission.ask` hook.** Written, then removed. It is *unreachable*: the runtime fires
  `tool.execute.before` and only then the tool's own `execute`, and the question permission assert
  lives inside that `execute`, so the throw always pre-empts it. It is also the wrong shape — a
  declined permission becomes an Effect defect (`catchTag("PermissionV2.DeclinedError", $ => n.die($))`)
  rather than a recoverable tool error, so denying there risks killing the turn instead of failing
  one call.

Config-level `"permission": {"question": "deny"}` and `"tools": {"question": false}` both exist and
both work; they are unconditional, and they answer the model with a bare `Permission denied:
question` instead of telling it what to do instead. The README points at them for the user who never
wants questions at all.

### Enforcement layers

| Layer | v1 | v2 |
|---|---|---|
| Policy text in the system reminder | ✅ `experimental.chat.system.transform` | ✅ `session.hook("context")` |
| Tool hidden from the model | ✗ no per-session tool list | ✅ `delete sessionContext.tools.question` |
| Call blocked | ✅ throw from `tool.execute.before` | ✅ throw from `tool.hook("execute.before")` |

The v1/v2 args shape differs and is easy to get wrong: v1 reads `output.args`, v2 reads `input.input`.

### Audit trail

Every block increments `goal.questionsSuppressed` and writes a history entry naming the question.
The history entry deliberately reuses the existing `"warning"` type: adding a literal to the history
union would make a newer state file undecodable by an older plugin, and `readStateEffect` only falls
back to an empty state on `ENOENT` — a `StateDecodeError` re-raises, so every read would fail and a
downgraded plugin would see no goals at all. The counter is a plain number, which Effect Schema
tolerates in both directions.

### Still open

- The **throw** path has not been exercised end-to-end. `opencode run` (the `cli` client) did not
  register a `question` tool at all, so the live probe proved only the prevention layer; the throw
  mechanism itself was proven separately against the `read` tool. Confirming it needs an interactive
  TUI session where the tool exists.
- The probe model reached first for an **`ask-me` skill** before concluding it could not ask. The
  policy text was broadened to name every route to the user, not just the tool, but a skill that
  asks is not blocked by anything — only discouraged.

---

## 8. The plugin was not loading on this host at all (2026-08-29)

Found while verifying §7 end to end, and it invalidates the "wired up on this host" claim in §6.

**Symptom:** a real `opencode run` under the host's own config reported no `set_goal` tool.
`opencode debug config` confirmed it: `plugin_origins` listed the plugin, but the `/goal` command
its `config()` hook registers was **absent** from the resolved config. Against a scratch config
that pointed at a checkout with `node_modules`, the same command **was** present — that control is
what makes this a load failure rather than a quirk of the debug output.

**Cause:** `dist/server.js` was built with `--external effect --external zod`, so it imports both as
bare specifiers and needs a `node_modules` beside it to resolve them. The checkout OpenCode loads
from had none. The plugin failed to load silently — nothing in `~/.local/share/opencode/log`.

This is also why the §6 confirmation was worthless: it checked the module with `bun -e 'await
import(...)'`, and bun resolves a missing bare specifier out of its global install cache. It proved
the file parses, not that OpenCode can load it. **A verification that runs under a more forgiving
resolver than production is not a verification.**

**Fix:** the build no longer externalises the runtime dependencies, so `dist/server.js` is
self-contained (1.37 MB, importing only Node builtins). Nothing beside it has to exist. This fork
is consumed as a local file path and is not published to npm, so there is no consumer who wanted
those dependencies resolved from a package manifest.

`@opencode-ai/plugin` stays external because it is type-only — it does not appear in the bundle's
imports at all.

---

## 9. Task-reconciliation deadlock diagnosed and fixed (2026-08-30, `0.3.4`)

**Version-history note.** §4, the old §6 scope note, and §7 all previously cited the host as
OpenCode **1.18.23**. A 2026-08-30 dogfooding session measured the actual host binary directly:
it is **1.18.19**. All three citations above have been corrected in place; this is the note they
point back to.

**The report.** The same dogfooding session (opencode `1.18.19`, plugin `0.3.3`) ran a goal whose
turns spawned parallel `Task` subagents for roughly four hours across ~10.8M tokens. `autoTurns`
never left 0 — every continuation across the whole session was a human typing "continue," with
`lastContinuationAt: null`, `pendingAttempt: null`, and no errors logged. The report diagnosed a
`terminalUnreconciled` "reconciliation deadlock": a `Task` child settling terminal against the
parent's own *final* assistant message for the turn, then finding nothing newer to reconcile
against, forever — and proposed treating the parent's own `session.idle` as proof the turn was
settled.

**Adversarial verification (read-only, this repo + the opencode host source) refuted the reported
mechanism as stated, while confirming a real and worse defect underneath it.** Reconciliation in
`TaskTracker` fires on *either* a different assistant-message id than the one captured at terminal
time *or* `completedAt >= terminalAt` — not "a newer message," which is what the report assumed.
That means the report's own scenario — an ordinary parallel fan-out, where a child settles against
the still-streaming closing message or mid-turn — is exactly the case that already reconciles,
either immediately or on `runAutoContinue`'s own pre-gate refetch (which already re-fetches and
re-observes the latest assistant message before every gate check — the report's proposed fix was
already, in effect, implemented). The "human `continue` unsticks it" evidence the report leaned on
also does not discriminate: a human prompt bypasses the plugin's gate entirely, so *any* candidate
mechanism recovers on human input. And the report's proof that `runAutoContinue` bailed specifically
at the task gate — "`pendingAttempt: null` proves it never reserved" — does not hold: a reserve
followed by a rollback (from a plan-agent pause, a non-transport send failure, or several other
paths) produces the identical snapshot.

**What was real, and wider than reported.** `taskBlockStatus` can report `blocked` with
`retryAt: null`, and the gate's deferral branch scheduled **nothing** in that case — a genuine,
confirmed dead-stop. `retryAt` turns out to be null far more often than the code implies: the host
deletes an idled session from its own status map the instant it goes idle, so the snapshot-idle-hold
path that would otherwise produce a real `retryAt` almost never engages against a live host. Once
that's traced through, the actual failure family is wider than "terminal task, stale message id":

- A tracked task record stuck at `state: "running"` — set by a session-created or a live-poll
  event, cleared only by reconciliation logic that never touches `state`, never TTL'd, never pruned
  for a child that is still present in the host's own child list. This is the likeliest single
  explanation for `autoTurns: 0` across a full 4-hour session with many human turns: it survives
  every one of them.
- `activeContinuations` is module-level and shared across every session; the v1 `dispose` path
  never cleared it (v2's did). A hung in-flight call, or a dispose while one was in flight, leaves a
  session id gated behind that check permanently — surviving even a plugin reload.
- A non-transport send failure (a bad agent name, a 4xx, a state-write error) rolled back its
  reservation and armed no retry, logging once and then repeating forever with the exact same
  `pendingAttempt: null` snapshot.
- `refreshLiveChildren`'s idle branch is effectively dead against the host's real status API (idle
  sessions are deleted from the map, not reported idle in it), so the tracker could add blocking
  records but essentially never clear one this way.

**The fix, `0.3.4`.** Two invariants now hold everywhere the gate is evaluated: it never defers
without scheduling a re-check (closes the unconditional dead-stop), and no block outlives a bound
unless something genuinely refreshes it (closes the sticky-running and forward-crawling-terminal
cases). Concretely: `TaskRecord` tracks `lastRunningAt` and a `running` record stops blocking once
that goes stale; a `terminalUnreconciled` record stops blocking after a fixed grace period from its
*first* terminal observation, and repeated status-snapshot re-observation is explicitly not new
evidence for that clock (only the tool-output/message-observation channels that already assert
fresh evidence restart it) — `markTerminal` is now idempotent against a repeated snapshot so the
grace clock can't be pushed out forever; a child present in `session.children` but absent from a
successfully-fetched status map is now read as settled instead of ignored; the v2 path gets the
same gate fix plus real-timestamp assistant markers instead of bare ids; v1 `dispose` now clears
`activeContinuations`; non-transport failures retry with a bound instead of stranding silently; and
each deferral streak logs one breadcrumb line naming the blocking tasks and the chosen recheck
delay. Full detail and the exact constants are in `CHANGELOG.md` under `[0.3.4]`.

**What did not change.** The three tests that pin the original design intent —
`test/server.test.ts:1295`, `:1340`, `:1393`, asserting a parent's own idle does not by itself fire
continuation while a task is terminal-unreconciled — pass unmodified. The grace period is a
deliberate, bounded narrowing of that invariant (wait for genuine orchestrator reconciliation for a
few seconds, then stop waiting), not a repeal of it. The `0.2.0`–`0.3.3` compaction-recovery
mechanism (§1–§2, and the purpose-bookkeeping fixes in `0.3.1`–`0.3.3`) is untouched by this fix and
remains necessary on its own terms — see the correction note in §1 for how it relates to, and is
distinct from, this task-deferral fix.
