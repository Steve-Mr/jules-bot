# Jules Telegram Bot 部署手册

本手册将引导你如何在 Cloudflare Workers 上快速部署自己的 Jules Telegram Bot。

---

## 1. 准备工作

在开始部署之前，请完成以下准备工作：

1.  **获取令牌与 ID**：
    - **Telegram Bot Token**：联系 [@BotFather](https://t.me/botfather) 获取。
    - **Jules API Key**：在 [Jules 网页版设置](https://jules.google/) 中生成。
    - **Telegram User ID**：联系 [@userinfobot](https://t.me/userinfobot) 获取。
    - **Cloudflare Account ID**：在 Cloudflare 控制台的 **Workers & Pages -> 概述** 页面右侧查找。
2.  **创建 KV 命名空间**：
    - 在 Cloudflare Dashboard 中进入 **Workers & Pages -> KV**。
    - 创建一个新的命名空间，建议命名为 `JULES_NOTIFICATIONS_KV`。记录下它的 **ID**。
3.  **定义 Webhook 密钥 (可选但推荐)**：
    - 自行生成一个随机字符串作为 `WEBHOOK_SECRET_TOKEN`（例如：`MySuperSecret123`）。这个密钥由你自主设置，用于确保 Webhook 请求仅来自 Telegram。

---

## 2. 部署方式

### 方法 A：GitHub Actions 自动部署 (推荐 🚀)

这种方式支持在 GitHub 仓库中通过 Secrets 安全地管理所有私密信息。

1.  **分叉 (Fork)** 本仓库。
2.  **配置 GitHub Secrets**：
    - 进入仓库 -> **Settings -> Secrets and variables -> Actions**。
    - 添加以下必填项：
        - `CLOUDFLARE_API_TOKEN`：你的 Cloudflare API 令牌（需具备 Edit Workers 权限）。
        - `CLOUDFLARE_ACCOUNT_ID`：你的 Cloudflare 账户 ID（见第 1 步）。
    - **配置存储与通知**：
        - `JULES_KV_ID`：**必填**。你的 Cloudflare KV 命名空间 ID，用于存储向导状态、回调映射及用户设置。
        - `JULES_CRON`：**可选**。主动通知的定时检查频率，例如 `*/5 * * * *`。
3.  **触发部署**：向 `main` 分支提交代码。
4.  **配置环境变量**：
    - 在 Cloudflare Dashboard 找到你的项目 -> **Settings -> Variables**。
    - 手动添加 `TELEGRAM_TOKEN`, `JULES_API_KEY`, `ADMIN_USER_ID`。

---

### 方法 B：使用本地命令行部署

1.  `npm install`
2.  `npx wrangler login`
3.  `npm run deploy`
4.  **配置 Webhook**：访问以下 URL 以关联 Bot 和服务，并启用安全验证：
    `https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<DOMAIN>/webhook&secret_token=<YOUR_SECRET_TOKEN>`
    *(注：`<YOUR_SECRET_TOKEN>` 应与你在环境变量中设置的 `WEBHOOK_SECRET_TOKEN` 一致)*

---

## 3. 完成环境变量配置

部署完成后，你需要在 Cloudflare Dashboard 的 Worker 设置中完成最后的配置：

1.  **配置环境变量** (Settings -> Variables -> Environment Variables)：
    - `TELEGRAM_TOKEN`: 你的 Bot Token。
    - `JULES_API_KEY`: 你的 Jules API 密钥。
    - `ADMIN_USER_ID`: 你的 Telegram 用户 ID（多个 ID 用英文逗号分隔）。
    - `WEBHOOK_SECRET_TOKEN`: 你在准备阶段自主定义的密钥。
2.  **绑定 KV** (Settings -> Variables -> KV Namespace Bindings)：
    - 添加绑定，变量名为 `JULES_NOTIFICATIONS_KV`，选择你之前创建的命名空间。
3.  **配置定时触发器 (可选)**：
    - 如果需要主动通知功能，请在 **Triggers** 页面添加 Cron 触发器（例如 `*/5 * * * *`）。

---

## 4. 验证与诊断

发送 `/start` 给你的 Bot。如果没反应，请运行 **`/check`** 命令。Bot 会列出当前的配置清单，并指出哪一项配置缺失或失败。
