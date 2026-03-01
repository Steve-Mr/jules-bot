# Jules Telegram Bot

这是一个轻量级的 Telegram Bot，旨在让你通过 Telegram 随时随地管理 Jules AI 编码任务。它支持多 Session 管理、Plan 审批、消息交互，并提供可选的进度主动通知。

## 核心特性
- **无状态设计**：核心操作无需数据库，完全依赖 Telegram 内联按钮进行上下文传递。
- **智能交互**：支持直接“回复”Bot 消息进行聊天，以及长消息自动分块发送。
- **详尽监控**：过滤技术噪音，提供清晰的活动流与 Plan 审批界面。

## 快速开始
1. **部署**：参考 [README_DEPLOY.md](README.md) 进行 Cloudflare Workers 部署。
2. **操作**：阅读 [USER_GUIDE.md](USER_GUIDE.md) 了解如何玩转这个 Bot。

## 开发者参考
- [Jules REST API 本地参考文档](docs/jules-api/overview.md)
- [技术架构设计](DESIGN.md)

## 注意事项
- 本项目基于 Jules v1alpha API。
- 部署需要准备：Telegram Bot Token, Jules API Key, ADMIN_USER_ID。
