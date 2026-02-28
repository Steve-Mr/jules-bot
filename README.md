# Jules Telegram Bot

这是一个轻量级的 Telegram Bot，旨在让你通过 Telegram 随时随地管理 Jules AI 编码任务。它支持多 Session 管理、Plan 审批、消息交互，并提供可选的进度主动通知。

## 功能特性
- **无状态设计**：核心操作无需数据库，完全依赖 Telegram 内联按钮进行上下文传递。
- **多 Session 支持**：轻松切换并管理多个正在进行的 Jules 任务。
- **关键里程碑通知**：集成 Cloudflare KV，当任务有重大进展（如 Plan 生成或任务完成）时主动推送。
- **安全可靠**：内置管理员 ID 白名单验证，确保只有你本人可以调用 Jules API。

## 部署步骤 (Cloudflare Workers)

### 1. 准备工作
- 获取 Telegram Bot Token (通过 [@BotFather](https://t.me/botfather))。
- 获取 Jules API Key (在 Jules 网页版设置中生成)。
- 获取你的 Telegram User ID (可通过 [@userinfobot](https://t.me/userinfobot) 获取)。

### 2. 配置环境变量
在 `wrangler.toml` 中配置，或者在 Cloudflare Dashboard 的 Workers 设置中添加：
- `TELEGRAM_TOKEN`: 你的 Bot Token。
- `JULES_API_KEY`: 你的 Jules API Key。
- `ADMIN_USER_ID`: 你的 Telegram ID (多个 ID 用逗号分隔)。

### 3. (可选) 配置主动通知
如果你需要主动通知功能：
1. 在 Cloudflare 中创建一个 KV Namespace，并将其命名为 `JULES_NOTIFICATIONS_KV`。
2. 在 `wrangler.toml` 中绑定该 KV：
   ```toml
   [[kv_namespaces]]
   binding = "JULES_NOTIFICATIONS_KV"
   id = "<your-kv-id>"
   ```
3. 配置 Cron Trigger (例如每 5 分钟检查一次)：
   ```toml
   [triggers]
   crons = ["*/5 * * * *"]
   ```

### 4. 部署
```bash
npm install
npm run deploy
```

### 5. 设置 Webhook
部署完成后，访问以下 URL 以激活 Bot：
`https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=https://<your-worker-url>/webhook`

## 使用指南
- `/start` - 查看帮助信息。
- `/sessions` - 列出最近的 10 个 Session，点击可进入详情页查看状态、进度或审批 Plan。
- `/new` - 选择一个已关联的仓库并开始新任务。
- `/reply <session_id> <message>` - 向特定的 Session 发送消息。
- `/start_session <source> <prompt>` - 直接启动任务。

## 注意事项
- 本项目目前基于 Jules v1alpha API。
- 免费额度：Cloudflare Workers 每天提供 10 万次请求，KV 提供 1000 次写入，对于个人使用绰绰有余。
