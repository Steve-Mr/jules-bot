import { Hono } from 'hono';
import { Bot, webhookCallback, InlineKeyboard } from 'grammy';
import { Env, JulesClient, CreateSessionOptions } from './lib/jules';

const app = new Hono<{ Bindings: Env }>();

// Helper to safely split and send long messages
async function sendLongMessage(bot: Bot, chatId: string | number, text: string, options: any = {}) {
    const CHUNK_SIZE = 4000;
    for (let i = 0; i < text.length; i += CHUNK_SIZE) {
        await bot.api.sendMessage(chatId, text.substring(i, i + CHUNK_SIZE), options);
    }
}

// Recursive search for a human-readable summary in a Jules Activity object
function getSummary(activity: any, verbose = true): string {
    let raw = '';
    if (activity.description) raw = activity.description;
    else if (activity.summary) raw = activity.summary;
    else if (activity.prompt) raw = activity.prompt;
    else if (activity.text) raw = activity.text;
    else if (activity.status?.message) raw = activity.status.message;
    else if (activity.userRequest?.prompt) raw = activity.userRequest.prompt;
    else if (activity.agentResponse?.text) raw = activity.agentResponse.text;
    else if (activity.progressUpdated?.description) raw = activity.progressUpdated.description;
    else if (activity.progressUpdated?.title) raw = activity.progressUpdated.title;
    else if (activity.userMessaged?.userMessage) raw = activity.userMessaged.userMessage;
    else if (activity.agentMessaged?.agentMessage) raw = activity.agentMessaged.agentMessage;
    else if (activity.sessionFailed?.reason) raw = activity.sessionFailed.reason;
    else raw = '(No details available)';

    if (!verbose && raw.length > 50) return raw.substring(0, 47) + '...';
    return raw;
}

