import { Hono } from 'hono';
import { Bot, webhookCallback, InlineKeyboard } from 'grammy';
import { Env, JulesClient, CreateSessionOptions } from './lib/jules';

const app = new Hono<{ Bindings: Env }>();

// --- Wizard & Registry Types ---

interface WizardState extends CreateSessionOptions {
    source: string;
}

interface TrackedSession {
    id: string;
    title: string;
    createTime: number; // unix timestamp
}

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

async function getCallbackData(env: Env, prefix: string, sid: string, sub: string): Promise<string> {
    const full = `${prefix}:${sid}:${sub}`;
    if (full.length <= 64) return full;
    if (!env.JULES_NOTIFICATIONS_KV) return `${prefix}:${sid}:ERR_LONG`;
    const shortId = Math.random().toString(36).substring(2, 8);
    await env.JULES_NOTIFICATIONS_KV.put(`cb:${shortId}`, full, { expirationTtl: 3600 });
    return `cb_map:${shortId}`;
}

// Wizard helpers
async function saveWizardState(env: Env, state: WizardState): Promise<string> {
    const wizId = Math.random().toString(36).substring(2, 10);
    if (env.JULES_NOTIFICATIONS_KV) {
        await env.JULES_NOTIFICATIONS_KV.put(`wiz:${wizId}`, JSON.stringify(state), { expirationTtl: 1800 });
    }
    return wizId;
}

async function getWizardState(env: Env, wizId: string): Promise<WizardState | null> {
    if (!env.JULES_NOTIFICATIONS_KV) return null;
    const raw = await env.JULES_NOTIFICATIONS_KV.get(`wiz:${wizId}`);
    return raw ? JSON.parse(raw) : null;
}

// Registry helpers (Tracked Sessions)
async function registerSession(env: Env, sessionId: string, title: string) {
    if (!env.JULES_NOTIFICATIONS_KV) return;
    const raw = await env.JULES_NOTIFICATIONS_KV.get('track:registry');
    const registry: TrackedSession[] = raw ? JSON.parse(raw) : [];
    registry.push({ id: sessionId, title, createTime: Date.now() });
    await env.JULES_NOTIFICATIONS_KV.put('track:registry', JSON.stringify(registry));
}

// --- Scheduled Task (Precision Registry Tracking) ---

export async function handleScheduled(env: Env) {
  if (!env.JULES_NOTIFICATIONS_KV || !env.TELEGRAM_TOKEN || !env.ADMIN_USER_ID) return;
  const bot = new Bot(env.TELEGRAM_TOKEN);
  const jules = new JulesClient(env.JULES_API_KEY);
  const adminId = env.ADMIN_USER_ID.split(',')[0];

  try {
    const raw = await env.JULES_NOTIFICATIONS_KV.get('track:registry');
    if (!raw) return;

    let registry: TrackedSession[] = JSON.parse(raw);
    const now = Date.now();
    const updatedRegistry: TrackedSession[] = [];
    const DAY_MS = 24 * 60 * 60 * 1000;

    for (const entry of registry) {
      // 1. Auto-cleanup: remove if older than 24h
      if (now - entry.createTime > DAY_MS) continue;

      try {
        const session = await jules.getSession(entry.id);
        const sigStates = ['AWAITING_PLAN_APPROVAL', 'AWAITING_USER_FEEDBACK', 'COMPLETED', 'FAILED'];

        if (sigStates.includes(session.state)) {
            // Send Notification
            const keyboard = new InlineKeyboard()
                .text('📋 View Details/Activities', `view:${entry.id}`).row();

            await bot.api.sendMessage(adminId,
              `🔔 **Jules Task Update**\n\n` +
              `**Title:** ${entry.title}\n` +
              `**Status:** \`${session.state}\`\n\n` +
              `This task reached a milestone and has been removed from the notification queue.`,
              { parse_mode: 'Markdown', reply_markup: keyboard }
            );
            // DO NOT add to updatedRegistry = removed from tracking
        } else {
            // Still in progress, keep tracking
            updatedRegistry.push(entry);
        }
      } catch (e) {
        // If session not found or API error, stop tracking to be safe
        console.error(`Error tracking ${entry.id}:`, e);
      }
    }

    await env.JULES_NOTIFICATIONS_KV.put('track:registry', JSON.stringify(updatedRegistry));
  } catch (e) {
    console.error('Notification Engine Error:', e);
  }
}

