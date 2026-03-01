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

## 2. 部署步骤

### 方法 A：使用命令行部署 (推荐)

1.  **克隆/下载本项目**。
2.  **安装依赖**：
    ```bash
    npm install
    ```
3.  **登录 Cloudflare**：
    ```bash
    npx wrangler login
    ```
4.  **修改配置 (可选)**：
    编辑 `wrangler.toml` 文件，可以根据需要预填变量名或绑定 KV。
5.  **一键部署**：
    ```bash
    npm run deploy
    ```
6.  **配置 Webhook**：
    部署成功后，你会得到一个以 `.workers.dev` 结尾的 URL。请在浏览器中访问以下地址以激活 Bot：
    `https://api.telegram.org/bot<你的BotToken>/setWebhook?url=https://<你的Worker域名>.workers.dev/webhook`

---

### 方法 B：通过 Cloudflare Dashboard 手动部署

1.  在 Cloudflare 控制台创建一个新的 **Worker**。
2.  将 `src/index.ts` 和相关库文件的内容粘贴进去（或者使用 GitHub 关联自动构建）。
3.  **关键：设置环境变量**：
    进入 Worker 的 **Settings -> Variables**，添加以下三个 **Environment Variables**：
    - `TELEGRAM_TOKEN`：你的 Bot Token。
    - `JULES_API_KEY`：你的 Jules API Key。
    - `ADMIN_USER_ID`：你的 Telegram ID（白名单）。

---

## 3. (可选) 开启主动通知功能

如果你希望 Jules 完成任务时自动在 Telegram 弹窗提醒你，请执行以下操作：

1.  **创建 KV 存储**：
    - 在 Cloudflare 控制面板进入 **Workers & Pages -> KV**。
    - 点击 **Create Namespace**，命名为 `JULES_NOTIFICATIONS_KV`。
2.  **绑定 KV**：
    - 进入你的 Worker -> **Settings -> Variables -> KV Namespace Bindings**。
    - 点击 **Add Binding**。
    - 变量名 (Variable name) 填：`JULES_NOTIFICATIONS_KV`。
    - 空间 (KV namespace) 选你刚才创建的那一个。
3.  **配置定时触发器 (Cron)**：
    - 进入你的 Worker -> **Settings -> Triggers**。
    - 点击 **Add Cron Trigger**。
    - 表达式填：`*/5 * * * *` (代表每 5 分钟检查一次进度)。

---

## 4. 验证部署

部署完成后，在 Telegram 中给你的 Bot 发送 `/start`。如果收到欢迎信息，则说明部署成功！你可以接着运行 `/check` 进行全系统自检。
