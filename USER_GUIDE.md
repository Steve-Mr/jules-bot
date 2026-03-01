# Jules Telegram Bot 功能与操作指南

本手册详细介绍了 Jules Telegram Bot 的已实现功能、核心技术机制以及具体操作方法。

---

## 1. 核心功能概览

### 1.1 Session 管理
- **新建任务 (`/new`)**：浏览关联的仓库并直接发起 Jules 编码任务。
- **任务列表 (`/sessions`)**：展示最近的 10 个活跃任务，支持点击进入详情页。
- **详情查看**：显示 Session 的标题、ID、当前状态（如 `IN_PROGRESS`）以及关联仓库。

### 1.2 监控与审批
- **活动历史 (Activities)**：查看任务最近的动态（已过滤掉繁杂的技术细节，如进度更新）。
- **详情钻取**：点击特定活动的“详情”按钮，查看完整的 API 原始返回（如生成的代码摘要、报错原因等）。
- **Plan 审批**：当 Jules 需要用户审批 Plan 时，Bot 会提供 Markdown 格式的步骤列表，并显示“👍 Approve”按钮。

### 1.3 深度消息交互
- **自动回复**：**无需指令**。直接在 Telegram 中“回复 (Reply)”Bot 发出的任何带有 Session ID 的消息，即可将回复内容发送给 Jules。
- **命令回复 (`/reply`)**：作为备选方案，支持通过 `[session_id] [message]` 格式发送消息。

### 1.4 主动通知 (可选)
- **关键里程碑提醒**：集成 Cloudflare KV，当任务状态变为“等待审批”或“已完成/失败”时，Bot 会主动推送消息通知。

---

## 2. 技术运行机制

为了在 Cloudflare Workers 这种 Serverless 环境下提供流畅体验，Bot 采用了以下方案：

| 挑战 | 解决方案 | 运作原理 |
|---|---|---|
| **无状态 (Stateless)** | Inline Keyboards | 大部分数据（如 Session ID）埋在按钮的 `callback_data` 中，点击时即时解析。 |
| **数据超限 (64 字节)** | ID 索引压缩 | 在 Activities 视图中，不传递长 UUID，而是传递数组索引（Index），点击详情时实时拉取并定位。 |
| **消息过长 (4096 字符)** | 自动拆分 (Chunking) | 如果 Plan 或详情过长，Bot 会自动将其拆分为多条 4000 字符以内的消息先后发送。 |
| **垃圾信息过滤** | 智能解析器 | `getSummary` 函数会递归探测 7+ 个可能的 API 字段，自动过滤掉 `PROGRESS_UPDATED` 等噪音。 |

---

## 3. 具体操作指南

### 3.1 发起新任务
1. 输入 `/new`。
2. 在弹出的内联按钮中点击仓库名。
3. 根据提示，输入 `/start_session [仓库名] [你的需求]`（例如 `/start_session sources/github/xxx/yyy 帮我修复这个 bug`）。

### 3.2 查看与审批
1. 输入 `/sessions`。
2. 点击你感兴趣的任务。
3. **查看进度**：点击 `📋 Activities`。
4. **审批 Plan**：点击 `✅ View/Approve Plan` -> 查看步骤 -> 点击 `👍 Approve`。

### 3.3 与 Jules 对话
1. 进入某个 Session 的详情页（或者点击 Activities 里的某个活动）。
2. 在 Telegram 中长按该消息，选择 **Reply (回复)**。
3. 输入你的意见并发送。
4. Bot 会自动识别当前上下文并将消息传达给 Jules。

---

## 4. 参数与配置

### 4.1 环境变量 (Variables)
- `ADMIN_USER_ID`: 你的数字 ID（决定了谁能用这个 Bot，也是通知的接收者）。
- `TELEGRAM_TOKEN`: Bot 令牌。
- `JULES_API_KEY`: Jules 的认证密钥。

### 4.2 API 适配 (v1alpha)
- **Base URL**: `https://jules.googleapis.com/v1alpha`
- **发送字段**: 使用 `prompt` 字段发送用户消息。
- **状态名**: 严格匹配 `AWAITING_PLAN_APPROVAL` 等官方状态枚举。
