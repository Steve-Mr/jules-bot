export const zh = `
start-msg = 👋 我是 Jules Bot。
    /sessions - 管理任务
    /new - 创建任务
    /cancel - 取消向导
    /tz - 设置时区
    /check - 系统诊断

unauthorized = 🚫 未经授权。

tz-updated = ✅ 时区已更新为 \`{$tz}\`
tz-invalid = ❌ 无效的时区: \`{$tz}\`

    示例:
    - \`Asia/Shanghai\`
    - \`Europe/London\`
    - \`UTC\`
tz-title = 🕒 **时区设置**
tz-current = 当前时区: \`{$tz}\`
tz-select = 请选择时区或使用命令: \`/tz Asia/Shanghai\`

lang-title = 🌐 **语言设置**
lang-current = 当前语言: \`{$lang}\`
lang-select = 请选择你偏好的语言:
lang-updated = ✅ 语言已更新为 \`zh\` (中文)

check-report-title = 🛠 **系统检查报告**
check-admin-id = ✅ 管理员 ID: \`{$id}\`
check-api-key = ✅ API Key: {$status}
check-webhook-secret = ✅ Webhook Secret: {$status}
check-kv-working = ✅ KV: 正常工作
check-kv-error = ❌ KV: 错误 ({$error})
check-kv-not-bound = ℹ️ KV: 未绑定
check-tracking-list = **追踪列表 ({$count}):**
check-no-sessions = _当前没有正在追踪的会话。_
check-api-connected = ✅ API: 已连接
check-api-failed = ❌ API: 连接失败 ({$error})

sessions-none = 没有活跃的会话。
sessions-recent = 最近的会话:

wizard-step-repo = 🚀 第一步：选择仓库:
wizard-step-branch = 🚀 第二步：选择分支:
wizard-step-mode = 🚀 第三步：选择模式:
wizard-step-pr = 🚀 第四步：是否自动创建 PR？
wizard-repo-label = 📂 仓库: \`{$repo}\`
wizard-branch-label = 🌿 分支: \`{$branch}\`
wizard-mode-label = 🛠 模式: \`{$mode}\`
wizard-mode-interactive = 交互模式
wizard-mode-auto = 自动模式
wizard-pr-label = 📦 自动 PR: \`{$pr}\`
wizard-ready-title = 🚀 **准备就绪**
wizard-reply-prompt = 请回复你的任务需求（Prompt）:
wizard-expired = ⚠️ 向导已过期或未找到。请使用 /new 重新开始。

cancel-success = ✅ 所有进行中的 /new 向导流程已取消。
cancel-no-kv = ❌ KV 未配置。

reply-usage = 使用方法: /reply [session_id] [message]
reply-success = ✅ 已发送至 \`{$id}\`。（现已开始追踪）
reply-failed = ❌ 发送失败: {$error}

start-session-usage = 使用方法: /start_session [source] [options] [prompt]
start-session-no-prompt = 请提供 Prompt 内容。
start-session-success = 🚀 已启动！ID: \`{$id}\`

session-started = 🚀 会话已启动！ID: \`{$id}\`（已追踪）
session-chat-help = 使用 /help 或回复会话消息来进行交流。

btn-approve = 👍 审批计划
btn-refresh = 🔄 刷新
btn-activities = 📋 活动流
btn-view-plan = 📋 查看计划
btn-list = 🔙 列表
btn-back = 🔙 返回
btn-next = 下一页 ➡️
btn-yes = ✅ 是
btn-no = ❌ 否

status-awaiting-approval = ⚠️ 等待审批
status-awaiting-feedback = ❓ 等待反馈
status-completed = 🎉 任务完成
status-failed = ❌ 任务失败
status-progress = 🔄 进行中
status-plan-generated = 📋 计划已生成
status-plan-approved = ✅ 计划已批准
status-user-messaged = 👤 你的消息
status-agent-messaged = 🤖 Jules 消息

session-view-title = **会话:** {$title}
session-view-id = **ID:** \`{$id}\`
session-view-status = **状态:** \`{$status}\`
session-view-reply-hint = 💡 _直接回复此消息即可进行聊天。_

activities-title = **最近活动**
activity-detail-title = **活动详情**
activity-detail-type = **类型:** {$type}

plan-details-title = 📋 **计划详情**
plan-no-details = 请在 GitHub 或 Jules 网页端查看详情。
plan-steps-ready = 计划包含 {$count} 个步骤，准备就绪。

last-updated = 🕒 _最后更新: {$time} ({$tz})_
last-updated-fallback = 🕒 _最后更新: {$time} (UTC-回退)_

notify-title = 🔔 **Jules 任务更新**
notify-reached-milestone = 已到达关键节点。

error-prefix = ❌ **Bot 错误**
error-grammy = Grammy: {$message}
error-telegram = Telegram: {$message}
error-generic = 错误: {$message}

msg-no-details = (暂无详情)
msg-code-changes = 已应用代码更改。
msg-task-completed = 任务已成功完成。
msg-task-failed = 任务执行失败。
`;
