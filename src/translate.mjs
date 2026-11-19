// 上游 SSE → OpenAI chat.completion.chunk。
//
// MuseWork 的事件（2026-11-15 真机抓取）：
//   event: user.content      回显用户消息（忽略）
//   event: run.start         {run_id, group_id}
//   event: turn.start        {id, parent_id}
//   event: component.start   {component_type:"reply"|"reasoning"|"model_request"|"tool_call"|…}
//   event: component.content {component_type, payload:{content_delta|delta, …}}
//   event: component.end     {component_type:"reply", payload:{content, finish_reason?}}
//   event: turn.end          {component_type:"AGENT_TURN"}
//   event: run.end           {run_id}
//   event: session.idle      {session_id, stats_delta:{credits,…}}
//   event: error             {code:"BAD_REQUEST", message:"…"}
//
// 正文在 reply 的 content_delta；思考在 reasoning 的 delta。
// 工具调用（tool_call）默认作为 reasoning 展示（宿主不会执行）；开启「工具调用透传」后
// 转成标准 OpenAI tool_calls。注意：工具是**服务端执行**的，payload.response 才是结果。

import { upstreamError, upstreamStatus } from "./errors.mjs"

const KNOWN_FINISH = new Set(["stop", "length", "tool_calls", "content_filter", "function_call"])

function finishReasonOf(value) {
  const text = String(value ?? "").trim().toLowerCase()
  if (!text) return ""
  return KNOWN_FINISH.has(text) ? text : text === "max_tokens" ? "length" : "stop"
}

function textOf(value) {
  return typeof value === "string" ? value : ""
}

export class MuseTranslator {
  constructor(model, { id, created, toolMode } = {}) {
    this.model = String(model || "")
    this.created = Number.isFinite(created) ? created : Math.floor(Date.now() / 1000)
    this.id = id || `chatcmpl-musework-${this.created}-${Math.random().toString(36).slice(2, 8)}`
    this.buffer = ""
    this.eventName = ""
    this.dataLines = []
    this.started = false
    this.finished = false
    this.finishEmitted = false
    this.finishReason = ""
    this.contentChars = 0
    // 上游工具调用（web_search / 画图 / 文件…）：
    //   reasoning 模式（默认）→ 作为 reasoning_content 展示，宿主不会执行；
    //   tool_calls 模式 → 标准 OpenAI tool_calls，客户端可以选择执行。
    this.toolMode = toolMode === "tool_calls" ? "tool_calls" : "reasoning"
    this.toolCalls = new Map()
    this.toolCallCount = 0
  }

  frame(value) {
    return `data: ${JSON.stringify(value)}\n\n`
  }

