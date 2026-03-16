export const en = `
start-msg = 👋 I am Jules Bot.
    /sessions - Manage tasks
    /new - Create task
    /cancel - Cancel wizard
    /tz - Set timezone
    /check - Diagnostics

unauthorized = 🚫 Unauthorized.

tz-updated = ✅ Timezone updated to \`{$tz}\`
tz-invalid = ❌ Invalid timezone: \`{$tz}\`

    Examples:
    - \`Asia/Shanghai\`
    - \`Europe/London\`
    - \`UTC\`
tz-title = 🕒 **Timezone Settings**
tz-current = Current: \`{$tz}\`
tz-select = Select a timezone or use: \`/tz Asia/Shanghai\`

lang-title = 🌐 **Language Settings**
lang-current = Current: \`{$lang}\`
lang-select = Select your preferred language:
lang-updated = ✅ Language updated to \`en\` (English)

check-report-title = 🛠 **System Check**
check-admin-id = ✅ Admin ID: \`{$id}\`
check-api-key = ✅ API Key: {$status}
check-webhook-secret = ✅ Webhook Secret: {$status}
check-kv-working = ✅ KV: Working
check-kv-error = ❌ KV: Error ({$error})
check-kv-not-bound = ℹ️ KV: Not bound
check-tracking-list = **Tracking List ({$count}):**
check-no-sessions = _No sessions currently being tracked._
check-api-connected = ✅ API: Connected
check-api-failed = ❌ API: Failed ({$error})

sessions-none = No active sessions.
sessions-recent = Recent Sessions:

wizard-step-repo = 🚀 Step 1: Select a repository:
wizard-step-branch = 🚀 Step 2: Select branch:
wizard-step-mode = 🚀 Step 3: Select mode:
wizard-step-pr = 🚀 Step 4: Auto PR?
wizard-repo-label = 📂 Repo: \`{$repo}\`
wizard-branch-label = 🌿 Branch: \`{$branch}\`
wizard-mode-label = 🛠 Mode: \`{$mode}\`
wizard-mode-interactive = Interactive
wizard-mode-auto = Auto
wizard-pr-label = 📦 PR: \`{$pr}\`
wizard-ready-title = 🚀 **READY TO START**
wizard-reply-prompt = Reply with your task prompt:
wizard-expired = ⚠️ Wizard session expired or not found. Please start over with /new.

cancel-success = ✅ All ongoing /new wizard flows have been cancelled.
cancel-no-kv = ❌ KV not configured.

reply-usage = Usage: /reply [session_id] [message]
reply-success = ✅ Sent to \`{$id}\`. (Now tracking)
reply-failed = ❌ Failed: {$error}

start-session-usage = Usage: /start_session [source] [options] [prompt]
start-session-no-prompt = Please provide a prompt.
start-session-success = 🚀 Started! ID: \`{$id}\`

session-started = 🚀 Session started! ID: \`{$id}\` (Tracked)
session-chat-help = Use /help or reply to a session message to chat.

btn-approve = 👍 Approve Plan
btn-refresh = 🔄 Refresh
btn-activities = 📋 Activities
btn-view-plan = 📋 View Plan
btn-list = 🔙 List
btn-back = 🔙 Back
btn-next = Next ➡️
btn-yes = ✅ Yes
btn-no = ❌ No

status-awaiting-approval = ⚠️ Waiting for Approval
status-awaiting-feedback = ❓ Waiting for Feedback
status-completed = 🎉 Task Completed
status-failed = ❌ Task Failed
status-progress = 🔄 Progress
status-plan-generated = 📋 Plan Generated
status-plan-approved = ✅ Plan Approved
status-user-messaged = 👤 Your Message
status-agent-messaged = 🤖 Jules Message

session-view-title = **Session:** {$title}
session-view-id = **ID:** \`{$id}\`
session-view-status = **Status:** \`{$status}\`
session-view-reply-hint = 💡 _Reply to chat._

activities-title = **Recent Activities**
activity-detail-title = **Activity Detail**
activity-detail-type = **Type:** {$type}

plan-details-title = 📋 **Plan Details**
plan-no-details = Check details on GitHub or Jules web app.
plan-steps-ready = Plan with {$count} steps ready.

last-updated = 🕒 _Last updated: {$time} ({$tz})_
last-updated-fallback = 🕒 _Last updated: {$time} (UTC-Fallback)_

notify-title = 🔔 **Jules Task Update**
notify-reached-milestone = Reached milestone.

error-prefix = ❌ **Bot Error**
error-grammy = Grammy: {$message}
error-telegram = Telegram: {$message}
error-generic = Error: {$message}

msg-no-details = (No details available)
msg-code-changes = Code changes applied.
msg-task-completed = The task was completed successfully.
msg-task-failed = The task failed to complete.
`;
