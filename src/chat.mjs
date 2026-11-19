// 对话主链路：建会话 → POST /api/v1/chat/completions → 转 SSE。
//
// 上游是**有状态**的智能体：会话里保留历史，content 只放「这一轮用户说了什么」。
// magpie 每次请求都带完整 messages，所以这里把整段对话压平成一条用户消息
// （带角色标记），并且**每个请求新建一个会话、结束即删**：
//   · 不污染用户在 MuseWork 客户端里的会话列表；
//   · 不同 magpie 会话之间不会串上下文；
//   · 失败重试天然是干净的一轮。

import { BASE, PATHS, REASONING_EFFORTS } from "./constants.mjs"
import { chatErrorStatus, errorCode, httpError, upstreamError } from "./errors.mjs"
import { authHeaders, jsonHeaders, requestJson, unwrap } from "./http.mjs"
import { MuseTranslator, foldFrames } from "./translate.mjs"

const LABELS = Object.freeze({
  system: "【系统提示】",
  developer: "【系统提示】",
  user: "【用户】",
  assistant: "【助手】",
  tool: "【工具结果】",
  function: "【工具结果】",
})

const MAX_CONTENT_CHARS = 1_000_000

function textOf(value) {
  return typeof value === "string" ? value : ""
}

function parseImageUrl(url) {
  const text = String(url ?? "").trim()
  if (!text) return null
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/iu.exec(text)
  if (match) {
    return { source: { data: match[2].replace(/\s+/gu, ""), media_type: match[1].toLowerCase() } }
  }
  if (/^https?:\/\//iu.test(text)) return { source: { url: text } }
  return null
}

/**
 * OpenAI messages → MuseWork content 块。
 * 纯单轮 user 消息保持原文（不带角色标记）；多轮/系统提示带【角色】前缀。
 */
export function buildContent(messages) {
  const list = Array.isArray(messages) ? messages.filter((item) => item && typeof item === "object") : []
  const blocks = []
  let index = 0

  const pushText = (value) => {
    const text = String(value ?? "")
    if (!text.trim()) return
    const last = blocks[blocks.length - 1]
    if (last && last.type === "text") {
      last.text += `\n\n${text}`
      return
    }
    blocks.push({ id: `text-${index += 1}`, type: "text", text })
  }

  const pushImage = (url) => {
    const parsed = parseImageUrl(url)
    if (!parsed) return
    blocks.push({
      id: `image-${index += 1}`,
      type: "image",
      image: { source: parsed.source, title: "image" },
    })
  }

  const onlyUser = list.length === 1 && String(list[0].role ?? "").toLowerCase() === "user"

  for (const message of list) {
    const role = String(message.role ?? "user").toLowerCase()
    const label = onlyUser ? "" : (LABELS[role] ?? `【${role}】`)
    const textChunks = []
    const images = []
    const content = message.content

    if (typeof content === "string") {
      textChunks.push(content)
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object") continue
        if (part.type === "text" && typeof part.text === "string") textChunks.push(part.text)
        else if (part.type === "image_url") {
          const url = typeof part.image_url === "string" ? part.image_url : textOf(part.image_url?.url)
          if (url) images.push(url)
        } else if (part.type === "input_image" && typeof part.image_url === "string") {
          images.push(part.image_url)
        } else if (part.type === "image" && typeof part.image === "string") {
          images.push(part.image)
        }
      }
    } else if (content && typeof content === "object" && typeof content.text === "string") {
      textChunks.push(content.text)
    }

    const text = textChunks.join("\n").trim()
    if (text) pushText(label ? `${label}\n${text}` : text)
    for (const url of images) pushImage(url)
  }

  const total = blocks.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 256), 0)
  if (total > MAX_CONTENT_CHARS) {
    throw upstreamError(`对话内容超过 MuseWork 单轮上限（约 ${Math.round(MAX_CONTENT_CHARS / 1000)}k 字符），请开启新会话`, 400, {
      code: "invalid_request",
    })
  }
  return blocks
}

/** 请求体里各种可能的思考档位写法 → 上游 reasoning_effort。 */
export function reasoningEffortOf(body, fallback = "medium") {
  const raw = body?.reasoning_effort
    ?? body?.reasoning?.effort
    ?? body?.providerOptions?.musework?.reasoningEffort
    ?? body?.provider_options?.musework?.reasoning_effort
  const text = String(raw ?? "").trim().toLowerCase()
  if (!text) return fallback
  const normalized = text.replace(/-/gu, "_")
  return REASONING_EFFORTS.includes(normalized) ? normalized : fallback
}

export function timezoneOf() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof tz === "string" && tz && tz.length <= 64 && !/[\r\n]/u.test(tz) ? tz : ""
  } catch {
    return ""
  }
}

