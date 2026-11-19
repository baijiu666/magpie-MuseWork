# MuseWork 请求链路全表

> 2026-11-15 真机实测。`BASE = https://museai.im`。
> 每个链路都标了代码位置（`src/` 下的文件）和触发时机。

## 0. 总览

```
magpie 宿主
   │  ① /v1/models             → provider.models()   → GET  /api/v1/sessions/models
   │  ② /v1/chat/completions   → loader.fetch()      → GET  /api/v1/agents
   │                                                   POST /api/v1/sessions
   │                                                   POST /api/v1/chat/completions (SSE)
   │                                                   POST /api/v1/sessions/{id}/delete
   │  ③ /v1/magpie/quotas      → auth.usage()        → GET  /api/v1/credits/balance
   │                                                   GET  /api/v1/subscription
   │  ④ 每日签到               → auth.checkin()      → GET  /api/v1/daily-rewards/status
   │                                                   POST /api/v1/daily-rewards/claim
   └─ 登录/续期                → auth.methods/refresh → POST /api/v2/auth/sessions
                                                       POST /api/v1/auth/tokens/refresh
                                                       GET  /api/v1/users/self
```

## 1. 本地链路（不联网）

| 读取 | 文件 | 用途 | 代码 |
|---|---|---|---|
| 设备身份 | `~/.config/magpie/musework-device.json` | 生成/复用 `X-Device-ID` | `src/device.mjs` |
| 当前账号 | `~/.musa/active-account.json` | 取 `localScopeId` / `accountId` | `src/auth.mjs` `readLocalAccount` |
| 登录态 | `~/.musa/users/<sha256("musa-browser-v1\0"+uid)>/auth-token.json` | `access_token` / `refresh_token` / `expires_at` | 同上 |
| 旧布局兜底 | `~/.musa/auth-token.json`、`~/.musa/users/*/auth-token.json` | 同上 | 同上 |

## 2. 登录链路（三选一）

### 2A. 从本机客户端导入（零输入）

```
读 ~/.musa/active-account.json → localScopeId
读 ~/.musa/users/<hash>/auth-token.json
  └─ 若 access_token 过期且带 refresh_token：
       POST /api/v1/auth/tokens/refresh
GET  /api/v1/users/self        （校验并取显示名）
→ {type:"success", access, refresh, expires, accountId, uid, metadata}
```

### 2B. 浏览器登录（打开 museai.im）

插件不直接发密码：起一个**临时 Chromium profile**（`--user-data-dir=<tmp> --remote-debugging-port=0`，
带 `--disable-blink-features=AutomationControlled`），打开 `https://museai.im/chat`，
用户在官方页面完成密码 / Google / Apple / 人机验证。插件每 2s 读一次登录态，**优先走浏览器级 CDP**：

```js
// ① 浏览器级 WebSocket（/json/version），不 attach 页面、不碰 Runtime 域
Storage.getCookies {} → 找 domain 为 museai.im 的 refresh_token（HttpOnly）
  → POST /api/v1/auth/tokens/refresh 换 access_token

// ② 拿不到 cookie 才回退：页面 Runtime.evaluate 读 localStorage.musa_auth
JSON.stringify({ auth: localStorage.getItem("musa_auth"), uid: localStorage.getItem("musa_uid") })
```

拿到 `access_token` 后 `GET /api/v1/users/self` 校验并组装登录态；`refresh_token` 一起存，
用于续期。临时 profile 用完即删，不碰用户日常浏览器配置。
可用 `MAGPIE_MUSEWORK_BROWSER` 指定浏览器 exe。

> 协议层等价于 `POST /api/v2/auth/sessions {identity,password[,captcha_token]}`，
> 但插件不碰密码——验证码 / 风控 / OAuth 全交给官方页面。
>
> ⚠ Turnstile 是**风险评分**制：同一出口 IP 连续挑战可能一直不过（实测有时 2s 出 token、
> 有时 35s 超时）。失败时页面显示「人机验证未完成，请重试」，**再点一次「登录」**即可重新发起；
> 持续失败就改用「粘贴 Access Token」或「从本机客户端导入」。

### 2C. 粘贴 Access Token

只解析本地字符串（裸 JWT / `Bearer …` / `auth-token.json` 全文），
然后 `GET /api/v1/users/self` 校验；不发登录请求。

## 3. 续期链路

```http
POST /api/v1/auth/tokens/refresh
Content-Type: application/json
X-Device-Type: desktop
X-Device-ID: <device.id>
Cookie: refresh_token=<refresh_token>
```

```json
{"data":{"access_token":"eyJ…","expires_in":31536000},"result":"ok"}
```

