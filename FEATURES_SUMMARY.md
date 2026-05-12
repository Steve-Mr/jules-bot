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

---

## 七、Cloudflare KV 的全景式应用解析

由于 Cloudflare Workers 是无状态的 Serverless 环境，本项目将 **Cloudflare KV** 视为整个系统的状态引擎与内存总线，主要涵盖了以下六大维度的深度应用：

1.  **用户偏好存储 (`tz:{userId}`)**
    *   **作用**: 持久化用户的时区设置（如 `Asia/Shanghai`）。
    *   **机制**: 简单键值对，无过期时间。

2.  **长 Callback Data 压缩与映射 (`cb:{shortId}`)**
    *   **作用**: 突破 Telegram 强加的 64 bytes 回调数据长度限制。
    *   **机制**: 当底层参数拼装后超长时，系统拦截并随机生成一个 6 字符的 `shortId`。将原本的超长字符串作为 Value 存入 KV，过期时间 (TTL) 设为 3600 秒（1 小时）。UI 层下发形如 `cb_map:{shortId}` 的简短标识，点击回调时在中间件层进行逆向解析，实现对开发者的透明化扩展。

3.  **多步表单状态驻留 (`wiz:{wizId}`)**
    *   **作用**: 支撑 `/new` 向导的多步流转（仓库 -> 分支 -> 模式 -> PR）。
    *   **机制**: 序列化 JSON 存储 `WizardState` 对象。每一次用户点击下一步，都会携带当前的 `wizId`，系统读取老状态，追加新属性，再保存回 KV。TTL 统一为 30 分钟。

4.  **防并发与用户会话清理 (`uwiz:{userId}:{wizId}`)**
    *   **作用**: 实现 `/cancel` 的批量清理能力。
    *   **机制**: 基于前缀的辅助索引结构。每次创建新的 `wiz` 时，同步写入带有用户 ID 前缀的映射键。`/cancel` 触发时利用 `KV.list({ prefix })` 扫出该用户所有的暂存会话并执行批量 `Promise.all` 删除，杜绝脏数据。

5.  **主动追踪与广播注册表 (`track:registry`)**
    *   **作用**: 实现会话生命周期的异步状态监控与管理员广播机制。
    *   **机制**: 单 Key 存储整个序列化的 JSON 数组，记录所有正在运行任务的 `sessionId`, `title`, 和 `createTime`（最后交互时间）。通过定时任务 (Cron/Scheduled) 定期提取进行比对轮询，并在触发终端状态时自我净化（Remove）。

6.  **防抖与长消息合并缓冲池 (`m:{userId}:{replyToId}:*`)**
    *   **作用**: 应对 Telegram 发送超过 3500 字符文本时的强制物理截断。
    *   **机制**:
        *   碎片池 (`m:...:c:{msgId}`): 暂存被截断的零碎文本。
        *   锁存器 (`m:...:last`): 记录最后到达的区块 ID。
        *   通过 `waitUntil` 异步挂起 2 秒（模拟事件总线防抖）。期满后通过前缀拉取所有碎片，依照 ID 升序拼接为一整段文字交由主逻辑处理。

---

## 八、Telegram API 机制的深度融合

本项目在交互设计上并未停留在简单的“一问一答”层面，而是深入利用了 Telegram 的多种高级机制：

1.  **ForceReply 强制引导机制**
    *   在 `/new` 向导进行到最后一步（要求输入 Prompt）时，下发的 Message 会携带 `reply_markup: { force_reply: true }`。这会让用户的输入框自动弹起并强制引用该条消息。这一设计配合消息中的隐藏 `WizID`，使得服务端能 100% 准确地将自然语言归属于特定的向导上下文中。

2.  **正则上下文提取与免 ID 交互**
    *   支持用户以极其自然的体验回复 (Reply) Bot。系统利用了严谨的多重正则表达式（含负向零宽断言 `(?<!Wiz)` 避免 ID 碰撞），从历史引用的气泡文本中精确提取 `Session ID`。无需用户记忆或复制任何晦涩的系统标识符。

3.  **状态机驱动的 Inline Keyboard**
    *   Bot 核心 UI 构建在内联键盘上，通过统一定义 `CallbackAction` 常量字典消除魔法字符串。按钮不单纯是超链接，而是充当了状态机的 Trigger，点击后系统会利用 `editMessageText` 在原气泡内原地刷新 UI 与进度（消除重绘和刷屏感），提供类似 App 的体验。

4.  **Grammy 全局异常拦截与过滤**
    *   捕获了未捕获的 Rejection 与 API Error。特别是针对因内容未改变而重复提交 `editMessageText` 导致的特有报错 (`message is not modified`)，实现了定制化过滤，避免了无意义的日志噪音。

---

## 九、核心工程亮点与创新总结

总体而言，本代码库展示了以下几个突出的工程亮点：

*   **真正的 Serverless 弹性架构**：所有的长时等待（如防抖合并）、状态流转（向导缓存）、异步推送（定时检查），全部被巧妙地降维并映射到了 Cloudflare KV 与原生 Worker 特性 (`waitUntil`) 之上。无需部署 Redis、数据库或长连接服务器，极大降低了运维成本。
*   **极致的防御性编程 (Defensive Programming)**：从数据入口到呈现层处处设防。针对 API 解析有完整的 `try...catch`；针对 KV 获取有默认回退 (Fallback) 值；针对 Markdown 解析有 `escapeMarkdown` 兜底；严格避免了针对 `ctx.from` 和 `ctx.chat` 的非空断言，确保服务在边界条件下的强韧性。
*   **降噪与聚焦的产品体验**：在 Activity 列表中过滤掉海量无意义的 `PROGRESS_UPDATED` 轮询噪音；针对成功/失败采用友好的短语兜底 (`sessionCompleted` 映射)；针对文本溢出进行智能分片 (`sendLongMessage`)。一切技术实现均服务于“极简、可控”的用户体验。