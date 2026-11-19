import assert from "node:assert/strict"
import test from "node:test"

import { MuseTranslator, foldFrames } from "../src/translate.mjs"

function sse(event, data, id = 1) {
  return `id:${id}\nevent:${event}\ndata:${JSON.stringify(data)}\n\n`
}

function framesOf(translator, text) {
  return translator.push(text)
}

function toolCallFrames(translator) {
  const frames = []
  frames.push(...translator.push(sse("component.start", {
    component_type: "tool_call", id: "tc1",
    payload: { tool_name: "web_search", tool_call_group_id: "call-1" },
  }, 1)))
  frames.push(...translator.push(sse("component.content", {
    component_type: "tool_call", id: "tc1",
    payload: { content: '{"type":"info","time":"day"}' },
  }, 2)))
  frames.push(...translator.push(sse("component.end", {
    component_type: "tool_call", id: "tc1",
    payload: { response: "search results" },
  }, 3)))
  frames.push(...translator.push(sse("session.idle", { session_id: "s1" }, 4)))
  return frames
}

test("tool_call 默认作为 reasoning 展示，不产生 tool_calls", () => {
  const translator = new MuseTranslator("m")
  const joined = toolCallFrames(translator).join("")
  assert.match(joined, /"reasoning_content":"\\n🔧 web_search "/)
  assert.match(joined, /web_search /)
  assert.match(joined, /\\"type\\":\\"info\\",\\"time\\":\\"day\\"/)
  assert.match(joined, /→ search results/)
  assert.doesNotMatch(joined, /"tool_calls"/)
})

