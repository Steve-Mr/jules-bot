# Jules Telegram Bot 功能与技术特性总结

本文档全面梳理了目前 Jules Telegram Bot 的产品功能、交互设计及底层技术实现方案。该项目通过在 Cloudflare Workers Serverless 环境下结合 Telegram Bot API 和 Cloudflare KV 存储，实现了一个轻量、稳健、且用户体验良好的 AI 编码助手交互界面。

---

## 一、核心功能与命令交互

Bot 提供了多个实用的命令，用于任务的发起、查看和诊断：

*   **`/new` (任务向导)**: 启动多阶段的任务创建向导，从库选择、分支选择到配置选项。
*   **`/start_session` (极速创建)**: 通过命令行参数直接启动任务（如 `[source] -i -a -b [branch] [prompt]`）。
*   **`/sessions` (任务列表)**: 拉取并展示当前环境下的活跃会话（最近 10 个），通过内联按钮直接跳转到详情页。
*   **`/status` (状态同步)**: 手动触发强制检查当前所有“跟踪中”任务的状态，并广播更新通知，清理已完成状态。
*   **`/reply` (快速回复)**: ` /reply [session_id] [message]` 直接向指定 ID 的会话发送消息。
*   **`/cancel` (终止向导)**: 随时取消并清理用户当前的所有未完成的 `/new` 创建向导状态。
*   **`/tz` (时区设置)**: 允许用户设置个人的时区偏好（如 `Asia/Shanghai`），改变日期时间在 UI 上的呈现方式。
*   **`/check` (系统体检)**: 运行自我诊断，返回系统关键组件状态（Admin 权限、API Keys、KV 绑定状态、Jules API 连通性以及当前追踪列表）。

---

## 二、会话(Session)与向导状态管理

系统的 `/new` 向导是一个分布式的多步表单，完全由基于回调数据的 UI 构成，核心逻辑依赖于轻量级状态存储。

### 1. 向导工作流 (Wizard Flow)
交互路径：**选择仓库 (Repo) -> 目标分支 (Branch) -> 执行模式 (Interactive/Auto) -> 自动提 PR 选项 -> 提交 Prompt**。
用户通过内联键盘 (Inline Keyboard) 完成选项的逐层递进。在最终阶段，系统采用“强制回复” (Force Reply) 获取用户的需求描述并生成任务。

### 2. 状态保持与防并发机制
*   **TTL 过期与存储**: 用户的向导状态封装为一个包含必要上下文参数的对象，保存在 Cloudflare KV 中（带有 30 分钟的 TTL 超时：`WIZARD_EXPIRATION_TTL`）。
*   **资源清理 (`/cancel`)**: 为防止状态残留或多任务并发竞争冲突，系统在 KV 中存储了用户相关的向导前缀引用 (`uwiz:${userId}:${wizId}`)。`/cancel` 命令利用该前缀进行批量查找并彻底删除用户的未完成会话流。

---

## 三、深度交互与消息通讯处理

为了克服在移动端和复杂任务描述场景下所带来的限制，Bot 实现了智能的通讯机制：

### 1. 对话式无感交互 (Contextual Replies)
用户无需频繁复制粘贴 Session ID。只需在 Telegram 内直接**“回复” (Reply)** Bot 曾发出的包含对应 ID 的消息，系统会自动利用多正则回溯识别（如提取 `ID: xxx`，`Session: xxx` 或 `WizID: xxx`），将消息内容映射至特定会话中。

### 2. 长消息的智能切分与合并 (Merge & Split)
*   **消息分块发送**: 由于 Telegram 有单条消息 4000 字符的长度限制，当展示过长的内容（如完整的任务 Plan 或详细的活动摘要）时，Bot 通过 `sendLongMessage` 拦截，并按块自动切割后依次发送。
*   **被动分片消息聚合 (Debounce Merge)**: 当用户输入超出阈值（`MERGE_THRESHOLD` 为 3500 字符）的内容时，Telegram 端也可能截断。系统引入了基于 KV 的“防抖合并”方案：
    *   在接收端短暂缓冲，并设置 `c.executionCtx.waitUntil` 挂起 2 秒 (`MERGE_WAIT_MS`)。
    *   等待期满后将属于同一 Reply-to Context 的碎片自动拼接合并成完整消息，再发起 API 请求。

