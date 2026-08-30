import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import plugin from "../src/server"
import { questionBlockedMessage, questionPolicyReminder } from "../src/prompts"
import { getGoal, getGoalInternal, recordContinuationResult, reserveContinuation } from "../src/state"

const TOOL_NAMES = [
  "clear_goal",
  "create_goal",
  "get_goal",
  "get_goal_history",
  "list_all_goals",
  "set_goal",
  "snapshot_goal",
  "update_goal",
  "update_goal_limits",
  "update_goal_objective",
  "update_goal_status",
].sort()

type ToolDraft = {
  add(tool: {
    name: string
    description: string
    input: unknown
    options?: { codemode?: boolean }
    execute: (args: unknown, context: unknown) => Promise<unknown>
  }): void
}

type MockCommandDraft = {
  get(name: string): { name: string; template: string } | undefined
  update(name: string, update: (command: { description?: string; template: string }) => void): void
}

type Registration = { dispose: () => Promise<void> }

function controlledStream() {
  const queue: Array<{ done: boolean; value?: unknown }> = []
  const waiters: Array<() => void> = []
  let ended = false
  return {
    push(value: unknown) {
      if (ended) return
      queue.push({ done: false, value })
      waiters.shift()?.()
    },
    end() {
      if (ended) return
      ended = true
      queue.push({ done: true })
      waiters.shift()?.()
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        const item = queue.shift()
        if (item) {
          if (item.done) return
          yield item.value
          continue
        }
        await new Promise<void>((resolve) => waiters.push(resolve))
      }
    },
  }
}

type MockContext = {
  options: Record<string, unknown>
  promptCalls: Array<{ sessionID: string; text: string; agents?: Array<{ name: string }> }>
  tools: Array<ToolDraft["add"] extends (tool: infer T) => void ? T : never>
  commandDraft: MockCommandDraft
  hooks: Record<string, (input: unknown) => void>
  systemParts: Array<{ type: string; text: string }>
  stream: ReturnType<typeof controlledStream>
  disposals: string[]
  command: {
    transform: (callback: (draft: MockCommandDraft) => void) => Promise<Registration>
  }
  tool: {
    transform: (callback: (draft: ToolDraft) => void) => Promise<Registration>
    hook: (name: string, callback: (input: unknown) => void) => Promise<Registration>
  }
  session: {
    hook: (name: string, callback: (input: unknown) => void) => Promise<Registration>
    prompt: (input: { sessionID: string; text: string; agents?: Array<{ name: string }> }) => Promise<unknown>
  }
  event: {
    subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<unknown>
  }
}

function makeMockContext(options: Record<string, unknown> = {}): MockContext {
  const tools: MockContext["tools"] = []
  const hooks: MockContext["hooks"] = {}
  const promptCalls: MockContext["promptCalls"] = []
  const disposals: string[] = []
  const stream = controlledStream()
  const commandDraft: MockCommandDraft = {
    get: () => undefined,
    update: (name, update) => {
      const command = { name, template: "" }
      update(command)
      commandDraft.get = () => command
    },
  }
  const registration = (name: string): Registration => ({
    dispose: async () => {
      disposals.push(name)
    },
  })
  return {
    options,
    promptCalls,
    tools,
    commandDraft,
    hooks,
    systemParts: [],
    stream,
    disposals,
    command: {
      transform: async (callback) => {
        callback(commandDraft)
        return registration("command.transform")
      },
    },
    tool: {
      transform: async (callback) => {
        callback({ add: (tool) => tools.push(tool) })
        return registration("tool.transform")
      },
      hook: async (name, callback) => {
        hooks[name] = callback
        return registration(`tool.hook:${name}`)
      },
    },
    session: {
      hook: async (name, callback) => {
        hooks[name] = callback
        return registration(`session.hook:${name}`)
      },
      prompt: async (input) => {
        promptCalls.push(input)
        return { id: "pending_1" }
      },
    },
    event: {
      subscribe: () => stream,
    },
  }
}

function toolContext(sessionID = "ses_v2", agent = "build") {
  return { sessionID, agent, messageID: "msg_1", id: "call_1" }
}

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(await predicate()).toBe(true)
}

function goalTool(mock: MockContext, name: string) {
  const tool = mock.tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`expected V2 tool ${name} to be registered`)
  return tool
}

function contentOf(result: unknown) {
  const value = result as { content?: string }
  return typeof value.content === "string" ? value.content : String(result)
}

async function createGoalViaV2Tool(mock: MockContext, objective: string, agent = "build") {
  const tool = goalTool(mock, "create_goal")
  const result = await tool.execute({ objective }, toolContext("ses_v2", agent))
  return result
}

let dir = ""
const setupDisposers: Array<() => void | Promise<void>> = []

async function setupPlugin(...args: Parameters<typeof plugin.setup>) {
  const cleanup = await plugin.setup(...args)
  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    const index = setupDisposers.indexOf(dispose)
    if (index >= 0) setupDisposers.splice(index, 1)
    await cleanup()
  }
  setupDisposers.push(dispose)
  return dispose
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "opencode-goal-plugin-v2-"))
  process.env.OPENCODE_GOAL_STATE_PATH = join(dir, "goals.json")
})

afterEach(async () => {
  for (const dispose of setupDisposers.splice(0).reverse()) await dispose()
  delete process.env.OPENCODE_GOAL_STATE_PATH
  await rm(dir, { recursive: true, force: true })
})

test("default export exposes both V1 server and V2 setup", () => {
  expect(typeof plugin.server).toBe("function")
  expect(typeof plugin.setup).toBe("function")
  expect(plugin.id).toBe("local.goal-mode.server")
})

test("V2 setup registers goal tools with JSON Schema inputs, codemode:false, and {content} executors", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await setupPlugin(mock as never)

  expect(mock.tools.map((tool) => tool.name).sort()).toEqual(TOOL_NAMES)

  for (const tool of mock.tools) {
    expect(tool.options?.codemode).toBe(false)
    expect(typeof tool.input).toBe("object")
    expect(tool.input).not.toBeNull()
    expect(tool.input).toMatchObject({ type: "object", properties: expect.any(Object), additionalProperties: false })
  }

  const created = await createGoalViaV2Tool(mock, "finish the V2 milestone")
  expect(created).toEqual({ content: expect.stringContaining('"status": "active"') })

  const getTool = goalTool(mock, "get_goal")
  const read = await getTool.execute({}, toolContext())
  expect(read).toEqual({ content: expect.stringContaining('"objective": "finish the V2 milestone"') })

  const completed = await goalTool(mock, "update_goal").execute(
    { status: "complete", evidence: "verified locally" },
    toolContext(),
  )
  expect(completed).toEqual({ content: expect.stringContaining('"completionEvidence": "verified locally"') })

  mock.stream.end()
  await cleanup()
  expect(mock.promptCalls).toHaveLength(0)
})