// --- Bot App ---

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

  bot.command('start', (ctx) => ctx.reply('👋 I am Jules Bot.\n\n/sessions - Manage tasks\n/new - Start task\n/check - Diagnostics'));

  bot.command('check', async (ctx) => {
      let report = "🛠 **System Check**\n\n";
      report += `✅ Admin ID: \`${ctx.from?.id}\` (In whitelist)\n`;
      report += `✅ API Key: ${c.env.JULES_API_KEY ? 'Configured' : '❌ MISSING'}\n`;
      report += `✅ Bot Token: ${c.env.TELEGRAM_TOKEN ? 'Configured' : '❌ MISSING'}\n`;
      if (c.env.JULES_NOTIFICATIONS_KV) {
          try {
              await c.env.JULES_NOTIFICATIONS_KV.put('check_v6', 'ok');
              const raw = await c.env.JULES_NOTIFICATIONS_KV.get('track:registry');
              const count = raw ? JSON.parse(raw).length : 0;
              report += `✅ KV Storage: Working (Tracking ${count} sessions)\n`;
          }
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
        keyboard.text(name, `wiz_repo:${src.name}`).row();
      });
      await ctx.reply('🚀 Step 1: Select a repository:', { reply_markup: keyboard });
    } catch (e: any) { await ctx.reply(`❌ Error: ${e.message}`); }
  });

  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text;
    const replyTo = ctx.message.reply_to_message;

    if (replyTo?.text?.includes('READY TO START') || replyTo?.text?.includes('向导已就绪')) {
        const wizMatch = replyTo.text.match(/WizID:\s*`?([a-z0-9]+)`?/i);
        if (wizMatch) {
            const state = await getWizardState(c.env, wizMatch[1]);
            if (state) {
                try {
                    const session = await jules.createSession(state.source, text, state);
                    const sid = session.name.split('/').pop();
                    // REGISTER for tracking
                    await registerSession(c.env, sid, state.title || text.substring(0, 30));
                    return ctx.reply(`🚀 Session started! ID: \`${sid}\` (${state.requirePlanApproval ? 'Interactive' : 'Auto'})`);
                } catch (e: any) { return ctx.reply(`❌ Failed: ${e.message}`); }
            }
        }
    }

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

  bot.on('callback_query:data', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    let rawData = ctx.callbackQuery.data;
    if (rawData.startsWith('cb_map:')) {
        const shortId = rawData.split(':').pop();
        rawData = await c.env.JULES_NOTIFICATIONS_KV?.get(`cb:${shortId}`) || 'error:expired:data';
    }
    const [action, ...args] = rawData.split(':');
    const id = args[0];
    const subId = args[1];

    if (action === 'wiz_repo') {
        const sources = await jules.listSources();
        const source = sources.sources?.find((s: any) => s.name === id);
        if (!source) return ctx.reply('Source not found.');
        const wizId = await saveWizardState(c.env, { source: id, startingBranch: 'main' });
        const keyboard = new InlineKeyboard();
        const branches = source.githubRepo?.branches || [{ displayName: 'main' }];
        branches.slice(0, 10).forEach((b: any) => { keyboard.text(b.displayName, `wiz_br:${wizId}:${b.displayName}`).row(); });
        await ctx.editMessageText(`📂 Repository: \`${id}\`\n\n🚀 Step 2: Select target branch:`, { parse_mode: 'Markdown', reply_markup: keyboard });
    } else if (action === 'wiz_br') {
        const state = await getWizardState(c.env, id);
        if (!state) return ctx.reply('Wizard session expired.');
        state.startingBranch = subId;
        const wizId = await saveWizardState(c.env, state);
        const keyboard = new InlineKeyboard().text('📋 Interactive (Recommended)', `wiz_mode:${wizId}:int`).row().text('⚡ Auto-execute', `wiz_mode:${wizId}:auto`).row();
        await ctx.editMessageText(`📂 Repo: \`${state.source}\`\n🌿 Branch: \`${subId}\`\n\n🚀 Step 3: Select execution mode:`, { parse_mode: 'Markdown', reply_markup: keyboard });
    } else if (action === 'wiz_mode') {
        const state = await getWizardState(c.env, id);
        if (!state) return ctx.reply('Wizard session expired.');
        state.requirePlanApproval = (subId === 'int');
        const wizId = await saveWizardState(c.env, state);
        const keyboard = new InlineKeyboard().text('✅ Yes, create PR', `wiz_pr:${wizId}:yes`).row().text('❌ No, just finish', `wiz_pr:${wizId}:no`).row();
        await ctx.editMessageText(`📂 Repo: \`${state.source}\`\n🌿 Branch: \`${state.startingBranch}\`\n🛠 Mode: \`${state.requirePlanApproval ? 'Interactive' : 'Auto'}\`\n\n🚀 Step 4: Auto-create Pull Request?`, { parse_mode: 'Markdown', reply_markup: keyboard });
    } else if (action === 'wiz_pr') {
        const state = await getWizardState(c.env, id);
        if (!state) return ctx.reply('Wizard expired.');
        state.automationMode = (subId === 'yes' ? 'AUTO_CREATE_PR' : 'AUTOMATION_MODE_UNSPECIFIED');
        const wizId = await saveWizardState(c.env, state);
        await ctx.reply(
            `🚀 **向导已就绪 (READY TO START)**\n\n` +
            `📂 仓库: \`${state.source}\`\n` +
            `🌿 分支: \`${state.startingBranch}\`\n` +
            `🛠 模式: \`${state.requirePlanApproval ? '交互审批' : '全自动'}\`\n` +
            `📦 PR: \`${state.automationMode === 'AUTO_CREATE_PR' ? '开启' : '关闭'}\`\n` +
            `\n**WizID:** \`${wizId}\`\n` +
            `请**直接回复本消息**，告诉我你需要 Jules 完成的具体任务？`,
            { parse_mode: 'Markdown', reply_markup: { force_reply: true } }
        );
    } else if (action === 'view') {
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
          let listText = `**Recent Activities**\nID: \`${id}\`\n\n`;
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
    }
  });

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
