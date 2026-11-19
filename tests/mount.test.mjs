import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

// 设备身份文件写到临时目录，别碰真实的 ~/.config/magpie
process.env.MAGPIE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "musework-mount-"))

const { MuseWorkAuthPlugin, _internal } = await import("../index.mjs")
const { clearAgentCache } = await import("../src/catalog.mjs")

function jwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.signature`
}

const TOKEN = jwt({ user_id: "10000000001", exp: Math.floor(Date.now() / 1000) + 86400 })

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function sseResponse(frames) {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } })
}

function sse(event, data, id = 1) {
  return `id:${id}\nevent:${event}\ndata:${JSON.stringify(data)}\n\n`
}

const CHAT_FRAMES = [
  sse("component.start", { component_type: "reply", id: "r1" }, 1),
  sse("component.content", { component_type: "reply", id: "r1", payload: { content_delta: "Hi" } }, 2),
  sse("component.end", { component_type: "reply", id: "r1", payload: { content: "Hi" } }, 3),
  sse("run.end", { run_id: "run1" }, 4),
  sse("session.idle", { session_id: "s1" }, 5),
]

function fakeFetch({ chatFrames = CHAT_FRAMES, chatStatus = null, dailyClaimed = false } = {}) {
  const calls = []
  const impl = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input?.url || "")
    const method = String(init?.method || "GET").toUpperCase()
    const entry = { url, method, body: init?.body ? String(init.body) : "" }
    calls.push(entry)

    if (url.endsWith("/api/v1/users/self")) {
      return jsonResponse({ data: { id: "10000000001", email: "user@example.com", nickname: "user1" } })
    }
    if (url.endsWith("/api/v1/daily-rewards/status")) {
      return jsonResponse({
        data: {
          server_now: Date.now(),
          claimed_today: dailyClaimed,
          claimable: !dailyClaimed,
          continuous_days: dailyClaimed ? 1 : 0,
          today_reward: dailyClaimed ? 100 : 50,
          monthly_claimed: dailyClaimed ? 50 : 0,
          next_claim_at: Date.now() + 3600_000,
          reward_steps: [50, 100, 150, 200, 300],
        },
      })
    }
    if (url.endsWith("/api/v1/daily-rewards/claim")) {
      return jsonResponse({
        data: {
          claimed_today: true,
          claimable: false,
          continuous_days: 1,
          today_reward: 100,
          monthly_claimed: 50,
          next_claim_at: Date.now() + 3600_000,
          reward_steps: [50, 100, 150, 200, 300],
          already_claimed: false,
          granted_credits: 50,
        },
      })
    }
    if (url.includes("/api/v1/sessions/models")) {
      return jsonResponse({
        data: {
          models: [{
            key: "deepseek-v4-1-flash",
            name: "DeepSeek V4.1 Flash",
            description: "fast",
            credit_usage_rate: 0.3,
            supports_images: true,
            reasoning_efforts: ["low", "medium", "high"],
            default_reasoning_effort: "medium",
          }],
          default_basic: "deepseek-v4-1-flash",
        },
      })
    }
    if (url.includes("/api/v1/agents")) {
      return jsonResponse({
        data: {
          agents: [{
            agent_id: "agent-1",
            name: "MuBear",
            agent_status: "active",
            channels: [{ channel_id: "channel-1", channel_type: "web" }],
          }],
        },
      })
    }
    if (url.endsWith("/api/v1/sessions") && method === "POST") {
      return jsonResponse({ data: { session_id: "session-1", channel_id: "channel-1", agent_id: "agent-1" } })
    }
    if (url.includes("/api/v1/sessions/session-1/delete")) {
      return jsonResponse({ data: {} })
    }
    if (url.endsWith("/api/v1/chat/completions")) {
      if (chatStatus) return jsonResponse({ code: "BAD_REQUEST", message: "Invalid request" }, chatStatus)
      return sseResponse(chatFrames)
    }
    if (url.endsWith("/api/v1/credits/balance")) {
      return jsonResponse({
        data: [
          { credit_type: "daily", total_credits: 100, remaining_credits: 91 },
          { credit_type: "bonus", total_credits: 200, remaining_credits: 200 },
        ],
      })
    }
    if (url.endsWith("/api/v1/subscription")) {
      return jsonResponse({
        data: {
          tier_label: "Free",
          plan_tier: "free",
          quota: { daily_credits: 100, max_concurrent_tasks: 1, max_concurrent_sessions: 1 },
        },
      })
    }
    return jsonResponse({ code: "NOT_FOUND", message: "not found" }, 404)
  }
  return { impl, calls }
}

function authObject() {
  return { access: TOKEN, refresh: "refresh-1", expires: Date.now() + 86400_000, uid: "10000000001", accountId: "user@example.com" }
}

test("config 钩子声明 provider 与静态模型表", async () => {
  const plugin = await MuseWorkAuthPlugin({}, {})
  const cfg = {}
  await plugin.config(cfg)
  assert.equal(cfg.provider.musework.name, "MuseWork")
  assert.equal(cfg.provider.musework.npm, "@ai-sdk/openai-compatible")
  assert.equal(cfg.provider.musework.api, "https://museai.im/api/v1")
  assert.equal(Object.keys(cfg.provider.musework.models).length, 5)
})

test("chat.headers 只给本 provider 的请求加头", async () => {
  const plugin = await MuseWorkAuthPlugin({}, {})
  const mine = { headers: {} }
  await plugin["chat.headers"]({ model: { providerID: "musework" }, sessionID: "sess-1" }, mine)
  assert.equal(mine.headers["x-magpie-session-id"], "sess-1")

  const other = { headers: {} }
  await plugin["chat.headers"]({ model: { providerID: "other" }, sessionID: "sess-1" }, other)
  assert.deepEqual(other.headers, {})
})

test("loader GET /models 返回 OpenAI 列表", async () => {
  const { impl } = fakeFetch()
  const plugin = await MuseWorkAuthPlugin({}, { fetch: impl })
  const loader = await plugin.auth.loader(async () => authObject())
  const response = await loader.fetch("https://museai.im/api/v1/models", { method: "GET" })
  assert.equal(response.status, 200)
  const json = await response.json()
  assert.equal(json.object, "list")
  assert.equal(json.data[0].id, "deepseek-v4-1-flash")
})

test("loader POST /chat/completions 流式翻译成 OpenAI chunk", async () => {
  clearAgentCache()
  const { impl, calls } = fakeFetch()
  const plugin = await MuseWorkAuthPlugin({}, { fetch: impl })
  const loader = await plugin.auth.loader(async () => authObject())
  const response = await loader.fetch("https://museai.im/api/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "musework/deepseek-v4-1-flash",
      stream: true,
      reasoning_effort: "high",
      messages: [{ role: "user", content: "hi" }],
    }),
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get("content-type"), /text\/event-stream/)
  const text = await response.text()
  assert.match(text, /"content":"Hi"/)
  assert.match(text, /data: \[DONE\]/)

  const sessionCall = calls.find((call) => call.url.endsWith("/api/v1/sessions") && call.method === "POST")
  assert.ok(sessionCall, "应该建了会话")
  const sessionBody = JSON.parse(sessionCall.body)
  assert.equal(sessionBody.model_key, "deepseek-v4-1-flash")
  assert.equal(sessionBody.reasoning_effort, "high")

  const chatCall = calls.find((call) => call.url.endsWith("/api/v1/chat/completions"))
  const chatBody = JSON.parse(chatCall.body)
  assert.equal(chatBody.session_id, "session-1")
  assert.equal(chatBody.channel_id, "channel-1")
  assert.equal(chatBody.agent_id, "agent-1")
  assert.equal(chatBody.subscribe_stream, true)
  assert.equal(chatBody.content[0].text, "hi")
})

test("loader 非流式折叠成 chat.completion", async () => {
  clearAgentCache()
  const { impl } = fakeFetch()
  const plugin = await MuseWorkAuthPlugin({}, { fetch: impl })
  const loader = await plugin.auth.loader(async () => authObject())
  const response = await loader.fetch("https://museai.im/api/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "deepseek-v4-1-flash", stream: false, messages: [{ role: "user", content: "hi" }] }),
  })
  const json = await response.json()
  assert.equal(json.object, "chat.completion")
  assert.equal(json.choices[0].message.content, "Hi")
})

test("上游 HTTP 400 → 插件返回 400 + invalid_request", async () => {
  clearAgentCache()
  const { impl } = fakeFetch({ chatStatus: 400 })
  const plugin = await MuseWorkAuthPlugin({}, { fetch: impl })
  const loader = await plugin.auth.loader(async () => authObject())
  const response = await loader.fetch("https://museai.im/api/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "deepseek-v4-1-flash", messages: [{ role: "user", content: "hi" }] }),
  })
  assert.equal(response.status, 400)
  const json = await response.json()
  assert.equal(json.error.code, "invalid_request")
  assert.match(json.error.message, /Invalid request/)
})

test("不支持的端点 → 501 not_implemented", async () => {
  const { impl } = fakeFetch()
  const plugin = await MuseWorkAuthPlugin({}, { fetch: impl })
  const loader = await plugin.auth.loader(async () => authObject())
  const response = await loader.fetch("https://museai.im/api/v1/embeddings", { method: "POST", body: "{}" })
  assert.equal(response.status, 501)
  const json = await response.json()
  assert.equal(json.error.code, "not_implemented")
})

test("provider.models 用实时目录", async () => {
  clearAgentCache()
  const { impl } = fakeFetch()
  const plugin = await MuseWorkAuthPlugin({}, { fetch: impl })
  const models = await plugin.provider.models({}, { auth: authObject() })
  assert.deepEqual(Object.keys(models), ["deepseek-v4-1-flash"])
  assert.equal(models["deepseek-v4-1-flash"].capabilities.reasoning, true)
})

test("usage 给出积分窗口", async () => {
  const { impl } = fakeFetch()
  const plugin = await MuseWorkAuthPlugin({}, { fetch: impl })
  const usage = await plugin.auth.usage(async () => authObject())
  assert.equal(usage.plan, "Free")
  assert.equal(usage.windows.length, 1)
  const window = usage.windows[0]
  assert.equal(window.name, "积分")
  assert.equal(window.amount, 9)
  assert.equal(window.limit, 300)
  assert.ok(Number.isFinite(window.used))
  assert.match(window.display, /291 \/ 300 积分/)
})

test("checkin 可领取时真正领取并返回 claimed", async () => {
  const { impl, calls } = fakeFetch({ dailyClaimed: false })
  const plugin = await MuseWorkAuthPlugin({}, { fetch: impl })
  const result = await plugin.auth.checkin(async () => authObject())
  assert.equal(result.outcome, "claimed")
  assert.equal(result.credit, 50)
  assert.equal(result.streak, 1)
  assert.match(result.message, /签到成功，\+50 积分/)
  assert.ok(calls.some((call) => call.url.endsWith("/api/v1/daily-rewards/claim") && call.method === "POST"))
})

test("checkin 今天已领取时返回 done，不再发领取请求", async () => {
  const { impl, calls } = fakeFetch({ dailyClaimed: true })
  const plugin = await MuseWorkAuthPlugin({}, { fetch: impl })
  const result = await plugin.auth.checkin(async () => authObject())
  assert.equal(result.outcome, "done")
  assert.equal(result.streak, 1)
  assert.match(result.message, /今天已签到/)
  assert.ok(!calls.some((call) => call.url.endsWith("/api/v1/daily-rewards/claim")))
})

test("checkin 上游 401 → failed + 重新登录提示", async () => {
  const impl = async (input) => {
    const url = String(input?.url || input)
    if (url.endsWith("/api/v1/daily-rewards/status")) {
      return jsonResponse({ code: "USER_INVALID_TOKEN", message: "Invalid or expired token" }, 401)
    }
    return jsonResponse({ code: "NOT_FOUND", message: "not found" }, 404)
  }
  const plugin = await MuseWorkAuthPlugin({}, { fetch: impl })
  const result = await plugin.auth.checkin(async () => authObject())
  assert.equal(result.outcome, "failed")
  assert.match(result.message, /登录已失效/)
})

test("checkin 活动不可领取但今天未签 → inactive（不误报「已签到」）", async () => {
  const impl = async (input) => {
    const url = String(input?.url || input)
    if (url.endsWith("/api/v1/daily-rewards/status")) {
      return jsonResponse({
        data: {
          claimed_today: false,
          claimable: false,
          continuous_days: 0,
          today_reward: 0,
          monthly_claimed: 0,
          reward_steps: [],
        },
      })
    }
    return jsonResponse({ code: "NOT_FOUND", message: "not found" }, 404)
  }
  const plugin = await MuseWorkAuthPlugin({}, { fetch: impl })
  const result = await plugin.auth.checkin(async () => authObject())
  assert.equal(result.outcome, "inactive")
  assert.match(result.message, /没有可领取的每日奖励/)
})

test("粘贴 Access Token 登录 → success", async () => {
  const { impl } = fakeFetch()
  const plugin = await MuseWorkAuthPlugin({}, { fetch: impl })
  const method = plugin.auth.methods.find((item) => item.label.includes("粘贴"))
  const flow = await method.authorize({ token: TOKEN })
  const result = await flow.callback()
  assert.equal(result.type, "success")
  assert.equal(result.access, TOKEN)
  assert.equal(result.accountId, "user@example.com")
  assert.equal(result.uid, "10000000001")
})

test("本机客户端导入在没登录时给出可操作错误", async (t) => {
  const previous = process.env.MAGPIE_MUSEWORK_HOME
  process.env.MAGPIE_MUSEWORK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "musework-empty-"))
  t.after(() => {
    if (previous === undefined) delete process.env.MAGPIE_MUSEWORK_HOME
    else process.env.MAGPIE_MUSEWORK_HOME = previous
  })
  const plugin = await MuseWorkAuthPlugin({}, {})
  const method = plugin.auth.methods.find((item) => item.label.includes("本机"))
  const flow = await method.authorize()
  const result = await flow.callback()
  assert.equal(result.type, "failed")
  assert.match(result.error, /没有找到本机 MuseWork 登录态/)
})

test("本机有多个账号时逐个导入，导入完给出提示", async (t) => {
  const previous = process.env.MAGPIE_MUSEWORK_HOME
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "musework-multi-"))
  process.env.MAGPIE_MUSEWORK_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.MAGPIE_MUSEWORK_HOME
    else process.env.MAGPIE_MUSEWORK_HOME = previous
  })

  const { localUserDirName } = await import("../src/device.mjs")
  const users = ["10000000001", "10000000002"]
  for (const uid of users) {
    const dir = path.join(home, "users", localUserDirName(uid))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "auth-token.json"), JSON.stringify({
      access_token: jwt({ user_id: uid, exp: Math.floor(Date.now() / 1000) + 86400 }),
      refresh_token: `refresh-${uid}`,
      credential_session: { version: 1, loggedIn: true },
    }))
  }

  // /users/self 按 token 里的 uid 返回不同资料，其余端点不需要。
  const impl = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input?.url || "")
    if (url.endsWith("/api/v1/users/self")) {
      const auth = new Headers(init?.headers || {}).get("authorization") || ""
      const token = auth.replace(/^Bearer\s+/iu, "")
      const uid = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).user_id
      return jsonResponse({ data: { id: uid, email: `${uid}@example.com`, nickname: uid } })
    }
    return jsonResponse({ code: "NOT_FOUND", message: "not found" }, 404)
  }

  const plugin = await MuseWorkAuthPlugin({}, { fetch: impl })
  const method = plugin.auth.methods.find((item) => item.label.includes("本机"))
  const first = await (await method.authorize()).callback()
  const second = await (await method.authorize()).callback()
  const third = await (await method.authorize()).callback()

  assert.equal(first.type, "success")
  assert.equal(second.type, "success")
  assert.notEqual(first.uid, second.uid)
  assert.equal(third.type, "failed")
  assert.match(third.error, /都已导入/)
})

test("并发会话上限：首个请求回 CONCURRENT_SESSION_LIMIT_EXCEEDED，自动重试成功", async () => {
  clearAgentCache()
  let chatCalls = 0
  const impl = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input?.url || "")
    const method = String(init?.method || "GET").toUpperCase()
    if (url.includes("/api/v1/agents")) {
      return jsonResponse({
        data: {
          agents: [{
            agent_id: "agent-1",
            name: "MuBear",
            agent_status: "active",
            channels: [{ channel_id: "channel-1", channel_type: "web" }],
          }],
        },
      })
    }
    if (url.endsWith("/api/v1/sessions") && method === "POST") {
      return jsonResponse({ data: { session_id: `session-${Date.now()}`, channel_id: "channel-1", agent_id: "agent-1" } })
    }
    if (url.includes("/api/v1/sessions/") && url.endsWith("/delete")) {
      return jsonResponse({ data: {} })
    }
    if (url.endsWith("/api/v1/chat/completions")) {
      chatCalls += 1
      if (chatCalls === 1) {
        return sseResponse([
          sse("error", { code: "CONCURRENT_SESSION_LIMIT_EXCEEDED", message: "Concurrent session limit reached" }, 1),
        ])
      }
      return sseResponse(CHAT_FRAMES)
    }
    return jsonResponse({ code: "NOT_FOUND", message: "not found" }, 404)
  }

  const plugin = await MuseWorkAuthPlugin({}, { fetch: impl })
  const loader = await plugin.auth.loader(async () => authObject())
  const response = await loader.fetch("https://museai.im/api/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "deepseek-v4-1-flash", stream: true, messages: [{ role: "user", content: "hi" }] }),
  })
  const text = await response.text()
  assert.equal(chatCalls, 2, "应该重试了一次")
  assert.match(text, /"content":"Hi"/)
  assert.doesNotMatch(text, /CONCURRENT_SESSION_LIMIT_EXCEEDED/)
})

test("客户端取消响应流会 abort 上游 fetch（避免中断后继续扣费）", async () => {
  clearAgentCache()
  let aborted = false
  let streamController = null
  const impl = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input?.url || "")
    const method = String(init?.method || "GET").toUpperCase()
    if (url.includes("/api/v1/agents")) {
      return jsonResponse({ data: { agents: [{
        agent_id: "agent-1", name: "MuBear", agent_status: "active",
        channels: [{ channel_id: "channel-1", channel_type: "web" }],
      }] } })
    }
    if (url.endsWith("/api/v1/sessions") && method === "POST") {
      return jsonResponse({ data: { session_id: "session-cancel", channel_id: "channel-1", agent_id: "agent-1" } })
    }
    if (url.includes("/delete")) return jsonResponse({ data: {} })
    if (url.endsWith("/api/v1/chat/completions")) {
      init.signal?.addEventListener("abort", () => {
        aborted = true
        try { streamController?.close() } catch {}
      }, { once: true })
      const encoder = new TextEncoder()
      return new Response(new ReadableStream({
        start(controller) {
          streamController = controller
          controller.enqueue(encoder.encode(sse("run.start", { run_id: "run-1" }, 1)))
        },
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } })
    }
    return jsonResponse({ code: "NOT_FOUND", message: "not found" }, 404)
  }

  const plugin = await MuseWorkAuthPlugin({}, { fetch: impl })
  const loader = await plugin.auth.loader(async () => authObject())
  const response = await loader.fetch("https://museai.im/api/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "deepseek-v4-1-flash", stream: true, messages: [{ role: "user", content: "hi" }] }),
  })
  await response.body.cancel()
  assert.equal(aborted, true, "上游 fetch 的 signal 应该被 abort")
})

test("工具调用直接透传成 tool_calls", async () => {
  const toolFrames = [
    sse("component.start", { component_type: "tool_call", id: "tc1", payload: { tool_name: "web_search", tool_call_group_id: "call-1" } }, 1),
    sse("component.content", { component_type: "tool_call", id: "tc1", payload: { content: '{"type":"info"}' } }, 2),
    sse("component.end", { component_type: "tool_call", id: "tc1", payload: { response: "ok" } }, 3),
    sse("component.content", { component_type: "reply", id: "r1", payload: { content_delta: "结论" } }, 4),
    sse("session.idle", { session_id: "s1" }, 5),
  ]
  const impl = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input?.url || "")
    const method = String(init?.method || "GET").toUpperCase()
    if (url.includes("/api/v1/agents")) {
      return jsonResponse({ data: { agents: [{
        agent_id: "agent-1", name: "MuBear", agent_status: "active",
        channels: [{ channel_id: "channel-1", channel_type: "web" }],
      }] } })
    }
    if (url.endsWith("/api/v1/sessions") && method === "POST") {
      return jsonResponse({ data: { session_id: "session-1", channel_id: "channel-1", agent_id: "agent-1" } })
    }
    if (url.includes("/delete")) return jsonResponse({ data: {} })
    if (url.endsWith("/api/v1/chat/completions")) return sseResponse(toolFrames)
    return jsonResponse({ code: "NOT_FOUND", message: "not found" }, 404)
  }

  clearAgentCache()
  const plugin = await MuseWorkAuthPlugin({}, { fetch: impl })
  const loader = await plugin.auth.loader(async () => authObject())
  const response = await loader.fetch("https://museai.im/api/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "deepseek-v4-1-flash", stream: true, messages: [{ role: "user", content: "hi" }] }),
  })
  const text = await response.text()
  assert.match(text, /"tool_calls":\[\{"index":0,"id":"call-1","type":"function"/)
  assert.match(text, /"name":"web_search"/)
  assert.match(text, /"content":"结论"/)
})

test("浏览器登录：找不到浏览器时 callback 返回可操作的 failed", async () => {
  const plugin = await MuseWorkAuthPlugin({}, { findBrowser: () => "" })
  const method = plugin.auth.methods.find((item) => item.label.includes("浏览器"))
  assert.ok(method, "应该有浏览器登录方式")
  const flow = await method.authorize()
  assert.equal(flow.opened, true)
  assert.equal(flow.url, "https://museai.im/chat")
  const result = await flow.callback()
  assert.equal(result.type, "failed")
  assert.match(result.error, /没有找到 Chromium 内核浏览器/)
})

test("浏览器登录：authorize 不再有 prompts（密码输入已移除）", async () => {
  const plugin = await MuseWorkAuthPlugin({}, { findBrowser: () => "" })
  const method = plugin.auth.methods.find((item) => item.label.includes("浏览器"))
  assert.equal(method.prompts, undefined)
})

test("_internal 暴露诊断件", () => {
  assert.equal(_internal.PROVIDER, "musework")
  assert.equal(typeof _internal.staticModels, "function")
  assert.equal(typeof _internal.clearCaches, "function")
})