test("V2 list_all_goals returns goals from other sessions", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await setupPlugin(mock as never)
  await goalTool(mock, "create_goal").execute(
    { objective: "first V2 session goal" },
    toolContext("ses_first"),
  )
  await goalTool(mock, "create_goal").execute(
    { objective: "second V2 session goal" },
    toolContext("ses_second"),
  )

  const listed = await goalTool(mock, "list_all_goals").execute({}, toolContext("ses_observer"))

  expect(contentOf(listed)).toContain('"sessionID": "ses_first"')
  expect(contentOf(listed)).toContain('"sessionID": "ses_second"')
  expect(contentOf(listed)).not.toContain("usageTrackers")
  expect(contentOf(listed)).not.toContain("pendingAttempt")
  mock.stream.end()
  await cleanup()
})

test("V2 create_goal recovers from a zero-filled state file", async () => {
  await writeFile(process.env.OPENCODE_GOAL_STATE_PATH!, "\u0000\u0000", "utf8")
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await setupPlugin(mock as never)

  const created = await createGoalViaV2Tool(mock, "recover V2 state")

  expect(contentOf(created)).toContain('"objective": "recover V2 state"')
  expect((await getGoal("ses_v2"))?.objective).toBe("recover V2 state")
  mock.stream.end()
  await cleanup()
})

test("V2 create_goal reuses the same active objective without reinitializing state", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await setupPlugin(mock as never)
  await goalTool(mock, "create_goal").execute(
    { objective: "finish V2 safely", token_budget: 100 },
    toolContext(),
  )
  const before = await readFile(process.env.OPENCODE_GOAL_STATE_PATH!, "utf8")

  const duplicate = await goalTool(mock, "set_goal").execute(
    { objective: " finish V2 safely ", token_budget: 999 },
    toolContext(),
  )

  expect(contentOf(duplicate)).toContain('"goal_reused": true')
  expect(contentOf(duplicate)).toContain("Do not call create_goal or set_goal again")
  expect(contentOf(duplicate)).toContain('"tokenBudget": 100')
  expect(await readFile(process.env.OPENCODE_GOAL_STATE_PATH!, "utf8")).toBe(before)
  const conflict = await goalTool(mock, "create_goal").execute({ objective: "replace V2 goal" }, toolContext())
  expect(contentOf(conflict)).toContain('"goal_conflict": true')
  expect(contentOf(conflict)).toContain("Do not call create_goal or set_goal again")
  expect(await readFile(process.env.OPENCODE_GOAL_STATE_PATH!, "utf8")).toBe(before)

  mock.stream.end()
  await cleanup()
})

test("V2 setup registers the /goal command via command transform", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await setupPlugin(mock as never)

  const command = mock.commandDraft.get("goal")
  expect(command).toBeDefined()
  expect(command?.template).toContain('OpenCode goal mode command "/goal" was invoked')
  expect(command?.template).toContain("$ARGUMENTS")
  expect(command?.template).toContain("call get_goal first")
  expect(command?.template).toContain("never call it again")

  mock.stream.end()
  await cleanup()
})

test("V2 setup skips command registration when register_command is false", async () => {
  const mock = makeMockContext({ auto_continue: false, register_command: false })
  const cleanup = await setupPlugin(mock as never)

  expect(mock.commandDraft.get("goal")).toBeUndefined()
  expect(mock.disposals).not.toContain("command.transform")

  mock.stream.end()
  await cleanup()
})

test("V2 session context hook injects the goal-mode system reminder", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await setupPlugin(mock as never)

  const contextHook = mock.hooks["context"]!
  expect(contextHook).toBeTypeOf("function")
  const sessionContext = { sessionID: "ses_v2", agent: "build", system: [] as Array<{ type: string; text: string }>, messages: [], tools: {} }
  await contextHook(sessionContext)
  expect(sessionContext.system.some((part) => part.type === "text" && part.text.includes("OpenCode goal mode policy:"))).toBe(true)

  // The reminder is not duplicated on a second hook invocation.
  await contextHook(sessionContext)
  expect(sessionContext.system).toHaveLength(1)

  mock.stream.end()
  await cleanup()
})

test("V2 setup registers tool execute hooks", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await setupPlugin(mock as never)

  expect(mock.hooks["execute.before"]).toBeTypeOf("function")
  expect(mock.hooks["execute.after"]).toBeTypeOf("function")

  // The after hook must tolerate error statuses and extract text results.
  await mock.hooks["execute.after"]!({ tool: "task", status: "error", error: { message: "boom" } })
  await mock.hooks["execute.after"]!({
    tool: "task",
    status: "completed",
    result: { output: '<task id="t1" state="running">launch</task>' },
  })

  mock.stream.end()
  await cleanup()
})

test("V2 events account usage and checkpoints from step/usage events", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "account usage from events")

  // Step events drive per-step token sums and checkpoints.
  mock.stream.push({
    type: "session.step.started",
    created: Date.now(),
    data: { sessionID: "ses_v2", assistantMessageID: "msg_step_1", agent: "build" },
  })
  mock.stream.push({
    type: "session.text.delta",
    created: Date.now(),
    data: { sessionID: "ses_v2", assistantMessageID: "msg_step_1", ordinal: 0, delta: "IMPLEMENTED_THE_FEATURE" },
  })
  mock.stream.push({
    type: "session.text.ended",
    created: Date.now(),
    data: { sessionID: "ses_v2", assistantMessageID: "msg_step_1", ordinal: 0, text: "IMPLEMENTED_THE_FEATURE" },
  })
  mock.stream.push({
    type: "session.step.ended",
    created: Date.now(),
    data: {
      sessionID: "ses_v2",
      assistantMessageID: "msg_step_1",
      finish: "stop",
      tokens: { input: 30, output: 40, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  })

  await waitFor(async () => {
    const read = await goalTool(mock, "get_goal").execute({}, toolContext())
    const content = contentOf(read)
    return content.includes('"tokensUsed": 70') && content.includes("IMPLEMENTED_THE_FEATURE")
  })
  const readAfterStep = await goalTool(mock, "get_goal").execute({}, toolContext())
  expect(contentOf(readAfterStep)).toContain('"tokensUsed": 70')
  expect(contentOf(readAfterStep)).toContain("IMPLEMENTED_THE_FEATURE")

  // The first cumulative observation establishes a baseline without counting
  // the session's pre-goal usage or replacing step-derived goal usage.
  mock.stream.push({
    type: "session.usage.updated",
    created: Date.now(),
    data: { sessionID: "ses_v2", tokens: { input: 200, output: 50, reasoning: 0, cache: { read: 10, write: 0 } } },
  })
  await waitFor(async () => {
    const state = JSON.parse(await readFile(process.env.OPENCODE_GOAL_STATE_PATH!, "utf8")) as {
      goals: Record<string, { usageTrackers?: Record<string, unknown> }>
    }
    return JSON.stringify(state.goals.ses_v2?.usageTrackers?.["v2.session"]) ===
      JSON.stringify({ baseline: 260, lastObserved: 260, baseTokens: 70, pendingBaseline: null, pendingBaseTokens: null })
  })

  mock.stream.push({
    type: "session.usage.updated",
    created: Date.now(),
    data: { sessionID: "ses_v2", tokens: { input: 215, output: 50, reasoning: 0, cache: { read: 10, write: 0 } } },
  })
  await waitFor(async () => contentOf(await goalTool(mock, "get_goal").execute({}, toolContext())).includes('"tokensUsed": 85'))

  const read = await goalTool(mock, "get_goal").execute({}, toolContext())
  expect(contentOf(read)).toContain('"tokensUsed": 85')
  expect(contentOf(read)).toContain("IMPLEMENTED_THE_FEATURE")

  mock.stream.end()
  await cleanup()
})