---

## 四、任务状态跟踪与定时通知系统

Bot 并非只提供被动的操作界面，而是拥有一套轻量的主动状态跟踪轮询机制：

### 1. 注册机制 (`track:registry`)
用户主动创建或进行过消息交互的任务会自动被加入到 `track:registry` KV 表中，并记录最后交互时间 `createTime`。

### 2. 生命周期与轮询过滤
*   系统（可通过 `handleScheduled` 自动触发，或 `/status` 手动触发）提取跟踪队列，跳过 24 小时以上的老旧任务，以及交互后 60 秒内的高频任务（防止接口状态未同步时的 Race Condition）。
*   检查 API 后，若任务状态切入关键里程碑（如 `AWAITING_PLAN_APPROVAL`, `AWAITING_USER_FEEDBACK`, `COMPLETED`, `FAILED`），将更新标志位。

### 3. 多渠道广播
一旦确认状态变迁，系统通过 `Promise.allSettled` 并行向环境变量中配置的所有管理员 (`ADMIN_USER_ID`) 发送内嵌有相关快捷操作按钮（如“审批计划”、“查看消息”）的提醒卡片。
随后系统会将处于终态 (`COMPLETED`, `FAILED`) 的任务从追踪队列剔除。

---

## 五、架构级技术细节与容错设计

### 1. Hono & Cloudflare Workers 环境
整个服务端完全部署在 Cloudflare Serverless 环境中，利用了 Hono 极简框架处理 Telegram Webhook 的 `POST /webhook` 请求，确保极低的冷启动延迟。

### 2. 长 Callback Data 压缩机制
Telegram 原生限制 Inline Keyboard 的 callback_data 最长只有 **64 字节**。而 Jules API 中的仓库名称或资源路径往往超过此限制。系统提供了一套基于 KV 的别名映射 (`getCallbackData`)：如果负载超长，自动将其序列化后存入 KV，并生成一个短码（如 `cb_map:abc123_`），在路由层实现透明的逆解析，彻底突破了数据长度限制。

### 3. Webhook 与接口安全性
*   验证从 Telegram 传来的数据安全性，项目依赖了 `WEBHOOK_SECRET_TOKEN`（Telegram `secret_token` 头部）。
*   内部使用全局错误捕捉并执行 Defensive Programming，规避空对象解引用并跳过 Telegram `message is not modified` 类型误报。异常信息会被主动推送给首位 Admin 账号。

### 4. API 分页透传与聚合
在请求如 `getAllActivities` 等需要大量上下文的历史接口时，Bot 层对最多 3 页的数据进行了无缝聚合，这确保了即便有大量的 `PROGRESS_UPDATED` 噪声数据，经过过滤后呈现给用户的活动队列也是完整而丰富的。

---

## 六、UI 渲染与本地化体验提升

*   **Emoji 与标签系统**: 使用字典结构将冰冷的 API 类型转换为带有情感色彩的视觉元素（例如：`SESSION_COMPLETED` 被渲染为 `🎉 Task Completed`）。
*   **Markdown 安全转换 (`escapeMarkdown`)**: 在进行 Markdown V2 的富文本渲染时，针对包含动态内容的输入进行了严格的安全转义（例如 `_`, `*`, `` ` ``, `[`），预防产生 Telegram UI 解析失败（HTTP 400）。
*   **时间戳本地化**: 系统支持用户的个性化时区偏好，并在关键信息底部统一采用友好的 `🕒 Last updated: HH:mm:ss (Timezone)` 脚标，使用户对任务进展一目了然。