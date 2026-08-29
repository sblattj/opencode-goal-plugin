# HANDOFF — why this fork exists, and what's left to do

**Repo:** `sblattj/opencode-goal-plugin` (**private**)
**Upstream:** `prevalentWare/opencode-goal-plugin` (MIT) — kept as the `upstream` git remote
**Created:** 2026-08-28
**Status:** repo stood up, upstream history intact, **the fix is NOT applied yet**. That is the next agent's job.

This is a **hard fork**, not a GitHub fork: GitHub forks of a public repo cannot be made private, so
the history was cloned and pushed to a fresh private repo (`isFork=false`). Upstream is still wired
up, so syncing later is `git fetch upstream && git merge upstream/main`.

---

## 1. The bug

An **active goal stops auto-continuing after auto-compaction**, silently — no error in
`~/.local/share/opencode/log`, the session just stops making progress.

The plugin deliberately suppresses OpenCode's native post-compaction "continue" turn so its own
goal-specific continuation prompt stays authoritative. In this tree that is:

```ts
// src/server.ts:1422-1425
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

## 2. The fix to apply

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

## 3. Build and ship it

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

```bash
# drop the `dist/` line from .gitignore, then
git add -f dist/server.js src/server.ts .gitignore HANDOFF.md
git commit -m "fix: schedule a recovery continuation after suppressed compaction so active goals keep going"
git push origin main
```

Note `package.json` says `0.1.1` while npm ships `0.1.39` — the published version is computed in CI
by `scripts/resolve-ci-version.ts`, so the in-repo number is not the release number. Don't "fix" it.

## 4. Point OpenCode at this fork

In the opencode config (`~/.config/opencode/opencode.json`, or wherever `$OPENCODE_CONFIG` points):

```jsonc
"plugin": [
  "github:sblattj/opencode-goal-plugin"          // default branch
  // or pin:  "github:sblattj/opencode-goal-plugin#<tag-or-sha>"
]
```

A private repo needs Bun to be able to authenticate to GitHub — if the install fails, either make
the install use a token Bun can see, or fall back to the **local path** form, which is also the
fastest way to iterate:

```jsonc
"plugin": ["/Users/<you>/code/opencode-goal-plugin/dist/server.js"]
```

Restart OpenCode fully, then prove the patched copy is the one loaded:

```bash
grep -rn 'scheduleSettledContinuation(input.sessionID' ~/.cache/opencode/packages/**/opencode-goal-plugin*/**/dist/server.js
```

**Verify the behaviour, not just the bytes:** start a goal, let the context grow until compaction
fires, and confirm `autoTurns` keeps incrementing in `~/.local/share/opencode-goal-plugin/goals.json`.

## 5. Two loose ends

- **A temporary hotfix may still be applied to the cache** at
  `~/.cache/opencode/packages/@prevalentware/opencode-goal-plugin@latest/node_modules/@prevalentware/opencode-goal-plugin/dist/server.js`.
  It is overwritten whenever OpenCode refreshes the plugin cache — which is the whole reason this
  fork exists. Once the fork is wired in, that hotfix is redundant.
- **Upstream PR (optional, good citizenship):** the fix belongs upstream so the fork can eventually
  be dropped. Suggested title: *"Active goals stop auto-continuing after auto-compaction (native
  autocontinue suppressed, no idle trigger)."* Include the §1 evidence.

Unrelated housekeeping seen on the same machine: `~/.local/share/opencode-goal-plugin/` accumulates
orphaned `goals.json.*.tmp` files (atomic-writer temps left by hard-killed processes sharing one
global `goals.json`). `find ~/.local/share/opencode-goal-plugin -name 'goals.json.*.tmp' -delete`.

---

| Item | Value |
|---|---|
| This repo | `sblattj/opencode-goal-plugin` (private, hard fork) |
| Upstream | `prevalentWare/opencode-goal-plugin` (MIT), remote `upstream` |
| File to edit | `src/server.ts` — hook at **1422-1425** |
| Build | `bun run build` → `dist/server.js` (must be committed here) |
| Wire-up | `plugin: ["github:sblattj/opencode-goal-plugin"]` |
| State file | `~/.local/share/opencode-goal-plugin/goals.json` |
