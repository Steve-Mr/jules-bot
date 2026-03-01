# Jules Telegram Bot 部署手册

本手册将引导你如何在 Cloudflare Workers 上快速部署自己的 Jules Telegram Bot。

---

## 1. 准备工作

在开始部署之前，请收集以下必要信息：

1.  **Telegram Bot Token**：联系 [@BotFather](https://t.me/botfather) 获取。
2.  **Jules API Key**：在 [Jules 网页版设置](https://jules.google/) 中生成。
3.  **Telegram User ID**：联系 [@userinfobot](https://t.me/userinfobot) 获取你的数字 ID。
4.  **Cloudflare 账号**：用于部署 Worker。

---

## 2. 部署方式

### 方法 A：GitHub Actions 自动部署 (推荐 🚀)

这种方式支持在 GitHub 仓库中通过 Secrets 安全地管理所有私密信息。

1.  **分叉 (Fork)** 本仓库。
2.  **获取 Cloudflare API Token**：
    - 进入 Cloudflare **My Profile -> API Tokens**。
    - 使用 **Edit Cloudflare Workers** 模板创建一个 Token。
3.  **配置 GitHub Secrets**：
    - 进入仓库 -> **Settings -> Secrets and variables -> Actions**。
    - 添加以下必填项：
        - `CLOUDFLARE_API_TOKEN`：你的 Cloudflare API 令牌。
    - **(可选) 添加通知配置**（若定义，CI 会自动在部署时注入）：
        - `JULES_KV_ID`：你的 Cloudflare KV 命名空间 ID。
        - `JULES_CRON`：定时检查频率，例如 `*/5 * * * *`。
4.  **触发部署**：向 `main` 分支提交代码。
5.  **配置环境变量**：
    - 在 Cloudflare Dashboard 找到你的项目 -> **Settings -> Variables**。
    - 手动添加 `TELEGRAM_TOKEN`, `JULES_API_KEY`, `ADMIN_USER_ID`。

---

### 方法 B：使用本地命令行部署

1.  `npm install`
2.  `npx wrangler login`
3.  `npm run deploy`
4.  **配置 Webhook**：访问 `https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<DOMAIN>/webhook`。

---

## 3. 进阶：配置主动通知

为了让 Bot 能够主动推送任务进度，你需要：

1.  **创建 KV**：在 Cloudflare Dashboard 创建一个 KV 命名空间，命名为 `JULES_NOTIFICATIONS_KV`。
2.  **关联 ID**：
    - **Actions 用户**：将得到的 ID 填入 GitHub Secret `JULES_KV_ID`。
    - **命令行用户**：手动在 Cloudflare Dashboard 的 Worker 设置中绑定该 KV。
3.  **设置定时器**：
    - **Actions 用户**：设置 Secret `JULES_CRON`（如 `*/5 * * * *`）。
    - **命令行用户**：在 Dashboard -> **Triggers** 手动添加。

---

## 4. 验证与诊断

发送 `/start` 给你的 Bot。如果没反应，请运行 **`/check`** 命令。Bot 会列出当前的配置清单，并指出哪一项配置缺失或失败。