/** POST /api/v1/sessions */
export async function createSession(fetchImpl, { token, device, agentId, channelId, modelKey, reasoningEffort, signal } = {}) {
  const { response, body } = await requestJson(fetchImpl, `${BASE}${PATHS.sessions}`, {
    method: "POST",
    headers: jsonHeaders(token, device),
    body: JSON.stringify({
      agent_id: agentId,
      channel_id: channelId,
      ...(modelKey ? { model_key: modelKey } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    }),
    signal,
    timeoutMs: 30_000,
    maxBytes: 1024 * 1024,
  })
  if (!response.ok) throw httpError(response.status, body)
  const data = unwrap(body)
  const sessionId = typeof data?.session_id === "string" ? data.session_id.trim() : ""
  if (!sessionId) throw upstreamError("MuseWork 建会话没有返回 session_id（响应形状变了）", 502, { internal: true })
  return {
    sessionId,
    channelId: typeof data?.channel_id === "string" && data.channel_id ? data.channel_id : channelId,
    agentId: typeof data?.agent_id === "string" && data.agent_id ? data.agent_id : agentId,
  }
}

/** 尽力删除会话（可等待；失败吞掉，不影响结果）。 */
export async function deleteSession(fetchImpl, { token, device, sessionId } = {}) {
  if (!sessionId) return
  try {
    await fetchImpl(`${BASE}${PATHS.sessions}/${encodeURIComponent(sessionId)}/delete`, {
      method: "POST",
      headers: authHeaders(token, device),
    })
  } catch {
    // 删不掉不影响本轮结果
  }
}

/** 并发会话上限：上游回 CONCURRENT_SESSION_LIMIT_EXCEEDED（HTTP 200 + SSE error 帧）。 */
export function isConcurrencyLimit(error) {
  const status = Number(error?.status) || 0
  if (status === 409) return true
  return /CONCURRENT_SESSION|CONCURRENT_LIMIT|CONCURRENT/i.test(
    String(error?.upstreamCode || error?.code || error?.message || ""),
  )
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("请求已取消"), { name: "AbortError" }))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(Object.assign(new Error("请求已取消"), { name: "AbortError" }))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    signal?.addEventListener?.("abort", onAbort, { once: true })
  })
}

const MAX_ATTEMPTS = 3