test("V2 step accounting excludes steps observed before goal creation", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await setupPlugin(mock as never)

  mock.stream.push({
    type: "session.step.ended",
    created: 1,
    data: {
      sessionID: "ses_v2",
      assistantMessageID: "msg_before_goal",
      tokens: { input: 50_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await goalTool(mock, "create_goal").execute(
    { objective: "measure only goal work", token_budget: 1_000 },
    toolContext(),
  )

  mock.stream.push({
    type: "session.step.ended",
    created: 2,
    data: {
      sessionID: "ses_v2",
      assistantMessageID: "msg_goal_work",
      tokens: { input: 200, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  })

  await waitFor(async () => (await getGoal("ses_v2"))?.tokensUsed === 300)
  expect(await getGoal("ses_v2")).toMatchObject({ status: "active", tokensUsed: 300 })

  mock.stream.end()
  await cleanup()
})

test("V2 step and session sources do not double-count when session usage arrives first", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "reconcile usage sources")

  mock.stream.push({
    type: "session.usage.updated",
    created: 1,
    data: { sessionID: "ses_v2", tokens: { input: 500_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
  })
  mock.stream.push({
    type: "session.usage.updated",
    created: 2,
    data: { sessionID: "ses_v2", tokens: { input: 500_250, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
  })
  mock.stream.push({
    type: "session.step.ended",
    created: 3,
    data: {
      sessionID: "ses_v2",
      assistantMessageID: "msg_goal_work",
      tokens: { input: 200, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  })

  await waitFor(async () => (await getGoal("ses_v2"))?.tokensUsed === 300)
  expect((await getGoal("ses_v2"))?.tokensUsed).toBe(300)

  mock.stream.end()
  await cleanup()
})

test("V2 failed steps account usage and replace stale assistant progress", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "survive a failed model step")

  mock.stream.push({
    type: "session.step.started",
    created: 200,
    data: { sessionID: "ses_v2", assistantMessageID: "msg_failed", agent: "build" },
  })
  mock.stream.push({
    type: "session.text.delta",
    created: 201,
    data: { sessionID: "ses_v2", assistantMessageID: "msg_failed", delta: "partial response" },
  })
  mock.stream.push({
    type: "session.step.failed",
    created: 202,
    data: {
      sessionID: "ses_v2",
      assistantMessageID: "msg_failed",
      tokens: { input: 20, output: 3, reasoning: 2, cache: { read: 5, write: 0 } },
      error: { type: "provider.internal", message: "upstream failed" },
    },
  })

  await waitFor(async () => {
    const goal = await getGoal("ses_v2")
    return goal?.lastAssistantMessageID === "msg_failed" && goal.tokensUsed === 30
  })

  mock.stream.end()
  await cleanup()
})

test("V2 idle event triggers auto-continue via ctx.session.prompt", async () => {
  const mock = makeMockContext({ auto_continue: true, min_continue_interval_seconds: 0, max_auto_turns: 5 })
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "auto-continue from idle events")

  mock.stream.push({ type: "session.idle", created: Date.now(), data: { sessionID: "ses_v2" } })

  await waitFor(() => mock.promptCalls.length === 1)
  expect(mock.promptCalls[0]?.sessionID).toBe("ses_v2")
  expect(mock.promptCalls[0]?.text).toContain("Continue working toward the active session goal")
  expect(mock.promptCalls[0]?.agents).toEqual([{ name: "build" }])

  const read = await goalTool(mock, "get_goal").execute({}, toolContext())
  expect(contentOf(read)).toContain('"autoTurns": 1')

  mock.stream.end()
  await cleanup()
})

test("V2 idle continuation waits for a running child session", async () => {
  const mock = makeMockContext({ min_continue_interval_seconds: 1 })
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "wait for delegated work")

  mock.stream.push({ type: "session.created", created: 100, data: { sessionID: "child", parentID: "ses_v2" } })
  mock.stream.push({ type: "session.idle", created: 101, data: { sessionID: "ses_v2" } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(mock.promptCalls).toHaveLength(0)

  mock.stream.push({ type: "session.deleted", created: 102, data: { sessionID: "child" } })
  mock.stream.push({ type: "session.idle", created: 103, data: { sessionID: "ses_v2" } })
  await waitFor(() => mock.promptCalls.length === 1)

  mock.stream.end()
  await cleanup()
})

test("V2 idle auto-continue is suppressed for plan-agent goals", async () => {
  const mock = makeMockContext({ auto_continue: true, min_continue_interval_seconds: 0, max_auto_turns: 5 })
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "plan-mode goal must stay paused", "plan")

  mock.stream.push({ type: "session.idle", created: Date.now(), data: { sessionID: "ses_v2" } })
  await new Promise((resolve) => setTimeout(resolve, 50))

  expect(mock.promptCalls).toHaveLength(0)
  const read = await goalTool(mock, "get_goal").execute({}, toolContext())
  expect(contentOf(read)).toContain('"status": "paused"')

  mock.stream.end()
  await cleanup()
})

test("V2 cleanup disposes registrations and stops the event consumer", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "cleanup lifecycle")

  mock.stream.end()
  await cleanup()

  expect(mock.disposals).toEqual(
    expect.arrayContaining(["command.transform", "tool.transform", "tool.hook:execute.before", "tool.hook:execute.after", "session.hook:context"]),
  )
  // Events pushed after cleanup must not throw or mutate state.
  mock.stream.push({
    type: "session.usage.updated",
    created: Date.now(),
    data: { sessionID: "ses_v2", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const read = await goalTool(mock, "get_goal").execute({}, toolContext())
  expect(contentOf(read)).toContain('"tokensUsed": 0')
})

test("V2 session.error schedules bounded recovery without a phantom failure", async () => {
  const mock = makeMockContext({ auto_continue: true, min_continue_interval_seconds: 0, max_auto_turns: 5 })
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "recover from a transport error")

  mock.stream.push({
    type: "session.error",
    created: Date.now(),
    data: { sessionID: "ses_v2", error: { message: "network connection failed" } },
  })
  await waitFor(() => mock.promptCalls.length === 1)

  const goal = await getGoal("ses_v2")
  expect(goal?.continuationFailures).toBe(0)
  expect(goal?.autoTurns).toBe(1)
  expect(goal?.status).toBe("active")

  mock.stream.end()
  await cleanup()
})

test("V2 idle after a started pending attempt counts one unresolved failure and pauses at the ceiling", async () => {
  const mock = makeMockContext({
    auto_continue: true,
    min_continue_interval_seconds: 0,
    max_auto_turns: 5,
    max_prompt_failures: 1,
  })
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "detect a no response")

  mock.stream.push({ type: "session.idle", created: 1, data: { sessionID: "ses_v2" } })
  await waitFor(() => mock.promptCalls.length === 1)
  mock.stream.push({ type: "session.status", created: 2, data: { sessionID: "ses_v2", status: { type: "busy" } } })

  // The provider picks up the prompt: the busy marks the persisted attempt started.
  await waitFor(async () => (await getGoalInternal("ses_v2"))?.pendingAttempt?.started === true)
  expect((await getGoalInternal("ses_v2"))?.pendingAttempt?.started).toBe(true)

  // The following idle has no assistant output: exactly one unresolved failure.
  mock.stream.push({ type: "session.idle", created: 3, data: { sessionID: "ses_v2" } })
  await waitFor(async () => (await getGoal("ses_v2"))?.status === "paused")
  expect((await getGoal("ses_v2"))?.continuationFailures).toBe(1)

  mock.stream.end()
  await cleanup()
})

test("V2 persists the attempt before the prompt resolves so a later busy can correlate", async () => {
  let resolvePrompt: (() => void) | undefined
  const mock = makeMockContext({ auto_continue: true, min_continue_interval_seconds: 0, max_prompt_failures: 3 })
  mock.session.prompt = async (input: { sessionID: string; text: string }) => {
    mock.promptCalls.push(input)
    await new Promise<void>((resolve) => {
      resolvePrompt = resolve
    })
  }
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "correlate a racing busy")

  void mock.stream.push({ type: "session.idle", created: 1, data: { sessionID: "ses_v2" } })
  await waitFor(() => mock.promptCalls.length === 1)

  // The attempt is persisted BEFORE the prompt resolves, so a provider busy
  // (whenever it arrives) correlates to this exact attempt rather than a
  // local-only timing assumption.
  const during = await getGoalInternal("ses_v2")
  expect(during?.pendingAttempt).not.toBeNull()
  expect(during?.pendingAttempt?.delivered).toBe(false)

  resolvePrompt?.()
  await waitFor(async () => (await getGoalInternal("ses_v2"))?.pendingAttempt?.delivered === true)

  // A busy arriving after delivery still marks the same persisted attempt.
  mock.stream.push({ type: "session.status", created: 2, data: { sessionID: "ses_v2", status: { type: "busy" } } })
  await waitFor(async () => (await getGoalInternal("ses_v2"))?.pendingAttempt?.started === true)
  expect((await getGoalInternal("ses_v2"))?.pendingAttempt?.started).toBe(true)

  mock.stream.end()
  await cleanup()
})

test("V2 retry status cancels scheduled transport recovery", async () => {
  const mock = makeMockContext({ auto_continue: true, min_continue_interval_seconds: 0 })
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "let the native retry win")

  mock.stream.push({
    type: "session.error",
    created: 1,
    data: { sessionID: "ses_v2", error: { message: "network connection failed" } },
  })
  mock.stream.push({ type: "session.status", created: 2, data: { sessionID: "ses_v2", status: { type: "retry" } } })
  await new Promise((resolve) => setTimeout(resolve, 100))

  expect(mock.promptCalls).toHaveLength(0)
  expect((await getGoal("ses_v2"))?.continuationFailures).toBe(0)

  mock.stream.end()
  await cleanup()
})

test("V2 successful tool progress cancels no-pending transport recovery", async () => {
  const mock = makeMockContext({ auto_continue: true, min_continue_interval_seconds: 0 })
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "cancel recovery via tool progress")

  mock.stream.push({
    type: "session.usage.updated",
    created: 0,
    data: { sessionID: "ses_v2", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
  })
  await waitFor(async () => {
    const state = JSON.parse(await readFile(process.env.OPENCODE_GOAL_STATE_PATH!, "utf8")) as {
      goals: Record<string, { usageTrackers?: Record<string, unknown> }>
    }
    return JSON.stringify(state.goals.ses_v2?.usageTrackers?.["v2.session"]) ===
      JSON.stringify({ baseline: 0, lastObserved: 0, baseTokens: 0, pendingBaseline: null, pendingBaseTokens: null })
  })

  mock.stream.push({
    type: "session.error",
    created: 1,
    data: { sessionID: "ses_v2", error: { message: "network connection failed" } },
  })
  // Drain the FIFO event stream deterministically: a later usage event writes
  // state, so once it is visible the transport error above has already been
  // processed and its recovery timer scheduled. Then cancel it via the awaited
  // tool hook before the timer (RETRY_SETTLE_MS) can fire.
  mock.stream.push({
    type: "session.usage.updated",
    created: 2,
    data: { sessionID: "ses_v2", tokens: { input: 5, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
  })
  await waitFor(async () => (await getGoal("ses_v2"))?.tokensUsed === 5)
  await mock.hooks["execute.after"]!({
    tool: "bash",
    sessionID: "ses_v2",
    id: "call_progress",
    status: "completed",
    result: { output: "tests passed" },
  })
  await new Promise((resolve) => setTimeout(resolve, 100))

  expect(mock.promptCalls).toHaveLength(0)
  expect((await getGoal("ses_v2"))?.continuationFailures).toBe(0)

  mock.stream.end()
  await cleanup()
})

test("V2 assistant progress cancels no-pending transport recovery", async () => {
  const mock = makeMockContext({ auto_continue: true, min_continue_interval_seconds: 0 })
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "cancel recovery via assistant progress")

  mock.stream.push({
    type: "session.error",
    created: 1,
    data: { sessionID: "ses_v2", error: { message: "network connection failed" } },
  })
  mock.stream.push({
    type: "session.step.started",
    created: 20,
    data: { sessionID: "ses_v2", assistantMessageID: "msg_recovered", agent: "build" },
  })
  mock.stream.push({
    type: "session.text.ended",
    created: 21,
    data: { sessionID: "ses_v2", assistantMessageID: "msg_recovered", text: "The provider recovered on its own." },
  })
  mock.stream.push({
    type: "session.step.ended",
    created: 22,
    data: { sessionID: "ses_v2", assistantMessageID: "msg_recovered", tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } },
  })
  await waitFor(async () => (await getGoal("ses_v2"))?.lastAssistantMessageID === "msg_recovered")
  await new Promise((resolve) => setTimeout(resolve, 100))

  expect(mock.promptCalls).toHaveLength(0)

  mock.stream.end()
  await cleanup()
})

test("V2 watchdog rescues a busy active goal without consuming auto-turn budgets", async () => {
  const mock = makeMockContext({ auto_continue: false, max_turn_time: 0.02, max_prompt_failures: 5, max_auto_turns: 1 })
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "watchdog should not eat the budget")

  mock.stream.push({ type: "session.status", created: Date.now(), data: { sessionID: "ses_v2", status: { type: "busy" } } })
  await waitFor(() => mock.promptCalls.length === 1)

  expect(mock.promptCalls).toHaveLength(1)
  expect((await getGoal("ses_v2"))?.autoTurns).toBe(0)

  mock.stream.end()
  await cleanup()
})

test("V2 non-transport prompt errors do not count toward the ceiling or retry", async () => {
  const mock = makeMockContext({ auto_continue: true, min_continue_interval_seconds: 0, max_prompt_failures: 3 })
  mock.session.prompt = async () => {
    throw new Error("invalid provider configuration")
  }
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "non-transport must be ignored")

  mock.stream.push({ type: "session.idle", created: Date.now(), data: { sessionID: "ses_v2" } })
  await new Promise((resolve) => setTimeout(resolve, 100))

  const goal = await getGoal("ses_v2")
  expect(goal?.continuationFailures).toBe(0)
  expect(goal?.status).toBe("active")

  mock.stream.end()
  await cleanup()
})

test("V2 a native retry status suppresses a later session.error until busy ends the episode", async () => {
  const mock = makeMockContext({ auto_continue: true, min_continue_interval_seconds: 0, max_prompt_failures: 3 })
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "native retry must win")

  // retry arrives before the transport error; the error is suppressed while
  // the provider is already retrying.
  mock.stream.push({ type: "session.status", created: 1, data: { sessionID: "ses_v2", status: { type: "retry" } } })
  mock.stream.push({
    type: "session.error",
    created: 2,
    data: { sessionID: "ses_v2", error: { message: "network connection failed" } },
  })
  await new Promise((resolve) => setTimeout(resolve, 100))

  expect(mock.promptCalls).toHaveLength(0)
  const suppressed = await getGoal("ses_v2")
  expect(suppressed?.continuationFailures).toBe(0)
  expect(suppressed?.status).toBe("active")

  // busy ends the retry episode; a later transport error may then recover.
  mock.stream.push({ type: "session.status", created: 3, data: { sessionID: "ses_v2", status: { type: "busy" } } })
  mock.stream.push({
    type: "session.error",
    created: 4,
    data: { sessionID: "ses_v2", error: { message: "network connection failed" } },
  })
  await waitFor(() => mock.promptCalls.length === 1)
  expect(mock.promptCalls[0]?.text).toContain("Continue working toward the active session goal")

  mock.stream.end()
  await cleanup()
})