- 旧的 access_token 立即失效（**实测**：之后再用旧 token 会 `USER_INVALID_TOKEN`）。
- refresh_token 不轮转；若响应带了新的 `Set-Cookie: refresh_token` 则采纳。
- 触发：`expires - now < refreshLead`（token 寿命一半，最少 1 分钟、最多 24 小时）。
- 401 → `throw Object.assign(new Error(...), {signIn:"expired"})`；其它错误保持旧 token。

## 4. 模型目录链路

```http
GET /api/v1/sessions/models?locale=zh-CN
Authorization: Bearer <access_token>
X-Device-Type: desktop
X-Device-ID: <device.id>
```

```json
{"data":{
  "models":[{
    "key":"gpt-6-astra","name":"GPT-6 Astra","description":"…","category":"advanced",
    "available":false,"credit_usage_rate":5,"supports_images":true,"is_new":false,
    "reasoning_efforts":["low","medium","high","extra_high","max"],
    "default_reasoning_effort":"medium"
  }],
  "default_basic":"deepseek-v4-1-flash",
  "default_advanced":"gpt-6.1-terra"
},"result":"ok"}
```

插件处理：

- `available === false` 的模型**过滤掉**（服务端会静默降级到 `default_basic`，见 `docs/MODEL-FINGERPRINT.md`）。
- 全部不可用时退回全部，避免 0 models。
- 缓存 10 分钟（`catalogCache`）。

## 5. 对话链路（一次 `/v1/chat/completions` 的完整序列）

```http
GET /api/v1/agents?specialty=all
Authorization: Bearer <access_token>
X-Device-Type: desktop
X-Device-ID: <device.id>
```

```json
{"data":{"agents":[{
  "agent_id":"<agent_id>","name":"MuBear","agent_status":"active",
  "channels":[{"channel_id":"<channel_id>","channel_type":"web"}]
}]},"result":"ok"}
```

→ 取 `agent_id` + 第一个 `channel_type:"web"` 的 `channel_id`（缓存 5 分钟）。

```http
POST /api/v1/sessions
Authorization: Bearer <access_token>
X-Device-Type: desktop
X-Device-ID: <device.id>
Content-Type: application/json

{"agent_id":"…","channel_id":"…","model_key":"deepseek-v4-1-flash","reasoning_effort":"medium"}
```

```json
{"data":{"session_id":"121392…","channel_id":"…","agent_id":"…","title":"Untitled","model_key":"deepseek-v4-1-flash"},"result":"ok"}
```

> 注意：`model_key` 不可用时服务端返回空串，`GET /sessions/{id}/model-selection` 会显示降级后的真实模型。

```http
POST /api/v1/chat/completions
Authorization: Bearer <access_token>
X-Device-Type: desktop
X-Device-ID: <device.id>
Content-Type: application/json
Accept: text/event-stream

{
  "session_id":"…","channel_id":"…","agent_id":"…",
  "content":[
    {"id":"text-1","type":"text","text":"【用户】\n你好"},
    {"id":"image-2","type":"image","image":{"source":{"data":"<base64>","media_type":"image/png"},"title":"image"}}
  ],
  "subscribe_stream":true,
  "model_key":"deepseek-v4-1-flash",
  "reasoning_effort":"medium",
  "user_timezone":"Asia/Shanghai"
}
```

SSE 事件序列（真机）：

```
event:user.content        {"content":[…],"question":"…","session_id":"…"}
event:run.start           {"group_id":"…","run_id":"…"}
event:turn.start          {"group_id":"…","id":"…","parent_id":"…","payload":{}}
event:component.start     {"component_type":"reasoning","id":"…","parent_id":"…","payload":{}}
event:component.content   {"component_type":"reasoning","id":"…","payload":{"delta":"…"}}
event:component.start     {"component_type":"reply","id":"…","payload":{}}
event:component.content   {"component_type":"reply","id":"…","payload":{"content_delta":"Hi"}}
event:component.start     {"component_type":"model_request","id":"model:…","payload":{}}
event:component.end       {"component_type":"model_request","payload":{"model_timing":{"model":"deepseek-v4-1-flash-261017","first_token_ms":961,"status":"ok",…}}}
event:component.end       {"component_type":"reply","payload":{"content":"Hi","type":"text"}}
event:turn.end            {"component_type":"AGENT_TURN","id":"…"}
event:run.end             {"group_id":"…","run_id":"…"}
event:session.idle        {"session_id":"…","stats_delta":{"credits":3,…}}
event:error               {"code":"BAD_REQUEST","message":"…"}   ← 出错时
```

