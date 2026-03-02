import { Hono } from 'hono';
import { Bot, webhookCallback, InlineKeyboard } from 'grammy';
import { Env, JulesClient, CreateSessionOptions } from './lib/jules';

const app = new Hono<{ Bindings: Env }>();

// --- Helpers ---

async function sendLongMessage(bot: Bot, chatId: string | number, text: string, options: any = {}) {
    const CHUNK_SIZE = 4000;
    for (let i = 0; i < text.length; i += CHUNK_SIZE) {
        await bot.api.sendMessage(chatId, text.substring(i, i + CHUNK_SIZE), options);
    }
}

function getFriendlyType(type: string): string {
    const map: Record<string, string> = {
        'PLAN_GENERATED': '📋 Plan Generated',
        'PLAN_APPROVED': '✅ Plan Approved',
        'USER_MESSAGED': '👤 Your Message',
        'AGENT_MESSAGED': '🤖 Jules Message',
        'SESSION_COMPLETED': '🎉 Task Completed',
        'SESSION_FAILED': '❌ Task Failed',
        'AWAITING_PLAN_APPROVAL': '⚠️ Waiting for Approval',
        'AWAITING_USER_FEEDBACK': '❓ Waiting for Feedback',
        'PROGRESS_UPDATED': '🔄 Progress'
    };
    return map[type] || type || 'ACTIVITY';
}

function getSummary(activity: any, verbose = true): string {
    let raw = '';
    if (activity.agentMessaged?.agentMessage) raw = activity.agentMessaged.agentMessage;
    else if (activity.userMessaged?.userMessage) raw = activity.userMessaged.userMessage;
    else if (activity.planGenerated?.plan) raw = `Plan with ${activity.planGenerated.plan.steps?.length || 0} steps ready.`;
    else if (activity.description) raw = activity.description;
    else if (activity.summary) raw = activity.summary;
    else if (activity.status?.message) raw = activity.status.message;
    else if (activity.userRequest?.prompt) raw = activity.userRequest.prompt;
    else if (activity.agentResponse?.text) raw = activity.agentResponse.text;
    else if (activity.progressUpdated?.description) raw = activity.progressUpdated.description;
    else if (activity.sessionFailed?.reason) raw = activity.sessionFailed.reason;
    else raw = '(No details available)';

    if (!verbose && raw.length > 60) return raw.substring(0, 57) + '...';
    return raw;
}

function formatPlan(activities: any[]): string {
    const planActivity = activities.find(a => a.type === 'PLAN_GENERATED' || a.planGenerated);
    if (!planActivity) return 'Check details on GitHub or Jules web app.';
    const plan = planActivity.planGenerated?.plan;
    if (plan && plan.steps) {
        return plan.steps.map((s: any) => `${s.index + 1}. ${s.title}: ${s.description}`).join('\n');
    }
    return getSummary(planActivity);
}

// Map long callback data to short KV keys if needed
async function getCallbackData(env: Env, prefix: string, sid: string, sub: string): Promise<string> {
    const full = `${prefix}:${sid}:${sub}`;
    if (full.length <= 64) return full;

    // Generate a short ID and store in KV (expires in 1 hour)
    if (!env.JULES_NOTIFICATIONS_KV) return `${prefix}:${sid}:ERR_LONG`;
    const shortId = Math.random().toString(36).substring(2, 8);
    await env.JULES_NOTIFICATIONS_KV.put(`cb:${shortId}`, full, { expirationTtl: 3600 });
    return `cb_map:${shortId}`;
}

// --- Scheduled Task ---