test("V2 watchdog no-response counts a failure on idle even with auto_continue false", async () => {
  const mock = makeMockContext({ auto_continue: false, max_turn_time: 0.02, max_prompt_failures: 5, max_auto_turns: 1 })
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "watchdog no response with auto-continue disabled")

  mock.stream.push({ type: "session.status", created: Date.now(), data: { sessionID: "ses_v2", status: { type: "busy" } } })
  await waitFor(async () => (await getGoalInternal("ses_v2"))?.pendingAttempt?.started === true)
  await waitFor(() => mock.promptCalls.length === 1)
  expect((await getGoal("ses_v2"))?.autoTurns).toBe(0)

  // The busy episode ends with no response: the started pending attempt counts
  // exactly one unresolved failure even though auto-continue is disabled, and
  // no retry is scheduled.
  mock.stream.push({ type: "session.idle", created: Date.now(), data: { sessionID: "ses_v2" } })
  await waitFor(async () => (await getGoal("ses_v2"))?.continuationFailures === 1)

  const goal = await getGoal("ses_v2")
  expect(goal?.continuationFailures).toBe(1)
  expect(goal?.autoTurns).toBe(0)
  expect(goal?.status).toBe("active")
  expect((await getGoalInternal("ses_v2"))?.pendingAttempt).toBeNull()
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(mock.promptCalls).toHaveLength(1)

  mock.stream.end()
  await cleanup()
})

