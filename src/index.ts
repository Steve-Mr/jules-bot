import { Hono } from 'hono';
import { Bot, webhookCallback, InlineKeyboard } from 'grammy';
import { Env, JulesClient, CreateSessionOptions } from './lib/jules';

const app = new Hono<{ Bindings: Env }>();

async function sendLongMessage(bot: Bot, chatId: string | number, text: string, options: any = {}) {
  const CHUNK_SIZE = 4000;
  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    await bot.api.sendMessage(chatId, text.substring(i, i + CHUNK_SIZE), options);
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/([_\-*\[\]()~`>#+=|{}.!])/g, '\\$1');
}

function getFriendlyType(type: string): string {
  const map: Record<string, string> = {
    PLAN_GENERATED: '📋 Plan Generated',
    PLAN_APPROVED: '✅ Plan Approved',
    USER_MESSAGED: '👤 Your Message',
    AGENT_MESSAGED: '🤖 Jules Message',
    SESSION_COMPLETED: '🎉 Task Completed',
    SESSION_FAILED: '❌ Task Failed',
    AWAITING_PLAN_APPROVAL: '⚠️ Waiting for Approval',
    AWAITING_USER_FEEDBACK: '❓ Waiting for Feedback'
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

  if (!verbose && raw.length > 60) return `${raw.substring(0, 57)}...`;
  return raw;
}

function formatPlan(activities: any[]): string {
  const planActivity = activities.find((a) =>
    a.type === 'PLAN_GENERATED' || a.planGenerated || (a.description && a.description.toLowerCase().includes('plan'))
  );
  if (!planActivity) return 'Check details on GitHub or Jules web app.';

  const plan = planActivity.planGenerated?.plan;
  if (plan?.steps) {
    return plan.steps.map((s: any) => `${s.index + 1}. ${s.title}: ${s.description}`).join('\n');
  }

  return getSummary(planActivity);
}

function getActivityKey(activity: any): string {
  return (activity?.name || '').split('/').pop() || '';
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
      const { activities } = await jules.getRecentActivities(sessionId, 30);
      if (!activities.length) continue;

      const sorted = [...activities].sort(
        (a: any, b: any) => new Date(a.createTime || 0).getTime() - new Date(b.createTime || 0).getTime()
      );
      const lastActivity = sorted[sorted.length - 1];
      if (lastActivity.type === 'PROGRESS_UPDATED') continue;

      const lastActivityId = lastActivity.name;
      const storedId = await env.JULES_NOTIFICATIONS_KV.get(`last_notified:${sessionId}`);
      if (storedId === lastActivityId) continue;

      const significantTypes = ['PLAN_GENERATED', 'SESSION_COMPLETED', 'SESSION_FAILED', 'AWAITING_PLAN_APPROVAL', 'AWAITING_USER_FEEDBACK'];
      const isSignificant =
        significantTypes.includes(lastActivity.type) ||
        session.state === 'AWAITING_PLAN_APPROVAL' ||
        session.state === 'AWAITING_USER_FEEDBACK';

      if (isSignificant) {
        const activityDesc = escapeMarkdown(getSummary(lastActivity));
        await bot.api.sendMessage(
          adminId,
          `🔔 *Update for Session*\nTitle: ${escapeMarkdown(session.title || session.displayName || sessionId)}\nStatus: ${escapeMarkdown(session.state || 'UNKNOWN')}\nActivity: ${escapeMarkdown(getFriendlyType(lastActivity.type))}\n${activityDesc}\n\nUse /sessions to manage.`,
          { parse_mode: 'Markdown' }
        );
      }
      await env.JULES_NOTIFICATIONS_KV.put(`last_notified:${sessionId}`, lastActivityId);
    }
  } catch (e) {
    console.error('Notification Error:', e);
  }
}

app.post('/webhook', async (c) => {
  const bot = new Bot(c.env.TELEGRAM_TOKEN);
  const adminIds = c.env.ADMIN_USER_ID.split(',').map((id) => id.trim());
  const jules = new JulesClient(c.env.JULES_API_KEY);

  bot.use(async (ctx, next) => {
    if (ctx.from && adminIds.includes(ctx.from.id.toString())) return next();
    if (ctx.message?.text?.startsWith('/')) await ctx.reply('🚫 Unauthorized.');
  });

  bot.command('start', (ctx) =>
    ctx.reply('👋 Hello! I am your Jules Bot.\n\n/sessions - List active sessions\n/new - Start a new session\n/check - Check configuration')
  );

  bot.command('check', async (ctx) => {
    let report = '🛠 **System Check**\n\n';
    report += `✅ Admin ID: \`${ctx.from?.id}\` (In whitelist)\n`;
    report += `✅ API Key: ${c.env.JULES_API_KEY ? 'Configured' : '❌ MISSING'}\n`;
    report += `✅ Bot Token: ${c.env.TELEGRAM_TOKEN ? 'Configured' : '❌ MISSING'}\n`;

    if (c.env.JULES_NOTIFICATIONS_KV) {
      try {
        await c.env.JULES_NOTIFICATIONS_KV.put('healthcheck_key', `${Date.now()}`);
        report += '✅ KV Storage: Working\n';
      } catch (e: any) {
        report += `❌ KV Storage: Failed (${e.message})\n`;
      }
    } else {
      report += 'ℹ️ KV Storage: Not bound (Notifications disabled)\n';
    }

    try {
      await jules.listSources();
      report += '✅ Jules API: Connected\n';
    } catch (e: any) {
      report += `❌ Jules API: Connection failed (${e.message})\n`;
    }

    await ctx.reply(report, { parse_mode: 'Markdown' });
  });

  bot.command('sessions', async (ctx) => {
    try {
      const { sessions } = await jules.listSessions();
      if (!sessions?.length) return ctx.reply('No active sessions found.');

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
      if (!sources?.length) return ctx.reply('No repositories found.');

      const keyboard = new InlineKeyboard();
      sources.slice(0, 8).forEach((src: any, idx: number) => {
        const name = src.name.split('/').pop();
        keyboard.text(name, `create_select_idx:${idx}`).row();
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
      await ctx.reply('To reply to a session, use the "Reply" feature on a session message.');
    }
  });

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const [action, ...args] = data.split(':');
    const id = args[0];
    const subId = args[1];

    try {
      if (action === 'view') {
        const session = await jules.getSession(id);
        const status = session.state || 'UNKNOWN';
        const title = session.title || session.displayName || id;
        const keyboard = new InlineKeyboard()
          .text('🔄 Refresh', `view:${id}`)
          .text('📋 Activities', `activities:${id}`).row()
          .text('✅ View/Approve Plan', `plan_view:${id}`).row()
          .text('🔙 Back to List', 'sessions_back');

        await ctx.editMessageText(
          `**Session:** ${escapeMarkdown(title)}\n**ID:** \`${id}\`\n**Status:** \`${status}\`\n**Source:** \`${escapeMarkdown(session.sourceContext?.source || session.source || 'Unknown')}\`\n\n💡 _Tip: Reply to this message to send a chat to Jules._`,
          { parse_mode: 'Markdown', reply_markup: keyboard }
        );
      } else if (action === 'sessions_back') {
        const { sessions } = await jules.listSessions();
        const keyboard = new InlineKeyboard();
        (sessions || []).slice(0, 10).forEach((s: any) => {
          const sid = s.name.split('/').pop();
          const label = s.title || s.displayName || sid;
          keyboard.text(`📝 ${label}`, `view:${sid}`).row();
        });
        await ctx.editMessageText('Recent Sessions:', { reply_markup: keyboard });
      } else if (action === 'activities') {
        const { activities } = await jules.getRecentActivities(id, 40);
        const filtered = activities.filter((a: any) => a.type !== 'PROGRESS_UPDATED');
        const itemsToShow = filtered
          .sort((a: any, b: any) => new Date(b.createTime || 0).getTime() - new Date(a.createTime || 0).getTime())
          .slice(0, 5);

        const keyboard = new InlineKeyboard();
        let listText = `**Recent Activities** (Latest first)\nSession: \`${id}\`\n\n`;

        itemsToShow.forEach((a: any) => {
          const time = new Date(a.createTime).toLocaleTimeString();
          const typeLabel = getFriendlyType(a.type);
          const summary = getSummary(a, false);
          const activityKey = getActivityKey(a);
          listText += `🕒 ${time} **${typeLabel}**\n${escapeMarkdown(summary)}\n\n`;
          keyboard.text(`🔍 Details: ${a.type || 'Activity'}`, `act:${id}:${activityKey}`).row();
        });
        keyboard.text('🔙 Back', `view:${id}`);

        if (listText.length > 4000) listText = `${listText.substring(0, 3900)}...`;
        await ctx.editMessageText(listText, { parse_mode: 'Markdown', reply_markup: keyboard });
      } else if (action === 'act') {
        const activity = await jules.findActivityByKey(id, subId, 3);
        if (!activity) {
          await ctx.answerCallbackQuery('Activity expired, please refresh.');
          return;
        }

        const time = new Date(activity.createTime).toLocaleString();
        const fullContent = `**Activity Detail**\n\n**Session ID:** \`${id}\`\n**Time:** ${time}\n**Type:** ${getFriendlyType(activity.type)}\n\n${escapeMarkdown(getSummary(activity, true))}`;
        const keyboard = new InlineKeyboard().text('🔙 Back to List', `activities:${id}`);

        if (fullContent.length <= 4000) {
          await ctx.editMessageText(fullContent, { parse_mode: 'Markdown', reply_markup: keyboard });
        } else {
          await sendLongMessage(bot, ctx.chat!.id, fullContent, { parse_mode: 'Markdown' });
          await ctx.reply('^ Full details above.', { reply_markup: keyboard });
        }
      } else if (action === 'plan_view') {
        const session = await jules.getSession(id);
        const { activities } = await jules.getAllActivities(id);
        const planText = formatPlan(activities);
        const keyboard = new InlineKeyboard();
        if (session.state === 'AWAITING_PLAN_APPROVAL') {
          keyboard.text('👍 Approve Plan', `approve_do:${id}`).row();
        }
        keyboard.text('⬅️ Back', `view:${id}`);

        const header = `📋 **Plan Details:**\n\n**ID:** \`${id}\`\n${
          session.state === 'AWAITING_PLAN_APPROVAL' ? '⚠️ Approval Required!' : ''
        }\n\n`;
        const fullContent = `${header}${escapeMarkdown(planText)}`;

        if (fullContent.length <= 4000) {
          await ctx.editMessageText(fullContent, { parse_mode: 'Markdown', reply_markup: keyboard });
        } else {
          await sendLongMessage(bot, ctx.chat!.id, fullContent, { parse_mode: 'Markdown' });
          await ctx.reply('^ Plan details above.', { reply_markup: keyboard });
        }
      } else if (action === 'approve_do') {
        await jules.approvePlan(id);
        await ctx.editMessageText(`✅ Plan approved for session \`${id}\`.`, { parse_mode: 'Markdown' });
      } else if (action === 'create_select_idx') {
        const sourceIdx = Number(id);
        if (Number.isNaN(sourceIdx)) {
          await ctx.answerCallbackQuery('Invalid source.');
          return;
        }

        const { sources } = await jules.listSources();
        const source = (sources || []).slice(0, 8)[sourceIdx];
        if (!source?.name) {
          await ctx.answerCallbackQuery('Source expired, run /new again.');
          return;
        }

        await ctx.editMessageText(
          `Source selected: \`${source.name}\`\n\nTo start, send:\n\`/start_session ${source.name} [Options] Your prompt\``,
          { parse_mode: 'Markdown' }
        );
      }

      await ctx.answerCallbackQuery();
    } catch (e: any) {
      await ctx.answerCallbackQuery(`Error: ${e.message}`);
    }
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

  bot.command('start_session', async (ctx) => {
    const text = ctx.message?.text || '';
    const parts = text.split(/\s+/);
    if (parts.length < 3) return ctx.reply('Usage: /start_session [source] [options] [prompt]');

    const sourceName = parts[1];
    const promptParts: string[] = [];
    const options: CreateSessionOptions = {};

    for (let i = 2; i < parts.length; i++) {
      const p = parts[i];
      if (p === '-i' || p === '--interactive') options.requirePlanApproval = true;
      else if (p === '-a' || p === '--auto-pr') options.automationMode = 'AUTO_CREATE_PR';
      else if (p === '-b' || p === '--branch') options.startingBranch = parts[++i];
      else if (p === '-t' || p === '--title') {
        const titleParts = [];
        while (i + 1 < parts.length && !parts[i + 1].startsWith('-')) titleParts.push(parts[++i]);
        options.title = titleParts.join(' ');
      } else promptParts.push(p);
    }

    const prompt = promptParts.join(' ');
    if (!prompt) return ctx.reply('Please provide a prompt.');

    try {
      const session = await jules.createSession(sourceName, prompt, options);
      const sessionId = session.name.split('/').pop();
      await ctx.reply(
        `🚀 Session started! ID: \`${sessionId}\`\nMode: ${options.requirePlanApproval ? 'Interactive' : 'Auto'}\nBranch: ${options.startingBranch || 'main'}`,
        { parse_mode: 'Markdown' }
      );
    } catch (e: any) {
      await ctx.reply(`❌ Failed: ${e.message}`);
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