/** POST /api/v1/chat/completions（返回原始 Response） */
export async function requestChat(fetchImpl, { token, device, payload, signal } = {}) {
  const response = await fetchImpl(`${BASE}${PATHS.chat}`, {
    method: "POST",
    headers: {
      ...authHeaders(token, device),
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(payload),
    signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    let parsed = null
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
    throw httpError(response.status, parsed ?? text)
  }
  if (!response.body) throw upstreamError("MuseWork 上游没有返回响应体", 503)
  return response
}

/**
 * 发一轮对话，返回 OpenAI 兼容的 Response。
 * stream=false 时把整条流折叠成 chat.completion。
 *
 * 并发：上游套餐有 max_concurrent_sessions（免费 1）。超过时回
 * CONCURRENT_SESSION_LIMIT_EXCEEDED；这里在**还没往外发任何正文**时
 * 退避重试（1s / 2s），并用 onDone 把账号级闸门释放掉。
 */
export async function museChat({
  fetchImpl,
  token,
  device,
  agentId,
  channelId,
  modelKey,
  reasoningEffort,
  body,
  stream,
  signal,
  onDone,
  toolMode = "reasoning",
}) {
  const content = buildContent(body?.messages)
  if (!content.length) throw upstreamError("messages 不能为空", 400, { code: "invalid_request" })
  const userTimezone = timezoneOf()
  const encoder = new TextEncoder()

  let released = false
  const release = () => {
    if (released) return
    released = true
    try { onDone?.() } catch {}
  }

  /** 建会话 + 发请求；任一步失败都删掉刚建的会话。 */
  const openTurn = async (turnSignal = signal) => {
    const session = await createSession(fetchImpl, {
      token, device, agentId, channelId, modelKey, reasoningEffort, signal: turnSignal,
    })
    try {
      const response = await requestChat(fetchImpl, {
        token,
        device,
        signal: turnSignal,
        payload: {
          session_id: session.sessionId,
          channel_id: session.channelId,
          agent_id: session.agentId,
          content,
          subscribe_stream: true,
          ...(modelKey ? { model_key: modelKey } : {}),
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          ...(userTimezone ? { user_timezone: userTimezone } : {}),
        },
      })
      return { session, response }
    } catch (error) {
      await deleteSession(fetchImpl, { token, device, sessionId: session.sessionId })
      throw error
    }
  }

  if (!stream) {
    try {
      for (let attempt = 1; ; attempt += 1) {
        try {
          const { session, response } = await openTurn()
          const translator = new MuseTranslator(modelKey, { toolMode })
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          const frames = []
          try {
            while (!translator.done) {
              const { done, value } = await reader.read()
              if (done) {
                frames.push(...translator.push(decoder.decode()))
                break
              }
              frames.push(...translator.push(decoder.decode(value, { stream: true })))
            }
            frames.push(...translator.finish())
          } finally {
            try { await reader.cancel() } catch {}
            await deleteSession(fetchImpl, { token, device, sessionId: session.sessionId })
          }
          return new Response(JSON.stringify(foldFrames(frames, modelKey)), {
            status: 200,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          })
        } catch (error) {
          // 非流式：整轮都没往外发，重试永远安全。
          if (isConcurrencyLimit(error) && attempt < MAX_ATTEMPTS && !signal?.aborted) {
            await sleep(1000 * attempt, signal)
            continue
          }
          throw error
        }
      }
    } finally {
      release()
    }
  }

  // ── 流式：先开回合，HTTP 层错误保留状态码 ──
  // 本轮内部取消源：客户端取消响应流时用它 abort 上游 fetch，
  // 否则上游智能体会继续跑完并扣积分（实测「中断也扣」）。
  let turnController = new AbortController()
  const turnSignal = () => (signal ? AbortSignal.any([signal, turnController.signal]) : turnController.signal)
  let cancelled = false
  let activeReader = null
  let activeSessionId = ""

  const openTurnWithRetry = async (attempt = 1, activeSignal = turnSignal()) => {
    try {
      return await openTurn(activeSignal)
    } catch (error) {
      if (isConcurrencyLimit(error) && attempt < MAX_ATTEMPTS && !activeSignal?.aborted) {
        await sleep(1000 * attempt, activeSignal)
        return openTurnWithRetry(attempt + 1, activeSignal)
      }
      throw error
    }
  }

  let turn
  try {
    turn = await openTurnWithRetry()
  } catch (error) {
    release()
    throw error
  }

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    release()
  }

  const streamBody = new ReadableStream({
    async start(controller) {
      const emit = (frames) => {
        for (const frame of frames) controller.enqueue(encoder.encode(frame))
      }

      let attempt = 1
      try {
        let current = turn
        while (true) {
          let retry = false
          const translator = new MuseTranslator(modelKey, { toolMode })
          const reader = current.response.body.getReader()
          activeReader = reader
          activeSessionId = current.session.sessionId
          const decoder = new TextDecoder()
          try {
            while (!translator.done) {
              const { done, value } = await reader.read()
              if (done) {
                emit(translator.push(decoder.decode()))
                emit(translator.finish())
                break
              }
              try {
                emit(translator.push(decoder.decode(value, { stream: true })))
              } catch (error) {
                // 还没往外发过任何帧 → 可以安全重试；已经发过正文就如实报错。
                if (isConcurrencyLimit(error) && !translator.started && attempt < MAX_ATTEMPTS && !turnSignal().aborted) {
                  retry = true
                  break
                }
                throw error
              }
            }
          } finally {
            activeReader = null
            try { await reader.cancel() } catch {}
            await deleteSession(fetchImpl, { token, device, sessionId: current.session.sessionId })
            activeSessionId = ""
          }

          if (!retry) break
          attempt += 1
          // 新一轮用新的取消源；sleep 期间客户端取消要能立刻退出。
          turnController = new AbortController()
          await sleep(1000 * (attempt - 1), turnSignal())
          if (cancelled) break
          current = await openTurnWithRetry(attempt)
        }
      } catch (error) {
        if (!signal?.aborted && !cancelled) {
          try {
            const status = chatErrorStatus(error)
            const code = errorCode(error)
            const payload = {
              error: {
                message: error?.message || String(error),
                type: status >= 500 ? "upstream_error" : "invalid_request_error",
                code,
                status,
              },
            }
            emit([`data: ${JSON.stringify(payload)}\n\n`])
          } catch {}
        }
      } finally {
        try { controller.close() } catch {}
        close()
      }
    },
    cancel() {
      // 客户端取消：先 abort 上游 fetch（停止计费），再删会话、释放闸门。
      cancelled = true
      try { activeReader?.cancel?.() } catch {}
      try { turnController.abort(new Error("客户端已取消")) } catch {}
      if (activeSessionId) {
        void deleteSession(fetchImpl, { token, device, sessionId: activeSessionId })
        activeSessionId = ""
      }
      close()
    },
  })

  return new Response(streamBody, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
}