export async function handleScheduled(env: Env) {
  if (!env.JULES_NOTIFICATIONS_KV || !env.TELEGRAM_TOKEN || !env.ADMIN_USER_ID) return;
  const bot = new Bot(env.TELEGRAM_TOKEN);
  const jules = new JulesClient(env.JULES_API_KEY);
  const adminId = env.ADMIN_USER_ID.split(',')[0];

  try {
    const { sessions } = await jules.listSessions();
    if (!sessions) return;
    for (const session of sessions) {
      const sessionId = session.name.split('/').pop();
      const { activities } = await jules.getAllActivities(sessionId);
      if (!activities || activities.length === 0) continue;

      const lastActivity = activities[activities.length - 1];
      if (lastActivity.type === 'PROGRESS_UPDATED') continue;

      const lastActivityId = lastActivity.name;
      const storedId = await env.JULES_NOTIFICATIONS_KV.get(`last_notified:${sessionId}`);
      if (storedId !== lastActivityId) {
        const sigStates = ['AWAITING_PLAN_APPROVAL', 'AWAITING_USER_FEEDBACK', 'COMPLETED', 'FAILED'];
        const isSig = sigStates.includes(session.state) || ['PLAN_GENERATED', 'SESSION_COMPLETED', 'SESSION_FAILED'].includes(lastActivity.type);

        if (isSig) {
          const activityDesc = getSummary(lastActivity);
          await bot.api.sendMessage(adminId,
            `🔔 **Update: ${session.title || session.displayName || sessionId}**\n\n` +
            `**Status:** \`${session.state}\`\n` +
            `**New Activity:** ${getFriendlyType(lastActivity.type)}\n${activityDesc}\n\n` +
            `Use /sessions to manage.`,
            { parse_mode: 'Markdown' }
          );
        }
        await env.JULES_NOTIFICATIONS_KV.put(`last_notified:${sessionId}`, lastActivityId);
      }
    }
  } catch (e) {
    console.error('Notification Error:', e);
  }
}

// --- Bot App ---

