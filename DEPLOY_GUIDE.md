# Jules Telegram Bot 部署手册

本手册将引导你如何在 Cloudflare Workers 上快速部署自己的 Jules Telegram Bot。

---

## 1. 准备工作

在开始部署之前，请收集以下必要信息：

1.  **Telegram Bot Token**：
    - 在 Telegram 中联系 [@BotFather](https://t.me/botfather)。
    - 使用 `/newbot` 创建机器人并获取 API Token。
2.  **Jules API Key**：
    - 访问 [Jules 网页版](https://jules.google/)。
    - 进入 **Settings -> API Keys** 生成一个新的 Key。
3.  **Telegram User ID**：
    - 在 Telegram 中联系 [@userinfobot](https://t.me/userinfobot) 获取你的数字 ID。
4.  **Cloudflare 账号**：
    - 需要一个活跃的 Cloudflare 账号用于部署 Worker。

---

## 2. 部署方式

### 方法 A：GitHub Actions 自动部署 (推荐)

这是最专业、最安全的方法，支持每当你提交代码时自动更新。

1.  **分叉 (Fork)** 或克隆本仓库到你的 GitHub。
2.  **获取 Cloudflare API Token**：
    - 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
    - 进入 **My Profile -> API Tokens**。
    - 点击 **Create Token**，使用 **Edit Cloudflare Workers** 模板。
    - 复制生成的 Token。
3.  **设置 GitHub Secrets**：
    - 进入你的 GitHub 仓库 -> **Settings -> Secrets and variables -> Actions**。
    - 点击 **New repository secret**。
    - 名称：`CLOUDFLARE_API_TOKEN`，值：填入刚才复制的 Token。
4.  **手动触发或提交代码**：
    - 只要你向 `main` 分支推送代码，部署就会自动开始。
5.  **配置环境变量**：
    - 第一次部署成功后，务必进入 Cloudflare Dashboard -> **Workers & Pages** -> 你的项目 -> **Settings -> Variables**。
    - 手动添加 `TELEGRAM_TOKEN`, `JULES_API_KEY`, `ADMIN_USER_ID`。

---

### 方法 B：使用本地命令行部署

1.  **安装依赖**：`npm install`
2.  **登录**：`npx wrangler login`
3.  **部署**：`npm run deploy`
4.  **配置 Webhook**：访问 `https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<DOMAIN>/webhook`。

---

## 3. (可选) 开启主动通知与存储

为了让 Bot 记录通知历史并主动推送消息，你需要配置 KV 存储：

1.  **创建 KV 命名空间**：
    - Cloudflare 控制台 -> **Workers & Pages -> KV**。
    - 创建名为 `JULES_NOTIFICATIONS_KV` 的空间。
2.  **在控制台绑定 (推荐)**：
    - 进入 Worker -> **Settings -> Variables -> KV Namespace Bindings**。
    - 绑定变量名 `JULES_NOTIFICATIONS_KV` 到刚才创建的空间。
    - *注意：通过网页绑定不会被 GitHub 的自动部署冲掉。*
3.  **设置定时器 (Cron)**：
    - 进入 Worker -> **Settings -> Triggers**。
    - 添加 Cron Trigger：`*/5 * * * *`。

---

## 4. 验证部署

发送 `/start` 给你的 Bot。如果没反应，请运行 `/check` 进行系统诊断，查看哪些配置缺失。