test("tool_calls 透传模式输出标准 tool_calls，折叠时进 message.tool_calls", () => {
  const translator = new MuseTranslator("m", { toolMode: "tool_calls" })
  const frames = toolCallFrames(translator)
  const joined = frames.join("")
  assert.match(joined, /"tool_calls":\[\{"index":0,"id":"call-1","type":"function"/)
  assert.match(joined, /"name":"web_search"/)
  assert.match(joined, /"arguments":"\{\\"type\\":\\"info\\",\\"time\\":\\"day\\"\}"/)

  const folded = foldFrames(frames, "m")
  const calls = folded.choices[0].message.tool_calls
  assert.equal(calls.length, 1)
  assert.equal(calls[0].id, "call-1")
  assert.equal(calls[0].function.name, "web_search")
  assert.equal(calls[0].function.arguments, '{"type":"info","time":"day"}')
})

test("reply 流：role → content → finish → [DONE]", () => {
  const translator = new MuseTranslator("deepseek-v4-1-flash")
  const frames = []
  frames.push(...translator.push(sse("component.start", {
    component_type: "reply", id: "r1",
  }, 1)))
  frames.push(...translator.push(sse("component.content", {
    component_type: "reply", id: "r1", payload: { content_delta: "Hi" },
  }, 2)))
  frames.push(...translator.push(sse("component.content", {
    component_type: "reply", id: "r1", payload: { content_delta: " there" },
  }, 3)))
  frames.push(...translator.push(sse("component.end", {
    component_type: "reply", id: "r1", payload: { content: "Hi there" },
  }, 4)))
  frames.push(...translator.push(sse("run.end", { run_id: "run1" }, 5)))
  frames.push(...translator.push(sse("session.idle", { session_id: "s1" }, 6)))

  const joined = frames.join("")
  assert.match(joined, /"role":"assistant"/)
  assert.match(joined, /"content":"Hi"/)
  assert.match(joined, /"content":" there"/)
  assert.match(joined, /"finish_reason":"stop"/)
  assert.match(joined, /data: \[DONE\]/)
  assert.equal(translator.done, true)
})

test("reasoning 增量走 reasoning_content，不是正文", () => {
  const translator = new MuseTranslator("deepseek-v4-1-flash")
  const frames = []
  frames.push(...translator.push(sse("component.start", { component_type: "reasoning", id: "t1" }, 1)))
  frames.push(...translator.push(sse("component.content", {
    component_type: "reasoning", id: "t1", payload: { delta: "想一想" },
  }, 2)))
  frames.push(...translator.push(sse("component.content", {
    component_type: "reply", id: "r1", payload: { content_delta: "答案" },
  }, 3)))
  frames.push(...translator.push(sse("session.idle", { session_id: "s1" }, 4)))
  const joined = frames.join("")
  assert.match(joined, /"reasoning_content":"想一想"/)
  assert.match(joined, /"content":"答案"/)
  assert.doesNotMatch(joined, /"content":"想一想"/)
})

test("model_request 组件不往外发；tool_call 只看 content 参数", () => {
  const translator = new MuseTranslator("m")
  const frames = []
  frames.push(...translator.push(sse("component.start", { component_type: "model_request", id: "m1" }, 1)))
  frames.push(...translator.push(sse("component.content", {
    component_type: "model_request", id: "m1", payload: { delta: "内部活动" },
  }, 2)))
  // 没有 component.start 的孤儿 tool_call 内容不会展示
  frames.push(...translator.push(sse("component.content", {
    component_type: "tool_call", id: "tc1", payload: { delta: "bash" },
  }, 3)))
  frames.push(...translator.push(sse("session.idle", { session_id: "s1" }, 4)))
  const joined = frames.join("")
  assert.doesNotMatch(joined, /内部活动/)
  assert.doesNotMatch(joined, /bash/)
})

test("error 事件 → 带 status 的 ApiError", () => {
  const translator = new MuseTranslator("m")
  assert.throws(
    () => translator.push(sse("error", { code: "BAD_REQUEST", message: "Invalid request" }, 1)),
    (error) => {
      assert.equal(error.status, 400)
      assert.match(error.message, /BAD_REQUEST/)
      assert.match(error.message, /Invalid request/)
      return true
    },
  )
})

test("error 事件的 401 会标 sessionExpired", () => {
  const translator = new MuseTranslator("m")
  assert.throws(
    () => translator.push(sse("error", { code: "USER_INVALID_TOKEN", message: "expired" }, 1)),
    (error) => {
      assert.equal(error.status, 401)
      assert.equal(error.sessionExpired, true)
      return true
    },
  )
})

test("component.end 没有增量时用完整 content 兜底", () => {
  const translator = new MuseTranslator("m")
  const frames = []
  frames.push(...translator.push(sse("component.start", { component_type: "reply", id: "r1" }, 1)))
  frames.push(...translator.push(sse("component.end", {
    component_type: "reply", id: "r1", payload: { content: "完整回答" },
  }, 2)))
  frames.push(...translator.push(sse("session.idle", { session_id: "s1" }, 3)))
  assert.match(frames.join(""), /"content":"完整回答"/)
})

test("foldFrames 折叠成非流式 chat.completion", () => {
  const translator = new MuseTranslator("deepseek-v4-1-flash")
  const frames = []
  frames.push(...translator.push(sse("component.content", {
    component_type: "reply", id: "r1", payload: { content_delta: "你" },
  }, 1)))
  frames.push(...translator.push(sse("component.content", {
    component_type: "reasoning", id: "t1", payload: { delta: "思考" },
  }, 2)))
  frames.push(...translator.push(sse("component.content", {
    component_type: "reply", id: "r1", payload: { content_delta: "好" },
  }, 3)))
  frames.push(...translator.push(sse("session.idle", { session_id: "s1" }, 4)))
  const folded = foldFrames(frames, "deepseek-v4-1-flash")
  assert.equal(folded.object, "chat.completion")
  assert.equal(folded.model, "deepseek-v4-1-flash")
  assert.equal(folded.choices[0].message.content, "你好")
  assert.equal(folded.choices[0].message.reasoning_content, "思考")
  assert.equal(folded.choices[0].finish_reason, "stop")
})

test("分片到达也能正确解析（半行缓冲）", () => {
  const translator = new MuseTranslator("m")
  const full = sse("component.content", {
    component_type: "reply", id: "r1", payload: { content_delta: "hello" },
  }, 1) + sse("session.idle", { session_id: "s1" }, 2)
  const out = []
  const cut = 17
  out.push(...translator.push(full.slice(0, cut)))
  out.push(...translator.push(full.slice(cut)))
  assert.match(out.join(""), /"content":"hello"/)
  assert.equal(translator.done, true)
})
