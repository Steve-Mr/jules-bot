import { Hono } from 'hono';
import { Bot, webhookCallback, InlineKeyboard } from 'grammy';
import { Env, JulesClient } from './lib/jules';

const app = new Hono<{ Bindings: Env }>();

// Helper to format plan
function formatPlan(activities: any[]): string {
    const planActivity = activities.find(a => a.type === 'PLAN_GENERATED' || a.description?.toLowerCase().includes('plan'));
    if (!planActivity) return 'Check details on GitHub or Jules web app.';
    return planActivity.description || 'Plan generated, please review.';
}

// Scheduled task for notifications
export async function handleScheduled(env: Env) {
  if (!env.JULES_NOTIFICATIONS_KV || !env.TELEGRAM_TOKEN || !env.ADMIN_USER_ID) return;

  const bot = new Bot(env.TELEGRAM_TOKEN);
  const jules = new JulesClient(env.JULES_API_KEY);
  const adminId = env.ADMIN_USER_ID.split(',')[0]; // Notify the first admin

  try {
    const { sessions } = await jules.listSessions();
    if (!sessions) return;

    for (const session of sessions) {
      const sessionId = session.name.split('/').pop();
      const { activities } = await jules.getActivities(sessionId);
      if (!activities || activities.length === 0) continue;

      const lastActivity = activities[activities.length - 1];
      const lastActivityId = lastActivity.name; // Use unique resource name as ID

      const storedId = await env.JULES_NOTIFICATIONS_KV.get(`last_notified:${sessionId}`);

      if (storedId !== lastActivityId) {
        // New activity!
        // We only notify for significant milestones to avoid spam
        const significantTypes = ['PLAN_GENERATED', 'SESSION_COMPLETED', 'SESSION_FAILED', 'REQUIRE_USER_APPROVAL'];
        const isSignificant = significantTypes.includes(lastActivity.type) || session.state === 'REQUIRE_USER_APPROVAL';

        if (isSignificant) {
          await bot.api.sendMessage(adminId,
            `🔔 **Update for Session \`${sessionId}\`**\n\n` +
            `**Status:** \`${session.state}\`\n` +
            `**New Activity:** ${lastActivity.description || lastActivity.type}\n\n` +
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
        keyboard.text(`📝 ${s.displayName || id}`, `view:${id}`).row();
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

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const [action, ...args] = data.split(':');
    const id = args.join(':');

    if (action === 'view') {
      try {
        const session = await jules.getSession(id);
        const status = session.state || 'UNKNOWN';
        const keyboard = new InlineKeyboard()
          .text('🔄 Refresh', `view:${id}`)
          .text('📋 Activities', `activities:${id}`).row()
          .text('💬 Send Message', `msg_hint:${id}`)
          .text('✅ View/Approve Plan', `plan_view:${id}`).row()
          .text('🔙 Back to List', 'sessions_back');

        await ctx.editMessageText(
          `**Session:** ${session.displayName || id}\n**Status:** \`${status}\`\n**Source:** \`${session.source}\``,
          { parse_mode: 'Markdown', reply_markup: keyboard }
        );
      } catch (e: any) {
        await ctx.answerCallbackQuery(`Error: ${e.message}`);
      }
    } else if (action === 'sessions_back') {
        const { sessions } = await jules.listSessions();
        const keyboard = new InlineKeyboard();
        sessions.slice(0, 10).forEach((s: any) => {
          const id = s.name.split('/').pop();
          keyboard.text(`📝 ${s.displayName || id}`, `view:${id}`).row();
        });
        await ctx.editMessageText('Recent Sessions:', { reply_markup: keyboard });
    } else if (action === 'plan_view') {
      try {
        const session = await jules.getSession(id);
        const { activities } = await jules.getActivities(id);
        const planText = formatPlan(activities);

        const keyboard = new InlineKeyboard();
        if (session.state === 'REQUIRE_USER_APPROVAL') {
            keyboard.text('👍 Approve Plan', `approve_do:${id}`).row();
        }
        keyboard.text('⬅️ Back', `view:${id}`);

        await ctx.editMessageText(`📋 **Plan Details:**\n\n${planText}\n\n${session.state === 'REQUIRE_USER_APPROVAL' ? '⚠️ Approval Required!' : ''}`, {
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
      } catch (e: any) {
        await ctx.answerCallbackQuery(`Error: ${e.message}`);
      }
    } else if (action === 'approve_do') {
        try {
            await jules.approvePlan(id);
            await ctx.editMessageText(`✅ Plan approved for session \`${id}\`. Jules is back to work!`, { parse_mode: 'Markdown' });
        } catch (e: any) {
            await ctx.answerCallbackQuery(`Error: ${e.message}`);
        }
    } else if (action === 'msg_hint') {
        await ctx.reply(`To send a message to this session, use:\n\`/reply ${id} Your message here\``, { parse_mode: 'Markdown' });
        await ctx.answerCallbackQuery();
    } else if (action === 'create_select') {
      await ctx.editMessageText(`Source selected: \`${id}\`\n\nTo start, send:\n\`/start_session ${id} Your prompt\``, { parse_mode: 'Markdown' });
    } else if (action === 'activities') {
      try {
        const { activities } = await jules.getActivities(id);
        const lastFive = activities.slice(-5).reverse().map((a: any) => {
            const time = new Date(a.createTime).toLocaleTimeString();
            return `[${time}] **${a.type}**: ${a.description || ''}`;
        }).join('\n');
        await ctx.reply(`Recent activities for \`${id}\`:\n\n${lastFive || 'No activities found.'}`, { parse_mode: 'Markdown' });
      } catch (e: any) {
        await ctx.answerCallbackQuery(`Error: ${e.message}`);
      }
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
      await ctx.reply(`✅ Message sent to session \`${sessionId}\`.`);
    } catch (e: any) {
      await ctx.reply(`❌ Failed to send message: ${e.message}`);
    }
  });

  bot.command('start_session', async (ctx) => {
    const text = ctx.message?.text || '';
    const match = text.match(/\/start_session\s+([^\s]+)\s+(.+)/);
    if (!match) return ctx.reply('Usage: /start_session [source_name] [prompt]');
    const [, sourceName, prompt] = match;
    try {
      const session = await jules.createSession(sourceName, prompt);
      const sessionId = session.name.split('/').pop();
      await ctx.reply(`🚀 Session started! ID: \`${sessionId}\``, { parse_mode: 'Markdown' });
    } catch (e: any) {
      await ctx.reply(`❌ Failed to start session: ${e.message}`);
    }
  });

  return webhookCallback(bot, 'cloudflare-workers')(c.req.raw);
});

// Cloudflare Workers Entry
export default {
  fetch: app.fetch,
  scheduled: (event: any, env: Env, ctx: any) => {
    ctx.waitUntil(handleScheduled(env));
  }
};
