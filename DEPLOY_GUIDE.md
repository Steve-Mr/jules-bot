# Jules Telegram Bot 部署手册

本手册将引导你如何在 Cloudflare Workers 上快速部署自己的 Jules Telegram Bot。

---

## 1. 准备工作

在开始部署之前，请收集以下必要信息：

1.  **Telegram Bot Token**：联系 [@BotFather](https://t.me/botfather) 获取。
2.  **Jules API Key**：在 [Jules 网页版设置](https://jules.google/) 中生成。
3.  **Telegram User ID**：联系 [@userinfobot](https://t.me/userinfobot) 获取。
4.  **Cloudflare Account ID**：
    - 登录 Cloudflare 控制台。
    - 进入 **Workers & Pages -> 概述**。
    - 在页面右侧边栏可以找到 **Account ID**。

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

## 3. 必选：配置 KV 存储与可选通知

本 Bot 依赖 Cloudflare KV 来处理 `/new` 向导流程、解决 Telegram 回调数据长度限制以及存储用户偏好。

1.  **创建 KV**：在 Cloudflare Dashboard 创建一个 KV 命名空间，命名为 `JULES_NOTIFICATIONS_KV`。
2.  **关联 ID**：
    - **Actions 用户**：将得到的 ID 填入 GitHub Secret `JULES_KV_ID`。
    - **命令行用户**：手动在 Cloudflare Dashboard 的 Worker 设置中绑定该 KV。
3.  **设置定时器 (可选，仅用于主动通知)**：
    - **Actions 用户**：设置 Secret `JULES_CRON`（如 `*/5 * * * *`）。
    - **命令行用户**：在 Dashboard -> **Triggers** 手动添加。

---

## 4. 验证与诊断

发送 `/start` 给你的 Bot。如果没反应，请运行 **`/check`** 命令。Bot 会列出当前的配置清单，并指出哪一项配置缺失或失败。