app.post('/webhook', async (c) => {
  const bot = new Bot(c.env.TELEGRAM_TOKEN);
  const adminIds = c.env.ADMIN_USER_ID.split(',').map(id => id.trim());
  const jules = new JulesClient(c.env.JULES_API_KEY);

  // 1. Auth Middleware
  bot.use(async (ctx, next) => {
    if (ctx.from && adminIds.includes(ctx.from.id.toString())) {
      return next();
    }
    if (ctx.message?.text?.startsWith('/')) {
      await ctx.reply('🚫 Unauthorized.');
    }
  });

  // 2. High Priority Commands
  bot.command('start', (ctx) => ctx.reply('👋 I am Jules Bot.\n\n/sessions - Manage tasks\n/new - Start task\n/check - Diagnostics'));

  bot.command('check', async (ctx) => {
      let report = "🛠 **System Check**\n\n";
      report += `✅ Admin ID: \`${ctx.from?.id}\` (In whitelist)\n`;
      report += `✅ API Key: ${c.env.JULES_API_KEY ? 'Configured' : '❌ MISSING'}\n`;
      report += `✅ Bot Token: ${c.env.TELEGRAM_TOKEN ? 'Configured' : '❌ MISSING'}\n`;
      if (c.env.JULES_NOTIFICATIONS_KV) {
          try { await c.env.JULES_NOTIFICATIONS_KV.put('check_v3', 'ok'); report += `✅ KV Storage: Working\n`; }
          catch (e: any) { report += `❌ KV Storage: Failed (${e.message})\n`; }
      } else report += `ℹ️ KV Storage: Not bound\n`;
      try { await jules.listSources(); report += `✅ Jules API: Connected\n`; }
      catch (e: any) { report += `❌ Jules API: Failed (${e.message})\n`; }
      await ctx.reply(report, { parse_mode: 'Markdown' });
  });

  bot.command('sessions', async (ctx) => {
    try {
      const { sessions } = await jules.listSessions();
      if (!sessions || sessions.length === 0) return ctx.reply('No active sessions.');
      const keyboard = new InlineKeyboard();
      sessions.slice(0, 10).forEach((s: any) => {
        const id = s.name.split('/').pop();
        keyboard.text(`📝 ${s.title || s.displayName || id}`, `view:${id}`).row();
      });
      await ctx.reply('Recent Sessions:', { reply_markup: keyboard });
    } catch (e: any) { await ctx.reply(`❌ Error: ${e.message}`); }
  });

  bot.command('new', async (ctx) => {
    try {
      const { sources } = await jules.listSources();
      if (!sources || sources.length === 0) return ctx.reply('No repositories found.');
      const keyboard = new InlineKeyboard();
      sources.slice(0, 8).forEach((src: any) => {
        const name = src.name.split('/').pop();
        keyboard.text(name, `create_select:${src.name}`).row();
      });
      await ctx.reply('Select a repository:', { reply_markup: keyboard });
    } catch (e: any) { await ctx.reply(`❌ Error: ${e.message}`); }
  });

  bot.command('reply', async (ctx) => {
    const match = ctx.message?.text?.match(/\/reply\s+([^\s]+)\s+(.+)/);
    if (!match) return ctx.reply('Usage: /reply [session_id] [message]');
    try {
      await jules.sendMessage(match[1], match[2]);
      await ctx.reply(`✅ Sent to \`${match[1]}\`.`);
    } catch (e: any) { await ctx.reply(`❌ Failed: ${e.message}`); }
  });

  bot.command('start_session', async (ctx) => {
    const parts = ctx.message?.text?.split(/\s+/) || [];
    if (parts.length < 3) return ctx.reply('Usage: /start_session [source] [options] [prompt]');
    const sourceName = parts[1];
    let promptParts = [];
    const options: CreateSessionOptions = {};
    for (let i = 2; i < parts.length; i++) {
        const p = parts[i];
        if (p === '-i' || p === '--interactive') options.requirePlanApproval = true;
        else if (p === '-a' || p === '--auto-pr') options.automationMode = 'AUTO_CREATE_PR';
        else if (p === '-b' || p === '--branch') options.startingBranch = parts[++i];
        else if (p === '-t' || p === '--title') {
            let t = []; while (i + 1 < parts.length && !parts[i+1].startsWith('-')) t.push(parts[++i]);
            options.title = t.join(' ');
        } else promptParts.push(p);
    }
    const prompt = promptParts.join(' ');
    if (!prompt) return ctx.reply('Please provide a prompt.');
    try {
      const session = await jules.createSession(sourceName, prompt, options);
      const sessionId = session.name.split('/').pop();
      await ctx.reply(`🚀 Started! ID: \`${sessionId}\`\nMode: ${options.requirePlanApproval ? 'Interactive' : 'Auto'}`);
    } catch (e: any) { await ctx.reply(`❌ Failed: ${e.message}`); }
  });

  // 3. Text Matcher (For Replies & ForceReply)
  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text;
    const replyTo = ctx.message.reply_to_message;

    // Pattern 1: ForceReply for new sessions
    if (replyTo?.text?.includes('Select repo:') || replyTo?.text?.includes('已选择仓库')) {
        const repoMatch = replyTo.text.match(/`([^`]+)`/);
        if (repoMatch) {
            try {
                // Parse options from reply if possible, or default to interactive
                const session = await jules.createSession(repoMatch[1], text, { requirePlanApproval: true });
                const sid = session.name.split('/').pop();
                return ctx.reply(`🚀 Session started! ID: \`${sid}\` (Interactive Mode)`);
            } catch (e: any) { return ctx.reply(`❌ Failed: ${e.message}`); }
        }
    }

    // Pattern 2: Normal reply to a session message
    if (replyTo) {
      const msgText = replyTo.text || replyTo.caption || '';
      const sidMatch = msgText.match(/(?:Session|ID):\s*`?([0-9a-zA-Z_-]+)`?/i);
      if (sidMatch) {
        try {
          await jules.sendMessage(sidMatch[1], text);
          return ctx.reply(`✅ Sent to session \`${sidMatch[1]}\`.`, { reply_to_message_id: ctx.message.message_id });
        } catch (e: any) { return ctx.reply(`❌ Failed: ${e.message}`); }
      }
    }

    await ctx.reply('Reply to a session message to chat, or use /help.');
  });

  // 4. Callback Query Handler
  bot.on('callback_query:data', async (ctx) => {
    // Immediate response to clear loading state
    await ctx.answerCallbackQuery().catch(() => {});

    let rawData = ctx.callbackQuery.data;
    if (rawData.startsWith('cb_map:')) {
        const shortId = rawData.split(':').pop();
        rawData = await c.env.JULES_NOTIFICATIONS_KV?.get(`cb:${shortId}`) || 'error:expired:data';
    }

    const [action, ...args] = rawData.split(':');
    const id = args[0]; // sessionId
    const subId = args[1]; // index

    if (action === 'view') {
      try {
        const session = await jules.getSession(id);
        const title = session.title || session.displayName || id;
        const keyboard = new InlineKeyboard()
          .text('🔄 Refresh', `view:${id}`)
          .text('📋 Activities', `activities:${id}`).row()
          .text('✅ View Plan', `plan_view:${id}`)
          .text('🔙 List', 'sessions_back');

        await ctx.editMessageText(
          `**Session:** ${title}\n**ID:** \`${id}\`\n**Status:** \`${session.state}\`\n**Source:** \`${session.sourceContext?.source || 'Unknown'}\`\n\n💡 _Reply to this to chat._`,
          { parse_mode: 'Markdown', reply_markup: keyboard }
        );
      } catch (e: any) { await ctx.reply(`Error: ${e.message}`); }
    } else if (action === 'sessions_back') {
        const { sessions } = await jules.listSessions();
        const keyboard = new InlineKeyboard();
        sessions?.slice(0, 10).forEach((s: any) => {
          const sid = s.name.split('/').pop();
          keyboard.text(`📝 ${s.title || s.displayName || sid}`, `view:${sid}`).row();
        });
        await ctx.editMessageText('Recent Sessions:', { reply_markup: keyboard });
    } else if (action === 'activities') {
        try {
          const { activities } = await jules.getAllActivities(id);
          const filtered = activities.filter((a: any) => a.type !== 'PROGRESS_UPDATED');
          const keyboard = new InlineKeyboard();
          let listText = `**Recent Activities** (Latest first)\nID: \`${id}\`\n\n`;
          const items = filtered.slice(-5).reverse();
          for (let i=0; i<items.length; i++) {
              const a = items[i];
              const time = new Date(a.createTime).toLocaleTimeString();
              const originalIdx = filtered.length - 1 - i;
              listText += `🕒 ${time} **${getFriendlyType(a.type)}**\n${getSummary(a, false)}\n\n`;
              const cb = await getCallbackData(c.env, 'act_idx', id, originalIdx.toString());
              keyboard.text(`🔍 Details: ${a.type}`, cb).row();
          }
          keyboard.text('🔙 Back', `view:${id}`);
          await ctx.editMessageText(listText.substring(0, 4000), { parse_mode: 'Markdown', reply_markup: keyboard });
        } catch (e: any) { await ctx.reply(`Error: ${e.message}`); }
    } else if (action === 'act_idx') {
        try {
            const { activities } = await jules.getAllActivities(id);
            const filtered = activities.filter((a: any) => a.type !== 'PROGRESS_UPDATED');
            const activity = filtered[parseInt(subId)];
            if (!activity) return ctx.reply('Activity expired.');
            const fullContent = `**Activity Detail**\n**ID:** \`${id}\`\n**Type:** ${getFriendlyType(activity.type)}\n\n${getSummary(activity, true)}`;
            const keyboard = new InlineKeyboard().text('🔙 Back', `activities:${id}`);
            if (fullContent.length <= 4000) await ctx.editMessageText(fullContent, { parse_mode: 'Markdown', reply_markup: keyboard });
            else {
                await sendLongMessage(bot, ctx.chat!.id, fullContent, { parse_mode: 'Markdown' });
                await ctx.reply('^ Full details above.', { reply_markup: keyboard });
            }
        } catch (e: any) { await ctx.reply(`Error: ${e.message}`); }
    } else if (action === 'plan_view') {
      try {
        const session = await jules.getSession(id);
        const { activities } = await jules.getAllActivities(id);
        const planText = formatPlan(activities);
        const keyboard = new InlineKeyboard();
        if (session.state === 'AWAITING_PLAN_APPROVAL') keyboard.text('👍 Approve Plan', `approve_do:${id}`).row();
        keyboard.text('⬅️ Back', `view:${id}`);
        const content = `📋 **Plan Details**\n**ID:** \`${id}\`\n\n${planText}`;
        if (content.length <= 4000) await ctx.editMessageText(content, { parse_mode: 'Markdown', reply_markup: keyboard });
        else {
            await sendLongMessage(bot, ctx.chat!.id, content, { parse_mode: 'Markdown' });
            await ctx.reply('^ Plan details above.', { reply_markup: keyboard });
        }
      } catch (e: any) { await ctx.reply(`Error: ${e.message}`); }
    } else if (action === 'approve_do') {
        try { await jules.approvePlan(id); await ctx.editMessageText(`✅ Approved for \`${id}\`.`); }
        catch (e: any) { await ctx.reply(`Error: ${e.message}`); }
    } else if (action === 'create_select') {
      await ctx.reply(`已选择仓库: \`${id}\`\n\n请**直接回复本条消息**，告诉我你需要 Jules 完成什么任务？\n(支持使用 -b [分支] -a 等高级参数)`, { reply_markup: { force_reply: true } });
    }
  });

  // Set default commands menu
  bot.api.setMyCommands([
    { command: "sessions", description: "View recent sessions" },
    { command: "new", description: "Start a new coding task" },
    { command: "check", description: "System diagnostics" },
    { command: "help", description: "Show help message" }
  ]).catch(() => {});

  return webhookCallback(bot, 'std/http')(c.req.raw);
});

export default {
  fetch: app.fetch,
  scheduled: (event: any, env: Env, ctx: any) => {
    ctx.waitUntil(handleScheduled(env));
  }
};