function formatPlan(activities: any[]): string {
    const planActivity = activities.find(a =>
        a.type === 'PLAN_GENERATED' || a.planGenerated ||
        (a.description && a.description.toLowerCase().includes('plan')) ||
        (a.summary && a.summary.toLowerCase().includes('plan'))
    );
    if (!planActivity) return 'Check details on GitHub or Jules web app.';

    const plan = planActivity.planGenerated?.plan;
    if (plan && plan.steps) {
        return plan.steps.map((s: any) => `${s.index + 1}. ${s.title}: ${s.description}`).join('\n');
    }

    return getSummary(planActivity);
}

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
      const { activities } = await jules.getActivities(sessionId);
      if (!activities || activities.length === 0) continue;

      const lastActivity = activities[activities.length - 1];
      if (lastActivity.type === 'PROGRESS_UPDATED') continue;

      const lastActivityId = lastActivity.name;
      const storedId = await env.JULES_NOTIFICATIONS_KV.get(`last_notified:${sessionId}`);
      if (storedId !== lastActivityId) {
        const significantTypes = ['PLAN_GENERATED', 'SESSION_COMPLETED', 'SESSION_FAILED', 'AWAITING_PLAN_APPROVAL', 'AWAITING_USER_FEEDBACK'];
        const isSignificant = significantTypes.includes(lastActivity.type) ||
                              session.state === 'AWAITING_PLAN_APPROVAL' ||
                              session.state === 'AWAITING_USER_FEEDBACK';
        if (isSignificant) {
          const activityDesc = getSummary(lastActivity);
          await bot.api.sendMessage(adminId,
            `🔔 **Update for Session \`${session.title || session.displayName || sessionId}\`**\n\n` +
            `**Status:** \`${session.state}\`\n` +
            `**New Activity:** ${activityDesc}\n\n` +
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

app.post('/webhook', async (c) => {
  const bot = new Bot(c.env.TELEGRAM_TOKEN);
  const adminIds = c.env.ADMIN_USER_ID.split(',').map(id => id.trim());
  const jules = new JulesClient(c.env.JULES_API_KEY);

  bot.use(async (ctx, next) => {
    if (ctx.from && adminIds.includes(ctx.from.id.toString())) {
      return next();
    }
    if (ctx.message?.text?.startsWith('/')) {
      await ctx.reply('🚫 Unauthorized.');
    }
  });

  bot.command('start', (ctx) => ctx.reply('👋 Hello! I am your Jules Bot.\n\n/sessions - List active sessions\n/new - Start a new session'));

  bot.command('sessions', async (ctx) => {
    try {
      const { sessions } = await jules.listSessions();
      if (!sessions || sessions.length === 0) {
        return ctx.reply('No active sessions found.');
      }
      const keyboard = new InlineKeyboard();
      sessions.slice(0, 10).forEach((s: any) => {
        const id = s.name.split('/').pop();
        const label = s.title || s.displayName || id;
        keyboard.text(`📝 ${label}`, `view:${id}`).row();
      });
      await ctx.reply('Recent Sessions:', { reply_markup: keyboard });
    } catch (e: any) {
      await ctx.reply(`❌ Error: ${e.message}`);
    }
  });

  bot.command('new', async (ctx) => {
    try {
      const { sources } = await jules.listSources();
      if (!sources || sources.length === 0) {
        return ctx.reply('No repositories found.');
      }
      const keyboard = new InlineKeyboard();
      sources.slice(0, 8).forEach((src: any) => {
        const name = src.name.split('/').pop();
        keyboard.text(name, `create_select:${src.name}`).row();
      });
      await ctx.reply('Select a repository:', { reply_markup: keyboard });
    } catch (e: any) {
      await ctx.reply(`❌ Error: ${e.message}`);
    }
  });

  bot.on('message:text', async (ctx) => {
    if (ctx.message.reply_to_message) {
      const replyTo = ctx.message.reply_to_message;
      const text = replyTo.text || replyTo.caption || '';
      const sessionIdMatch = text.match(/(?:Session|ID):\s*`?([0-9a-zA-Z_-]+)`?/i);

      if (sessionIdMatch) {
        const sessionId = sessionIdMatch[1];
        try {
          await jules.sendMessage(sessionId, ctx.message.text);
          await ctx.reply(`✅ Replied to session \`${sessionId}\`.`, { reply_to_message_id: ctx.message.message_id });
          return;
        } catch (e: any) {
          await ctx.reply(`❌ Failed to send reply: ${e.message}`);
          return;
        }
      }
    }
    if (!ctx.message.text.startsWith('/')) {
        await ctx.reply('Type /help to see available commands. To reply to a session, use the "Reply" feature on a session message.');
    }
  });

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const [action, ...args] = data.split(':');
    const id = args[0]; // sessionId
    const subId = args[1]; // index

    if (action === 'view') {
      try {
        const session = await jules.getSession(id);
        const status = session.state || 'UNKNOWN';
        const title = session.title || session.displayName || id;
        const keyboard = new InlineKeyboard()
          .text('🔄 Refresh', `view:${id}`)
          .text('📋 Activities', `activities:${id}`).row()
          .text('✅ View/Approve Plan', `plan_view:${id}`).row()
          .text('🔙 Back to List', 'sessions_back');

        await ctx.editMessageText(
          `**Session:** ${title}\n**ID:** \`${id}\`\n**Status:** \`${status}\`\n**Source:** \`${session.sourceContext?.source || session.source || 'Unknown'}\`\n\n💡 _Tip: Reply to this message to send a chat to Jules._`,
          { parse_mode: 'Markdown', reply_markup: keyboard }
        );
      } catch (e: any) {
        await ctx.answerCallbackQuery(`Error: ${e.message}`);
      }
    } else if (action === 'sessions_back') {
        const { sessions } = await jules.listSessions();
        const keyboard = new InlineKeyboard();
        sessions.slice(0, 10).forEach((s: any) => {
          const sid = s.name.split('/').pop();
          const label = s.title || s.displayName || sid;
          keyboard.text(`📝 ${label}`, `view:${sid}`).row();
        });
        await ctx.editMessageText('Recent Sessions:', { reply_markup: keyboard });
    } else if (action === 'activities') {
        try {
          const { activities } = await jules.getActivities(id);
          const filtered = activities.filter((a: any) => a.type !== 'PROGRESS_UPDATED');
          const keyboard = new InlineKeyboard();

          let listText = `Recent activities for \`${id}\`:\n\n`;
          const itemsToShow = filtered.slice(-5).reverse();
          itemsToShow.forEach((a: any, idx: number) => {
              const time = new Date(a.createTime).toLocaleTimeString();
              const type = a.type || 'ACTIVITY';
              const summary = getSummary(a, false);
              listText += `🕒 ${time} **${type}**\n${summary}\n\n`;
              const originalIndex = filtered.length - 1 - idx;
              keyboard.text(`🔍 Details: ${type}`, `act_idx:${id}:${originalIndex}`).row();
          });
          keyboard.text('🔙 Back', `view:${id}`);

          if (listText.length > 4000) listText = listText.substring(0, 3900) + '... (List truncated)';
          await ctx.editMessageText(listText, { parse_mode: 'Markdown', reply_markup: keyboard });
        } catch (e: any) {
          await ctx.answerCallbackQuery(`Error: ${e.message}`);
        }
    } else if (action === 'act_idx') {
        try {
            const { activities } = await jules.getActivities(id);
            const filtered = activities.filter((a: any) => a.type !== 'PROGRESS_UPDATED');
            const index = parseInt(subId);
            const activity = filtered[index];

            if (!activity) return ctx.answerCallbackQuery('Activity expired.');

            const time = new Date(activity.createTime).toLocaleString();
            const fullContent = `**Activity Detail**\n\n**Session ID:** \`${id}\`\n**Time:** ${time}\n**Type:** ${activity.type}\n\n${getSummary(activity, true)}`;

            const keyboard = new InlineKeyboard().text('🔙 Back to List', `activities:${id}`);

            if (fullContent.length <= 4000) {
                await ctx.editMessageText(fullContent, { parse_mode: 'Markdown', reply_markup: keyboard });
            } else {
                await ctx.answerCallbackQuery('Long content...');
                await sendLongMessage(bot, ctx.chat!.id, fullContent, { parse_mode: 'Markdown' });
                await ctx.reply('^ Full details above.', { reply_markup: keyboard });
            }
        } catch (e: any) {
            await ctx.answerCallbackQuery(`Error: ${e.message}`);
        }
    } else if (action === 'plan_view') {
      try {
        const session = await jules.getSession(id);
        const { activities } = await jules.getActivities(id);
        const planText = formatPlan(activities);
        const keyboard = new InlineKeyboard();
        if (session.state === 'AWAITING_PLAN_APPROVAL') {
            keyboard.text('👍 Approve Plan', `approve_do:${id}`).row();
        }
        keyboard.text('⬅️ Back', `view:${id}`);
        const header = `📋 **Plan Details:**\n\n**ID:** \`${id}\`\n${session.state === 'AWAITING_PLAN_APPROVAL' ? '⚠️ Approval Required!' : ''}\n\n`;
        const fullContent = header + planText;
        if (fullContent.length <= 4000) {
            await ctx.editMessageText(fullContent, { parse_mode: 'Markdown', reply_markup: keyboard });
        } else {
            await sendLongMessage(bot, ctx.chat!.id, fullContent, { parse_mode: 'Markdown' });
            await ctx.reply('^ Plan details above.', { reply_markup: keyboard });
        }
      } catch (e: any) {
        await ctx.answerCallbackQuery(`Error: ${e.message}`);
      }
    } else if (action === 'approve_do') {
        try {
            await jules.approvePlan(id);
            await ctx.editMessageText(`✅ Plan approved for session \`${id}\`.`, { parse_mode: 'Markdown' });
        } catch (e: any) {
            await ctx.answerCallbackQuery(`Error: ${e.message}`);
        }
    } else if (action === 'create_select') {
      await ctx.editMessageText(`Source selected: \`${id}\`\n\nTo start, send:\n\`/start_session ${id} [Options] Your prompt\`\n\n**Available Options:**\n- \`-b [branch]\`: Specify branch\n- \`-i\`: Interactive (require plan approval)\n- \`-a\`: Auto create PR\n- \`-t [title]\`: Set session title\n\n**Example:**\n\`/start_session ${id} -i -b develop Fix layout issues\``, { parse_mode: 'Markdown' });
    }
    await ctx.answerCallbackQuery();
  });

  bot.command('reply', async (ctx) => {
    const text = ctx.message?.text || '';
    const match = text.match(/\/reply\s+([^\s]+)\s+(.+)/);
    if (!match) return ctx.reply('Usage: /reply [session_id] [message]');
    const [, sessionId, message] = match;
    try {
      await jules.sendMessage(sessionId, message);
      await ctx.reply(`✅ Message sent to \`${sessionId}\`.`);
    } catch (e: any) {
      await ctx.reply(`❌ Failed: ${e.message}`);
    }
  });

  // Handle advanced /start_session
  bot.command('start_session', async (ctx) => {
    const text = ctx.message?.text || '';
    const parts = text.split(/\s+/);
    if (parts.length < 3) return ctx.reply('Usage: /start_session [source] [options] [prompt]');

    const sourceName = parts[1];
    let promptParts: string[] = [];
    const options: CreateSessionOptions = {};

    for (let i = 2; i < parts.length; i++) {
        const p = parts[i];
        if (p === '-i' || p === '--interactive') {
            options.requirePlanApproval = true;
        } else if (p === '-a' || p === '--auto-pr') {
            options.automationMode = 'AUTO_CREATE_PR';
        } else if (p === '-b' || p === '--branch') {
            options.startingBranch = parts[++i];
        } else if (p === '-t' || p === '--title') {
            // Collect title words until next flag or end
            let titleParts = [];
            while (i + 1 < parts.length && !parts[i+1].startsWith('-')) {
                titleParts.push(parts[++i]);
            }
            options.title = titleParts.join(' ');
        } else {
            promptParts.push(p);
        }
    }

    const prompt = promptParts.join(' ');
    if (!prompt) return ctx.reply('Please provide a prompt.');

    try {
      const session = await jules.createSession(sourceName, prompt, options);
      const sessionId = session.name.split('/').pop();
      await ctx.reply(`🚀 Session started! ID: \`${sessionId}\`\nMode: ${options.requirePlanApproval ? 'Interactive' : 'Auto'}\nBranch: ${options.startingBranch || 'main'}`, { parse_mode: 'Markdown' });
    } catch (e: any) {
      await ctx.reply(`❌ Failed to start: ${e.message}`);
    }
  });

  return webhookCallback(bot, 'std/http')(c.req.raw);
});

export default {
  fetch: app.fetch,
  scheduled: (event: any, env: Env, ctx: any) => {
    ctx.waitUntil(handleScheduled(env));
  }
};