插件翻译：

- `reply` 的 `payload.content_delta` → OpenAI `delta.content`
- `reasoning` 的 `payload.delta` → `delta.reasoning_content`
- `component.end(reply)` 的 `payload.content` 只在没有增量时兜底
- `tool_call`：默认作为 `reasoning_content` 展示（`🔧 工具名` + 参数 + 结果预览）；插件选项 `tool_calls_passthrough` 打开后转成标准 OpenAI `tool_calls`
- `model_request` / `summary`：不往外发
- `session.idle` → finish chunk + `data: [DONE]`
- `error` → 错误帧 `{"error":{message,type,code,status}}`（HTTP 200 已定）

```http
POST /api/v1/sessions/{session_id}/delete
Authorization: Bearer <access_token>
X-Device-Type: desktop
X-Device-ID: <device.id>
```

每轮结束（成功 / 失败 / 取消）都删；删除失败吞掉。客户端取消响应流时会额外 abort 本轮的 `AbortSignal`（`turnController`），让上游 fetch 立即断开，避免模型继续跑完扣积分。

## 6. 额度链路

```http
GET /api/v1/credits/balance
GET /api/v1/subscription
```

```json
// balance
{"data":[
  {"credit_type":"daily","total_credits":100,"remaining_credits":75},
  {"credit_type":"bonus","total_credits":250,"remaining_credits":250}
],"result":"ok"}

// subscription
{"data":{"tier_label":"Free","plan_tier":"free","subscription_status":"",
  "quota":{"daily_credits":100,"max_concurrent_tasks":1,"max_concurrent_sessions":1,
           "max_files_per_upload":3,"max_assistant_seats":1}},"result":"ok"}
```

卡片：`used = Σ(total-remaining)`、`limit = Σtotal`、`resetsAt = 北京时间次日 00:00`；
`plan = tier_label`。缓存 60 秒。

## 7. 签到链路

```http
GET /api/v1/daily-rewards/status
```

```json
{"data":{"server_now":1794688853877,"claimed_today":false,"claimable":true,
  "continuous_days":0,"today_reward":50,"monthly_claimed":0,
  "next_claim_at":1794758400000,"reward_steps":[50,100,150,200,300]},"result":"ok"}
```

可领 → 

```http
POST /api/v1/daily-rewards/claim
Content-Type: application/json

{}
```

```json
{"data":{"claimed_today":true,"claimable":false,"continuous_days":1,
  "today_reward":100,"monthly_claimed":50,"next_claim_at":1794758400000,
  "reward_steps":[50,100,150,200,300],"already_claimed":false,"granted_credits":50},"result":"ok"}
```

映射：`claimed_today`/`!claimable` → `done`；`granted_credits>0` → `claimed`；
401 → `failed`。领取后 `today_reward` 变下一档。

## 8. 宿主侧（Magpie → 插件）

| 请求 | 插件入口 | 说明 |
|---|---|---|
| `GET /v1/models` | `provider.models()` + `loader.fetch` | 返回 OpenAI model 列表 |
| `POST /v1/chat/completions` | `loader.fetch` | 只实现这个和 `/models`，其它 501 |
| `GET /v1/magpie/quotas` | `auth.usage()` | 积分窗口 |
| 每日调度 | `auth.checkin()` | 北京时间每账号每天一次 |
| 每请求 | `"chat.headers"` | 加 `x-magpie-session-id`（诊断用） |

## 9. 重试 / 并发链路

| 情况 | 行为 |
|---|---|
| `CONCURRENT_SESSION_LIMIT_EXCEEDED`（HTTP 200 + SSE error） | **每账号一个**闸门（`src/semaphore.mjs`，按 `cacheKeyOf(auth)` 分桶，limit = `max_concurrent_sessions`）；账号间互不排队。还没发正文时 1s/2s 退避重试，最多 3 次 |
| `401` / `USER_INVALID_TOKEN` | 标记 `session_expired`，宿主换号或要求重登 |
| 5xx / 超时 | 原样透传（502/503/504），宿主换号 |
| 客户端 abort | abort 本轮上游 fetch、取消上游流、删会话、释放闸门 |

## 10. 测试脚本额外用的请求

| 脚本 | 额外请求 |
|---|---|
| `scripts/probe.mjs` | 无（走插件自身链路） |
| `scripts/fingerprint.mjs` | `GET /api/v1/credits/ledger?page=1&page_size=5` 看 `resource_details[].model` |
| 指纹取证（一次性） | `GET /api/v1/sessions/{id}/model-selection` 看真实 `model_key` |