test("V2 delayed tool output from a prior turn cannot clear a newer pending attempt", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "correlate tool progress to the attempt")

  // The tool call starts while attempt A is pending; the before hook captures
  // the attempt id for the session+call key.
  await reserveContinuation("ses_v2", 10, 0)
  await recordContinuationResult("ses_v2", "success", 5)
  const attemptA = (await getGoalInternal("ses_v2"))?.pendingAttempt?.id
  expect(attemptA).toMatch(/^att_/)
  await mock.hooks["execute.before"]!({ tool: "bash", sessionID: "ses_v2", id: "call_delayed", input: {} })

  // A newer attempt B is reserved while the tool is still running.
  await reserveContinuation("ses_v2", 10, 0)
  await recordContinuationResult("ses_v2", "success", 5)
  const attemptB = (await getGoalInternal("ses_v2"))?.pendingAttempt?.id
  expect(attemptB).not.toBe(attemptA)

  // The delayed output from the old call must leave attempt B pending.
  await mock.hooks["execute.after"]!({
    tool: "bash",
    sessionID: "ses_v2",
    id: "call_delayed",
    status: "completed",
    result: { output: "tests passed" },
  })
  expect((await getGoalInternal("ses_v2"))?.pendingAttempt?.id).toBe(attemptB)

  // A tool call that started while attempt B was pending clears it.
  await mock.hooks["execute.before"]!({ tool: "bash", sessionID: "ses_v2", id: "call_current", input: {} })
  await mock.hooks["execute.after"]!({
    tool: "bash",
    sessionID: "ses_v2",
    id: "call_current",
    status: "completed",
    result: { output: "more progress" },
  })
  expect((await getGoalInternal("ses_v2"))?.pendingAttempt).toBeNull()

  mock.stream.end()
  await cleanup()
})

test("V2 dispose during an in-flight prompt rolls back the reserved attempt on rejection", async () => {
  let resolvePrompt: (() => void) | undefined
  const mock = makeMockContext({ auto_continue: true, min_continue_interval_seconds: 0, max_prompt_failures: 3 })
  mock.session.prompt = async (input: { sessionID: string; text: string }) => {
    mock.promptCalls.push(input)
    await new Promise<void>((resolve) => {
      resolvePrompt = resolve
    })
    throw new Error("network down")
  }
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "dispose mid-flight rejection")

  void mock.stream.push({ type: "session.idle", created: 1, data: { sessionID: "ses_v2" } })
  await waitFor(() => mock.promptCalls.length === 1)

  // Dispose while the prompt is in flight, then let it fail: the catch block
  // must roll back the reserved attempt without counting a transport failure
  // or consuming an auto-turn.
  await cleanup()
  resolvePrompt?.()
  await new Promise((resolve) => setTimeout(resolve, 100))

  expect(mock.promptCalls).toHaveLength(1)
  const goal = await getGoal("ses_v2")
  expect(goal?.autoTurns).toBe(0)
  expect(goal?.continuationFailures).toBe(0)
  expect(goal?.status).toBe("active")
  expect((await getGoalInternal("ses_v2"))?.pendingAttempt).toBeNull()
})