  delta(delta) {
    return this.frame({
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: null }],
    })
  }

  start(out) {
    if (this.started) return
    this.started = true
    out.push(this.delta({ role: "assistant", content: "" }))
  }

  /** 上游开始一个工具调用。 */
  toolStart(data, out) {
    const payload = data?.payload && typeof data.payload === "object" ? data.payload : {}
    const name = textOf(payload.tool_name) || "tool"
    const key = String(data?.id || payload.tool_call_group_id || name)
    const id = textOf(payload.tool_call_group_id) || key
    const index = this.toolCallCount
    this.toolCallCount += 1
    this.toolCalls.set(key, { index, id, name, args: "" })
    this.start(out)
    if (this.toolMode === "tool_calls") {
      out.push(this.delta({ tool_calls: [{ index, id, type: "function", function: { name, arguments: "" } }] }))
    } else {
      out.push(this.delta({ reasoning_content: `\n🔧 ${name} ` }))
    }
  }

  /** 工具参数是流式 JSON 片段（payload.content）。 */
  toolContent(data, out) {
    const key = String(data?.id || "")
    const entry = this.toolCalls.get(key)
    const text = textOf(data?.payload?.content)
    if (!entry || !text) return
    entry.args += text
    if (this.toolMode === "tool_calls") {
      out.push(this.delta({ tool_calls: [{ index: entry.index, function: { arguments: text } }] }))
    } else {
      out.push(this.delta({ reasoning_content: text }))
    }
  }

  /** 工具执行结束；payload.response 是服务端已经拿到的结果。 */
  toolEnd(data, out) {
    const key = String(data?.id || "")
    const entry = this.toolCalls.get(key)
    if (!entry) return
    if (this.toolMode === "reasoning") {
      const response = textOf(data?.payload?.response)
      const preview = response ? response.replace(/\s+/gu, " ").slice(0, 160) : ""
      out.push(this.delta({ reasoning_content: `\n${preview ? `→ ${preview}…` : "→ 完成"}\n` }))
    }
    this.toolCalls.delete(key)
  }

  /** 喂一段字节解码后的文本，返回已经转好的 OpenAI 帧。 */
  push(text) {
    const out = []
    if (this.finished) return out
    this.buffer += String(text ?? "")
    let index
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/u, "")
      this.buffer = this.buffer.slice(index + 1)
      try {
        this.line(line, out)
      } catch (error) {
        error.frames = out
        throw error
      }
      if (this.finished) break
    }
    return out
  }

  /** 上游断流/结束时收尾（幂等）。 */
  finish() {
    const out = []
    if (this.finished) return out
    if (this.buffer.trim()) {
      try {
        this.line(this.buffer.replace(/\r$/u, ""), out)
      } catch (error) {
        error.frames = out
        throw error
      }
      this.buffer = ""
    }
    try {
      this.dispatch(out)
    } catch (error) {
      error.frames = out
      throw error
    }
    this.finalize(out)
    return out
  }

  line(line, out) {
    if (this.finished) return
    if (!line) { this.dispatch(out); return }
    if (line.startsWith(":")) return
    if (line.startsWith("id:")) return
    if (line.startsWith("event:")) { this.eventName = line.slice(6).trim(); return }
    if (line.startsWith("data:")) {
      this.dataLines.push(line.slice(5).trimStart())
    }
  }

  dispatch(out) {
    const event = this.eventName
    const payloadText = this.dataLines.join("\n")
    this.eventName = ""
    this.dataLines = []
    if (!event && !payloadText) return

    let data = null
    if (payloadText) {
      try {
        data = JSON.parse(payloadText)
      } catch {
        throw upstreamError(`MuseWork 上游返回了无法解析的 SSE 数据帧：${payloadText.slice(0, 120)}`, 502)
      }
    }

    if (event === "error") {
      this.finished = true
      const code = typeof data?.code === "string" ? data.code : ""
      const message = typeof data?.message === "string" && data.message ? data.message : "上游错误"
      const status = upstreamStatus(code)
      const error = upstreamError(`MuseWork 上游返回 ${code || "错误"}：${message}`, status, { upstreamCode: code })
      if (status === 401) error.sessionExpired = true
      if (status === 403) error.permissionDenied = true
      throw error
    }

    if (event === "component.start") {
      if (data?.component_type === "reply") this.start(out)
      else if (data?.component_type === "tool_call") this.toolStart(data, out)
      return
    }

    if (event === "component.content") {
      const type = data?.component_type
      const payload = data?.payload && typeof data.payload === "object" ? data.payload : {}
      if (type === "reply") {
        const text = textOf(payload.content_delta) || textOf(payload.content) || textOf(payload.delta)
        if (text) {
          this.start(out)
          this.contentChars += text.length
          out.push(this.delta({ content: text }))
        }
      } else if (type === "reasoning") {
        const text = textOf(payload.delta) || textOf(payload.content) || textOf(payload.content_delta)
        if (text) {
          this.start(out)
          out.push(this.delta({ reasoning_content: text }))
        }
      } else if (type === "tool_call") {
        this.toolContent(data, out)
      }
      return
    }

    if (event === "component.end") {
      if (data?.component_type === "reply") {
        const reason = finishReasonOf(data?.payload?.finish_reason)
        if (reason) this.finishReason = reason
        // component.end 的 payload.content 是完整正文；如果前面没收到增量，补一帧。
        const full = textOf(data?.payload?.content)
        if (full && this.contentChars === 0) {
          this.start(out)
          this.contentChars += full.length
          out.push(this.delta({ content: full }))
        }
      } else if (data?.component_type === "tool_call") {
        this.toolEnd(data, out)
      }
      return
    }

    if (event === "run.end") return
    if (event === "session.idle") { this.finalize(out); return }
    // user.content / turn.start / turn.end / 其他：忽略
  }

  finalize(out) {
    if (this.finished) return out
    this.finished = true
    this.start(out)
    if (!this.finishEmitted) {
      this.finishEmitted = true
      out.push(this.frame({
        id: this.id,
        object: "chat.completion.chunk",
        created: this.created,
        model: this.model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: this.finishReason || "stop",
        }],
      }))
    }
    out.push("data: [DONE]\n\n")
    return out
  }

  get done() {
    return this.finished
  }
}

/** 非流式：把同一套帧折叠成一个 chat.completion 对象。 */
export function foldFrames(frames, model = "") {
  let id = ""
  let created = 0
  let resolvedModel = model
  let content = ""
  let reasoning = ""
  let finish = "stop"
  const toolCalls = new Map()
  for (const raw of frames) {
    const line = String(raw).trim()
    if (!line.startsWith("data:")) continue
    const payload = line.slice(5).trim()
    if (payload === "[DONE]") continue
    let frame
    try { frame = JSON.parse(payload) } catch { continue }
    id ||= typeof frame.id === "string" ? frame.id : ""
    created ||= Number(frame.created) || 0
    resolvedModel ||= typeof frame.model === "string" ? frame.model : ""
    const choice = frame.choices?.[0]
    if (!choice) continue
    const delta = choice.delta || {}
    if (typeof delta.content === "string") content += delta.content
    if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const index = Number.isInteger(call?.index) ? call.index : toolCalls.size
      const item = toolCalls.get(index) || { id: "", type: "function", function: { name: "", arguments: "" } }
      if (typeof call?.id === "string" && call.id) item.id = call.id
      if (typeof call?.function?.name === "string" && call.function.name) item.function.name = call.function.name
      if (typeof call?.function?.arguments === "string") item.function.arguments += call.function.arguments
      toolCalls.set(index, item)
    }
    if (typeof choice.finish_reason === "string" && choice.finish_reason) finish = choice.finish_reason
  }
  const message = { role: "assistant", content: content || "" }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.size) {
    message.tool_calls = [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)
  }
  return {
    id: id || `chatcmpl-musework-${Math.floor(Date.now() / 1000)}`,
    object: "chat.completion",
    created: created || Math.floor(Date.now() / 1000),
    model: resolvedModel,
    choices: [{ index: 0, message, finish_reason: finish }],
  }
}

