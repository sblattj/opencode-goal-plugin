# Agent Notes

## Project Shape

This package is an OpenCode plugin with separate server and TUI entrypoints:

- `src/server.ts` is the server plugin. It registers the `/goal` command, goal tools, chat/session hooks, usage accounting, compaction context, and idle auto-continuation.
- `src/state.ts` owns goal persistence and lifecycle state. It stores JSON at `OPENCODE_GOAL_STATE_PATH` when set, otherwise under the user's OpenCode data location.
- `src/tui.ts` is the Solid/OpenTUI sidebar and command-palette UI. It is exported as source, so avoid adding heavy runtime dependencies here unless there is a strong reason.
- `src/prompts.ts` contains the goal-mode continuation/system/compaction prompts.
- `test/` covers state, server hooks/tools, and TUI behavior with Bun tests.

## Change Guidelines

- Preserve the public Promise-based state API (`getGoal`, `createGoal`, `completeGoal`, etc.) because OpenCode hooks and tests call it directly.
- Keep `zod` for OpenCode tool argument schemas unless the OpenCode plugin API explicitly supports another schema format.
- Effect is intentionally used in the state/persistence boundary. Do not spread Effect into the TUI unless the benefit clearly outweighs the extra runtime footprint.
- If server code imports a runtime dependency that should be resolved from `dependencies`, externalize it in the Bun build script so the package does not silently bundle it.
- State writes should remain atomic: write to a temp file, then `rename` into place.
- Use `OPENCODE_GOAL_STATE_PATH` for tests and smoke runs so you do not touch a real user's goal state.

## Local Validation

Before treating a code change as complete, run the relevant checks. For release-level changes, run the full local gate:

```bash
bun run lint
bun run typecheck
bun run test
bun run build
bun run pack:dry-run
```

`bun run build` writes `dist/server.js`. That built file is **committed on purpose** — this fork is installed straight from the repository (`bun add github:sblattj/opencode-goal-plugin` or a file path), and no build step runs on install. Rebuild and commit `dist/server.js` in the same change whenever `src/server.ts` or its imports change. `files` lists `dist`, `src/tui.ts`, `LICENSE`, and `README.md`, so `npm pack --dry-run` still shows what a package install would carry.

## Publishing Flow

This fork publishes nothing to npm. `main` is the release: an install resolves whatever `dist/server.js` is committed there. `.github/workflows/publish.yml` is `workflow_dispatch` only and publishes nothing on its own — there is no `@sblattj/opencode-goal-plugin` npm package and no Trusted Publisher configured for this repository. Typecheck, lint and tests still run on every pull request via `ci.yml`.

## End-To-End Plugin Test

To test this plugin end to end, do not stop at unit tests. Run the local gates first: `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`, and `bun run pack:dry-run`.

Then install the built tree in a temp OpenCode project. OpenCode's `plugin` array takes neither `github:` nor a bare package name (both fail to resolve — see `HANDOFF.md` §4), so vendor it with Bun:

```bash
SMOKE="$(mktemp -d)"; ISO="$(mktemp -d)"; mkdir -p "$ISO/cfg"
cd "$SMOKE" && echo '{"name":"smoke","version":"1.0.0"}' > package.json
bun add github:sblattj/opencode-goal-plugin
cat > "$ISO/only.json" <<EOF
{ "\$schema": "https://opencode.ai/config.json",
  "plugin": ["$SMOKE/node_modules/@sblattj/opencode-goal-plugin/dist/server.js"] }
EOF
```

**Do not write an `opencode.json` into the smoke project, and do not run bare `opencode`.**
OpenCode's `plugin` array is a *union across every config source it finds*, so the run
would load this build **and** whichever build the machine's global config points at — two
plugins registering the same tool names, with the wrong one able to answer. A smoke test
contaminated this way looks exactly like a clean one. Three sources have to be silenced,
and each needs a different lever:

| Source | Lever |
| --- | --- |
| `$XDG_CONFIG_HOME/opencode/opencode.json` | `XDG_CONFIG_HOME` pointed at an empty tree |
| Whatever `$OPENCODE_CONFIG` names — **often already exported by a shell profile** | `OPENCODE_CONFIG` pointed at your own file (or `env -u`) |
| A project `opencode.json` in the cwd | Do not create one; put the path in your config file instead |

`OPENCODE_CONFIG_DIR` *adds* a source rather than redirecting one, and
`OPENCODE_CONFIG_CONTENT` merges at local scope. Neither isolates.

Prove the isolation before trusting the run — and read it from a **file**, because
`opencode debug config` truncates at exactly 64 KiB through a pipe (its output embeds the
resolved agent prompts), so piping it into `jq` or `python3` dies with a JSON error that
reads like a broken command:

```bash
cd "$SMOKE"
env OPENCODE_CONFIG="$ISO/only.json" XDG_CONFIG_HOME="$ISO/cfg" \
  opencode debug config > "$ISO/cfg.json"
python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(len(d["plugin"]),"plugin(s)");[print(" ",o["spec"],"<-",o["source"]) for o in d["plugin_origins"]]' "$ISO/cfg.json"
```

`plugin` must hold **exactly one** entry and `plugin_origins` must name your config as its
source. Re-run without the two env vars as a control: it must come out *different* (the
global build's path). If both look the same, the check cannot fail and proves nothing.

Then run the smoke test with the same two variables plus an isolated state file:

```bash
env OPENCODE_CONFIG="$ISO/only.json" XDG_CONFIG_HOME="$ISO/cfg" \
  OPENCODE_GOAL_STATE_PATH="$ISO/goals.json" \
  opencode run "/goal create a smoke-test goal and then report the current goal state"
```

The smoke test should show `create_goal` and `get_goal` tool calls and report an active goal. Inspect the state file afterward if you need to confirm JSON persistence.