test("V2 commits an accepted prompt when its recovery timer is canceled in flight", async () => {
  let resolvePrompt: (() => void) | undefined
  const mock = makeMockContext({ auto_continue: true, min_continue_interval_seconds: 0 })
  mock.session.prompt = async (input) => {
    mock.promptCalls.push(input)
    await new Promise<void>((resolve) => {
      resolvePrompt = resolve
    })
  }
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "commit accepted recovery")

  mock.stream.push({
    type: "session.error",
    created: Date.now(),
    data: { sessionID: "ses_v2", error: { message: "network connection failed" } },
  })
  await waitFor(() => mock.promptCalls.length === 1)

  // Concurrent progress cancels the timer while prompt() is still in flight.
  // Once prompt() resolves, its accepted delivery must remain charged/tracked.
  await mock.hooks["execute.before"]!({ tool: "bash", sessionID: "ses_v2", id: "call_cancel" })
  await mock.hooks["execute.after"]!({
    tool: "bash",
    sessionID: "ses_v2",
    id: "call_cancel",
    status: "completed",
    result: { output: "progress from the active session" },
  })
  resolvePrompt?.()

  await waitFor(async () => (await getGoalInternal("ses_v2"))?.pendingAttempt?.delivered === true)
  expect((await getGoal("ses_v2"))?.autoTurns).toBe(1)
  expect(mock.promptCalls).toHaveLength(1)

  mock.stream.end()
  await cleanup()
})

test("V2 completed tool failures do not clear retry state", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "keep failed tools from masking recovery")

  await reserveContinuation("ses_v2", 10, 0)
  await recordContinuationResult("ses_v2", "failure", 5)
  await reserveContinuation("ses_v2", 10, 0)
  await recordContinuationResult("ses_v2", "success", 5)
  const attemptID = (await getGoalInternal("ses_v2"))?.pendingAttempt?.id
  expect(attemptID).toBeTypeOf("string")

  for (const [id, output] of [
    ["call_running", "state: running\nstill working"],
    ["call_error", "<error>command failed</error>"],
  ] as const) {
    await mock.hooks["execute.before"]!({ tool: "bash", sessionID: "ses_v2", id })
    await mock.hooks["execute.after"]!({
      tool: "bash",
      sessionID: "ses_v2",
      id,
      status: "completed",
      result: { output },
    })
    const goal = await getGoalInternal("ses_v2")
    expect(goal?.continuationFailures).toBe(1)
    expect(goal?.pendingAttempt?.id).toBe(attemptID)
  }

  mock.stream.end()
  await cleanup()
})

// ---------------------------------------------------------------------------
// question_policy. OpenCode's built-in `question` tool blocks the turn until a
// human answers, which stalls an unattended goal forever. While a goal is
// ACTIVE and the policy is not "allow", V2 both drops the tool from the set the
// model is offered (the context hook) and fails the call if it arrives anyway
// (execute.before). Any other goal status, or no goal, is untouched.
// ---------------------------------------------------------------------------

const QUESTION_POLICY_HEADING = "Question policy while this goal is active:"
const GOAL_REMINDER_HEADING = "OpenCode goal mode policy:"

type SessionContextLike = {
  sessionID: string
  agent: string
  system: Array<{ type: string; text: string }>
  messages: unknown[]
  tools?: Record<string, unknown>
}

function seededTools(): Record<string, unknown> {
  return {
    question: { description: "ask the user a question" },
    read: { description: "read a file" },
    edit: { description: "edit a file" },
    bash: { description: "run a command" },
  }
}

function sessionContextWithTools(tools?: Record<string, unknown>, sessionID = "ses_v2"): SessionContextLike {
  const sessionContext: SessionContextLike = { sessionID, agent: "build", system: [], messages: [] }
  if (tools !== undefined) sessionContext.tools = tools
  return sessionContext
}

function partsContaining(sessionContext: SessionContextLike, needle: string) {
  return sessionContext.system.filter((part) => part.type === "text" && part.text.includes(needle))
}

async function runContextHook(mock: MockContext, sessionContext: SessionContextLike) {
  const contextHook = mock.hooks["context"]
  expect(contextHook).toBeTypeOf("function")
  await contextHook!(sessionContext)
}

// Returns the thrown message, or null when the hook let the call through.
async function blockMessageFor(mock: MockContext, input: Record<string, unknown>) {
  try {
    await mock.hooks["execute.before"]!(input)
  } catch (error) {
    return (error as Error).message
  }
  return null
}

async function questionsSuppressedCount(mock: MockContext, sessionID = "ses_v2") {
  const read = contentOf(await goalTool(mock, "get_goal").execute({}, toolContext(sessionID)))
  const match = /"questionsSuppressed":\s*(\d+)/.exec(read)
  return match ? Number(match[1]) : null
}

test("V2 context hook removes only the question tool from the offered tool set", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "run unattended without stopping to ask")

  const sessionContext = sessionContextWithTools(seededTools())
  await runContextHook(mock, sessionContext)

  expect(sessionContext.tools).toBeDefined()
  expect("question" in sessionContext.tools!).toBe(false)
  expect(sessionContext.tools!.question).toBeUndefined()
  expect(Object.keys(sessionContext.tools!).sort()).toEqual(["bash", "edit", "read"])
  expect(sessionContext.tools!.read).toEqual({ description: "read a file" })
  expect(sessionContext.tools!.edit).toEqual({ description: "edit a file" })
  expect(sessionContext.tools!.bash).toEqual({ description: "run a command" })

  mock.stream.end()
  await cleanup()
})

test("V2 context hook pushes the question-policy reminder beside the goal reminder exactly once", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "keep the loop moving without a human")

  const sessionContext = sessionContextWithTools(seededTools())
  await runContextHook(mock, sessionContext)

  expect(sessionContext.system).toHaveLength(2)
  expect(partsContaining(sessionContext, GOAL_REMINDER_HEADING)).toHaveLength(1)
  const policyParts = partsContaining(sessionContext, QUESTION_POLICY_HEADING)
  expect(policyParts).toHaveLength(1)
  expect(policyParts[0]!.type).toBe("text")
  expect(policyParts[0]!.text).toBe(questionPolicyReminder("decide"))
  expect(policyParts[0]!.text).toContain("When you would have asked, decide instead")

  // A second invocation on the same context adds neither part again.
  await runContextHook(mock, sessionContext)
  expect(sessionContext.system).toHaveLength(2)
  expect(partsContaining(sessionContext, GOAL_REMINDER_HEADING)).toHaveLength(1)
  expect(partsContaining(sessionContext, QUESTION_POLICY_HEADING)).toHaveLength(1)

  mock.stream.end()
  await cleanup()
})

test('V2 context hook reminder text follows question_policy "deny"', async () => {
  const mock = makeMockContext({ auto_continue: false, question_policy: "deny" })
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "refuse to guess at an impasse")

  const sessionContext = sessionContextWithTools(seededTools())
  await runContextHook(mock, sessionContext)

  const policyParts = partsContaining(sessionContext, QUESTION_POLICY_HEADING)
  expect(policyParts).toHaveLength(1)
  expect(policyParts[0]!.text).toBe(questionPolicyReminder("deny"))
  expect(policyParts[0]!.text).toContain('call update_goal with status "unmet"')
  expect(policyParts[0]!.text).not.toContain("When you would have asked, decide instead")
  expect(sessionContext.tools!.question).toBeUndefined()

  mock.stream.end()
  await cleanup()
})

