# magpie-MuseWork

把 [MuseWork](https://museai.im)（Muse AI 的 AI 工作伙伴，MuBear 北极熊）接进 [magpie](https://usemagpie.ai)。

- **Provider id**：`musework`
- **显示名**：MuseWork
- **模型**：`gpt-6.1-terra` / `gpt-6.1-sol` / `gpt-6-astra` / `gpt-6-luna` / `deepseek-v4-1-flash`
  - Free 账号实际可用：`gpt-6-luna`、`deepseek-v4-1-flash`
  - `gpt-6.1-terra` / `gpt-6.1-sol` / `gpt-6-astra` 的 `available:false` 会被服务端**静默降级**到
    `deepseek-v4-1-flash-261017`（插件因此只列 `available:true` 的模型）
- **能力**：流式对话、思考档位（low / medium / high / extra_high / max）、图片输入、积分额度卡片、每日签到

## 快速开始

```bash
magpie plugin add "D:\AI\magpie\magpie-MuseWork"
magpie plugin login musework
```

登录方式三选一：

| 方式 | 需要什么 | 说明 |
|---|---|---|
| **从本机 MuseWork 客户端导入** | 已安装并登录 MuseWork 桌面端 | 零输入，读 `~/.musa/users/*/auth-token.json`；有多个账号时每次点击导入下一个，全部导入后提示 |
| **浏览器登录（打开 museai.im）** | 一个 Chromium 内核浏览器 | 打开临时 Chrome/Edge 窗口，密码 / Google / Apple / 人机验证全交给官方页面；插件优先用浏览器级 CDP 读 `refresh_token` cookie 换 access_token，读不到再回退 `localStorage.musa_auth`。若「安全验证」失败，再点一次「登录」 |
| **粘贴 Access Token** | 一个有效的 `access_token` | 没有浏览器、或想手动控制时的兜底 |

## 它做了什么

| 钩子 | 实现 |
|---|---|
| `config` | 声明 provider + 5 个静态模型（未登录也有目录） |
| `auth.methods` | 三条登录路径（本机导入 / 浏览器登录 / 粘贴 token） |
| `auth.refresh` | `POST /api/v1/auth/tokens/refresh`（Cookie: `refresh_token`） |
| `auth.loader` | 接管 `/chat/completions` 与 `GET /models`，其余 501 |
| `auth.usage` | 积分余额 + 套餐（`credits/balance` + `subscription`） |
| `auth.checkin` | 每日奖励领取（`daily-rewards/status` + `daily-rewards/claim`，D1 50 → D5+ 300） |
| `provider.models` | 实时目录 `GET /api/v1/sessions/models` |
| `chat.headers` | `x-magpie-session-id`（诊断用） |

## 协议（10.0.3 实测）

```
登录      浏览器打开 https://museai.im       localStorage.musa_auth + refresh_token cookie
          （协议层等价于 POST /api/v2/auth/sessions，插件不再直接发密码）
续期      POST /api/v1/auth/tokens/refresh      Cookie: refresh_token=<token>
当前账号  GET  /api/v1/users/self
模型目录  GET  /api/v1/sessions/models[?locale=zh-CN]
智能体    GET  /api/v1/agents?specialty=all     → channels[].channel_id
建会话    POST /api/v1/sessions                 {agent_id,channel_id,model_key,reasoning_effort}
对话      POST /api/v1/chat/completions         SSE: component.start/content/end
额度      GET  /api/v1/credits/balance
套餐      GET  /api/v1/subscription
签到状态  GET  /api/v1/daily-rewards/status
签到领取  POST /api/v1/daily-rewards/claim
```

上游是有状态智能体，`content` 只放「这一轮用户说了什么」。插件把 magpie 的完整
`messages` 压平成一条带角色标记的用户消息（`【系统提示】/【用户】/【助手】/【工具结果】`），
并且**每个请求新建一个会话、结束即删**：

- 不污染用户在 MuseWork 客户端里的会话列表；
- 不同 magpie 会话之间不串上下文；
- 失败重试天然是干净的一轮。

## 边界

- **上游不接受宿主的 `tools`**：MuseWork 智能体用的是自己的工具（web_search / 画图 / bash / 文件），
  不读请求里的 `tools` 数组。模型条目标了 `toolcall: false`。
- **工具调用直接透传**：上游的 `tool_call` 组件会转成标准 OpenAI `tool_calls`
  （`tool_name` → `function.name`，流式 `payload.content` → `function.arguments`），
  客户端可以直接看到/使用。注意工具已在服务端执行、`payload.response` 是结果，
  OpenAI `tool_calls` 没有 result 字段；客户端若再执行同名工具会重复（`bash`/写文件要谨慎）。
- **思考档位**：请求体里的 `reasoning_effort`（或 `reasoning.effort` /
  `providerOptions.musework.reasoningEffort`）会透传给上游；缺省 `medium`。
- **额度口径**：`credits/balance` 的 daily + bonus 两个池合成一条「积分」窗口，
  `resetsAt` 是北京时间次日 00:00。
- **签到**：网页版「每日奖励」的签到（D1 50 → D2 100 → D3 150 → D4 200 → D5+ 300）。
  `daily-rewards/status` 判断今天是否已领，`daily-rewards/claim` 领取；
  领取后 `today_reward` 会变成下一档（D1 50 → D2 100）。

## 本机文件

| 文件 | 用途 |
|---|---|
| `~/.config/magpie/musework-device.json` | 插件自己的 `X-Device-ID`（首次生成） |
| `~/.config/magpie/plugin-auth.json` | magpie 保存的登录态（含 refresh_token） |
| `~/.musa/` | MuseWork 桌面端数据目录（只读，用于「本机导入」） |

## 开发

```bash
npm test                 # 76 个测试
node scripts/probe.mjs   # 用本机客户端登录态跑真机链路
MAGPIE_MUSEWORK_TOKEN_FILE=token.txt node scripts/probe.mjs --plain --image --usage
```

## 许可证

MIT