test('V2 context hook leaves the question tool in place under question_policy "allow"', async () => {
  const mock = makeMockContext({ auto_continue: false, question_policy: "allow" })
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "keep asking the user, on purpose")

  const sessionContext = sessionContextWithTools(seededTools())
  await runContextHook(mock, sessionContext)

  expect(sessionContext.tools!.question).toEqual({ description: "ask the user a question" })
  expect(Object.keys(sessionContext.tools!).sort()).toEqual(["bash", "edit", "question", "read"])
  expect(partsContaining(sessionContext, QUESTION_POLICY_HEADING)).toHaveLength(0)
  expect(sessionContext.system).toHaveLength(1)
  expect(partsContaining(sessionContext, GOAL_REMINDER_HEADING)).toHaveLength(1)

  mock.stream.end()
  await cleanup()
})

test("V2 context hook leaves the question tool alone unless the goal is active", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await setupPlugin(mock as never)

  // No goal at all: the goal reminder still lands, the question tool survives.
  const noGoal = sessionContextWithTools(seededTools())
  await runContextHook(mock, noGoal)
  expect(noGoal.tools!.question).toEqual({ description: "ask the user a question" })
  expect(partsContaining(noGoal, GOAL_REMINDER_HEADING)).toHaveLength(1)
  expect(partsContaining(noGoal, QUESTION_POLICY_HEADING)).toHaveLength(0)

  await createGoalViaV2Tool(mock, "pause and resume around the question gate")
  await goalTool(mock, "update_goal_status").execute({ status: "paused" }, toolContext())
  expect((await getGoal("ses_v2"))?.status).toBe("paused")

  const paused = sessionContextWithTools(seededTools())
  await runContextHook(mock, paused)
  expect(paused.tools!.question).toEqual({ description: "ask the user a question" })
  expect(Object.keys(paused.tools!).sort()).toEqual(["bash", "edit", "question", "read"])
  expect(partsContaining(paused, QUESTION_POLICY_HEADING)).toHaveLength(0)

  // Resuming closes the gate again, so the gate really tracks status.
  await goalTool(mock, "update_goal_status").execute({ status: "active" }, toolContext())
  expect((await getGoal("ses_v2"))?.status).toBe("active")
  const resumed = sessionContextWithTools(seededTools())
  await runContextHook(mock, resumed)
  expect(resumed.tools!.question).toBeUndefined()
  expect(partsContaining(resumed, QUESTION_POLICY_HEADING)).toHaveLength(1)

  // A closed goal reopens the gate.
  await goalTool(mock, "update_goal").execute({ status: "complete", evidence: "shipped" }, toolContext())
  expect((await getGoal("ses_v2"))?.status).toBe("complete")
  const closed = sessionContextWithTools(seededTools())
  await runContextHook(mock, closed)
  expect(closed.tools!.question).toEqual({ description: "ask the user a question" })
  expect(partsContaining(closed, QUESTION_POLICY_HEADING)).toHaveLength(0)

  mock.stream.end()
  await cleanup()
})

test("V2 context hook survives a session context with no tools map", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "tolerate a runtime shape we do not own")

  const missing = sessionContextWithTools(undefined)
  expect("tools" in missing).toBe(false)
  await runContextHook(mock, missing)
  expect(missing.tools).toBeUndefined()
  expect(partsContaining(missing, QUESTION_POLICY_HEADING)).toHaveLength(1)
  expect(partsContaining(missing, GOAL_REMINDER_HEADING)).toHaveLength(1)

  const explicitUndefined = sessionContextWithTools(undefined)
  explicitUndefined.tools = undefined
  expect("tools" in explicitUndefined).toBe(true)
  await runContextHook(mock, explicitUndefined)
  expect(explicitUndefined.tools).toBeUndefined()
  expect(partsContaining(explicitUndefined, QUESTION_POLICY_HEADING)).toHaveLength(1)

  const emptyTools = sessionContextWithTools({})
  await runContextHook(mock, emptyTools)
  expect(emptyTools.tools).toEqual({})

  mock.stream.end()
  await cleanup()
})

test("V2 execute.before blocks the question tool with decide wording by default", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "decide instead of asking")

  const message = await blockMessageFor(mock, {
    tool: "question",
    sessionID: "ses_v2",
    id: "call_q1",
    input: { questions: [{ question: "Should I use tabs or spaces?" }] },
  })

  expect(message).toBeTypeOf("string")
  expect(message).toContain("The question tool is disabled while this session goal is active. Decide instead of asking.")
  expect(message).toContain("Pick the answer you would have recommended")
  expect(message).not.toContain('call update_goal with status "unmet" and a concrete blocker.')
  expect(message).toBe(questionBlockedMessage("decide", "Should I use tabs or spaces?"))

  mock.stream.end()
  await cleanup()
})

test('V2 execute.before blocks the question tool with deny wording under question_policy "deny"', async () => {
  const mock = makeMockContext({ auto_continue: false, question_policy: "deny" })
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "route an impasse to unmet")

  const message = await blockMessageFor(mock, {
    tool: "question",
    sessionID: "ses_v2",
    id: "call_q1",
    input: { questions: [{ question: "Should I use tabs or spaces?" }] },
  })

  expect(message).toBeTypeOf("string")
  expect(message).toContain("The question tool is disabled while this session goal is active.")
  expect(message).not.toContain("Decide instead of asking")
  expect(message).not.toContain("Pick the answer you would have recommended")
  expect(message).toContain('call update_goal with status "unmet" and a concrete blocker.')
  expect(message).toBe(questionBlockedMessage("deny", "Should I use tabs or spaces?"))

  mock.stream.end()
  await cleanup()
})

test("V2 an unrecognised question_policy falls back to decide rather than allowing questions", async () => {
  const mock = makeMockContext({ auto_continue: false, question_policy: "sometimes-maybe" })
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "survive a typo in the config file")

  const sessionContext = sessionContextWithTools(seededTools())
  await runContextHook(mock, sessionContext)
  expect(sessionContext.tools!.question).toBeUndefined()
  expect(partsContaining(sessionContext, QUESTION_POLICY_HEADING)[0]!.text).toBe(questionPolicyReminder("decide"))

  const message = await blockMessageFor(mock, {
    tool: "question",
    sessionID: "ses_v2",
    id: "call_q1",
    input: { questions: [{ question: "Tabs or spaces?" }] },
  })
  expect(message).toBe(questionBlockedMessage("decide", "Tabs or spaces?"))

  mock.stream.end()
  await cleanup()
})

test("V2 execute.before reads the asked question from input.input, not the V1 input.args", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "quote back what the model wanted to ask")

  const asked = "Should the retry budget be 3 or 5?"
  const fromInput = await blockMessageFor(mock, {
    tool: "question",
    sessionID: "ses_v2",
    id: "call_q1",
    input: { questions: [{ question: asked }] },
  })
  expect(fromInput).toContain(`Blocked question: ${asked}`)

  // Several questions in one call are joined rather than dropped.
  const joined = await blockMessageFor(mock, {
    tool: "question",
    sessionID: "ses_v2",
    id: "call_q2",
    input: { questions: [{ question: "First?" }, { question: "Second?" }] },
  })
  expect(joined).toContain("Blocked question: First? | Second?")

  // The V1 shape carries no text on the V2 path: still blocked, nothing quoted.
  const v1Shape = await blockMessageFor(mock, {
    tool: "question",
    sessionID: "ses_v2",
    id: "call_q3",
    args: { questions: [{ question: "V1 shaped question" }] },
  })
  expect(v1Shape).toBeTypeOf("string")
  expect(v1Shape).not.toContain("Blocked question:")
  expect(v1Shape).not.toContain("V1 shaped question")
  expect(v1Shape).toBe(questionBlockedMessage("decide"))

  // A malformed payload degrades to no text instead of throwing a TypeError.
  const malformed = await blockMessageFor(mock, {
    tool: "question",
    sessionID: "ses_v2",
    id: "call_q4",
    input: { questions: "not an array" },
  })
  expect(malformed).toBe(questionBlockedMessage("decide"))

  mock.stream.end()
  await cleanup()
})

test("V2 execute.before lets calls through whenever the question gate is open", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await setupPlugin(mock as never)

  // No goal yet: even the question tool passes.
  expect(
    await blockMessageFor(mock, {
      tool: "question",
      sessionID: "ses_v2",
      id: "call_no_goal",
      input: { questions: [{ question: "Anyone home?" }] },
    }),
  ).toBeNull()

  await createGoalViaV2Tool(mock, "block only the question tool")

  // A different tool is never blocked, even with an active goal.
  expect(
    await blockMessageFor(mock, {
      tool: "bash",
      sessionID: "ses_v2",
      id: "call_bash",
      input: { command: "ls" },
    }),
  ).toBeNull()

  // The tool id is matched case-insensitively.
  expect(
    await blockMessageFor(mock, {
      tool: "Question",
      sessionID: "ses_v2",
      id: "call_caps",
      input: { questions: [{ question: "Case sensitive?" }] },
    }),
  ).toBeTypeOf("string")

  // A paused goal reopens the gate and does not move the counter.
  await goalTool(mock, "update_goal_status").execute({ status: "paused" }, toolContext())
  expect((await getGoal("ses_v2"))?.status).toBe("paused")
  expect(
    await blockMessageFor(mock, {
      tool: "question",
      sessionID: "ses_v2",
      id: "call_paused",
      input: { questions: [{ question: "May I ask now?" }] },
    }),
  ).toBeNull()
  expect(await questionsSuppressedCount(mock)).toBe(1)

  mock.stream.end()
  await cleanup()
})

test('V2 execute.before never blocks under question_policy "allow"', async () => {
  const mock = makeMockContext({ auto_continue: false, question_policy: "allow" })
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "let the old behaviour stand")

  expect(
    await blockMessageFor(mock, {
      tool: "question",
      sessionID: "ses_v2",
      id: "call_q1",
      input: { questions: [{ question: "Tabs or spaces?" }] },
    }),
  ).toBeNull()
  expect(await questionsSuppressedCount(mock)).toBe(0)

  mock.stream.end()
  await cleanup()
})

test("V2 blocking a question increments the goal's questionsSuppressed counter", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await setupPlugin(mock as never)
  await createGoalViaV2Tool(mock, "count what the model wanted to ask")

  expect(contentOf(await goalTool(mock, "get_goal").execute({}, toolContext()))).toContain('"questionsSuppressed": 0')

  await blockMessageFor(mock, {
    tool: "question",
    sessionID: "ses_v2",
    id: "call_q1",
    input: { questions: [{ question: "Ship it now?" }] },
  })
  expect(contentOf(await goalTool(mock, "get_goal").execute({}, toolContext()))).toContain('"questionsSuppressed": 1')

  await blockMessageFor(mock, {
    tool: "question",
    sessionID: "ses_v2",
    id: "call_q2",
    input: { questions: [{ question: "Really ship it?" }] },
  })
  expect(contentOf(await goalTool(mock, "get_goal").execute({}, toolContext()))).toContain('"questionsSuppressed": 2')

  // A tool that was never blocked leaves the counter where it was.
  await blockMessageFor(mock, { tool: "bash", sessionID: "ses_v2", id: "call_bash", input: { command: "ls" } })
  expect(await questionsSuppressedCount(mock)).toBe(2)

  // The history keeps an audit trail of what it wanted to ask.
  const history = contentOf(await goalTool(mock, "get_goal_history").execute({}, toolContext()))
  expect(history).toContain("Question tool blocked by goal policy: Ship it now?")
  expect(history).toContain("Question tool blocked by goal policy: Really ship it?")

  mock.stream.end()
  await cleanup()
})

test("V2 update_goal_limits and snapshot_goal recover a limited goal through the V2 registry", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await setupPlugin(mock as never)

  const start = new Date("2026-08-30T00:00:00.000Z")
  setSystemTime(start)
  await goalTool(mock, "create_goal").execute(
    { objective: "run the long-haul pipeline", token_budget: 300_000_000, max_duration_seconds: 36_000 },
    toolContext(),
  )
  setSystemTime(new Date(start.getTime() + 42_478 * 1000))
  await reserveContinuation("ses_v2", 100, 0)
  setSystemTime()

  const refused = JSON.parse(
    contentOf(await goalTool(mock, "update_goal_status").execute({ status: "active" }, toolContext())),
  )
  expect(refused.goal.status).toBe("usageLimited")
  expect(refused.resume_refused).toBe(true)
  expect(refused.limited_by).toBe("duration")

  const raised = JSON.parse(
    contentOf(await goalTool(mock, "update_goal_limits").execute({ additional_seconds: 3_600 }, toolContext())),
  )
  expect(raised.limits_updated).toBe(true)
  expect(raised.goal.maxDurationSeconds).toBe(42_478 + 3_600)

  const resumed = JSON.parse(
    contentOf(await goalTool(mock, "update_goal_status").execute({ status: "active" }, toolContext())),
  )
  expect(resumed.goal.status).toBe("active")
  expect(resumed.goal.createdAt).toBe(refused.goal.createdAt)

  const exported = JSON.parse(contentOf(await goalTool(mock, "snapshot_goal").execute({}, toolContext())))
  expect(exported.markdown).toContain("# Goal snapshot")
  expect(exported.markdown).toContain("run the long-haul pipeline")

  mock.stream.end()
  await cleanup()
})

test("V2 update_goal_limits declares every documented argument in its JSON Schema", async () => {
  const mock = makeMockContext({ auto_continue: false })
  const cleanup = await setupPlugin(mock as never)

  // The V1 zod args and the V2 JSON Schema are written separately, so they can
  // silently drift; this pins the V2 half to the same argument set.
  const limits = goalTool(mock, "update_goal_limits").input as { properties: Record<string, unknown> }
  expect(Object.keys(limits.properties).sort()).toEqual([
    "additional_auto_turns",
    "additional_seconds",
    "additional_tokens",
    "max_auto_turns",
    "max_duration_seconds",
    "reset_elapsed",
    "token_budget",
  ])
  const status = goalTool(mock, "update_goal_status").input as { properties: Record<string, unknown> }
  expect(Object.keys(status.properties).sort()).toEqual([
    "additional_auto_turns",
    "additional_seconds",
    "additional_tokens",
    "reset_elapsed",
    "status",
  ])

  mock.stream.end()
  await cleanup()
})
