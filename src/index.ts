import { Hono } from 'hono';
import { Bot, webhookCallback, InlineKeyboard, GrammyError, HttpError } from 'grammy';
import { Env, JulesClient, CreateSessionOptions } from './lib/jules';

const app = new Hono<{ Bindings: Env }>();

// --- Wizard & Registry Types ---

interface WizardState extends CreateSessionOptions {
    source: string;
    branches?: string[]; // Cache branches to avoid repeated API calls
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

// Map long callback data to short KV keys if needed
async function getCallbackData(env: Env, prefix: string, sid: string, sub: string): Promise<string> {
    const full = `${prefix}:${sid}:${sub}`;
    if (full.length <= 64) return full;
    if (!env.JULES_NOTIFICATIONS_KV) return `${prefix}:LONG_ID_ERROR`;
    const shortId = Math.random().toString(36).substring(2, 8);
    await env.JULES_NOTIFICATIONS_KV.put(`cb:${shortId}`, full, { expirationTtl: 3600 });
    return `cb_map:${shortId}`;
}

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

async function registerSession(env: Env, sessionId: string, title: string) {
    if (!env.JULES_NOTIFICATIONS_KV) return;
    const raw = await env.JULES_NOTIFICATIONS_KV.get('track:registry');
    let registry: TrackedSession[] = raw ? JSON.parse(raw) : [];
    // Prevent duplicate entries
    if (!registry.find(s => s.id === sessionId)) {
        registry.push({ id: sessionId, title, createTime: Date.now() });
        await env.JULES_NOTIFICATIONS_KV.put('track:registry', JSON.stringify(registry));
    }
}

// --- Scheduled Task ---

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
      if (now - entry.createTime > DAY_MS) continue;

      try {
        const session = await jules.getSession(entry.id);
        const sigStates = ['AWAITING_PLAN_APPROVAL', 'AWAITING_USER_FEEDBACK', 'COMPLETED', 'FAILED'];

        if (sigStates.includes(session.state)) {
            const keyboard = new InlineKeyboard().text('📋 View Details', `view:${entry.id}`).row();
            await bot.api.sendMessage(adminId,
              `🔔 **Jules Task Update**\n\n**Title:** ${entry.title}\n**Status:** \`${session.state}\`\n\nReached milestone.`,
              { parse_mode: 'Markdown', reply_markup: keyboard }
            );
        } else {
            updatedRegistry.push(entry);
        }
      } catch (e) {
          console.error(`Error tracking ${entry.id}:`, e);
          updatedRegistry.push(entry); // Retry next time
      }
    }
    await env.JULES_NOTIFICATIONS_KV.put('track:registry', JSON.stringify(updatedRegistry));
  } catch (e) { console.error('Cron Error:', e); }
}

// --- Bot App ---

app.post('/webhook', async (c) => {
  const bot = new Bot(c.env.TELEGRAM_TOKEN);
  const adminIds = c.env.ADMIN_USER_ID?.split(',').map(id => id.trim()) || [];
  const jules = new JulesClient(c.env.JULES_API_KEY);

  // Global Error Handler
  bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`Bot Error:`, err.error);
    const adminId = adminIds[0];
    if (adminId) {
        let errMsg = `❌ **Bot Error**\n\n`;
        if (err instanceof GrammyError) errMsg += `Grammy: ${err.message}`;
        else if (err instanceof HttpError) errMsg += `Telegram: ${err.message}`;
        else errMsg += `Error: ${String(err.error)}`;
        bot.api.sendMessage(adminId, errMsg, { parse_mode: 'Markdown' }).catch(() => {});
    }
  });

  bot.use(async (ctx, next) => {
    if (ctx.from && adminIds.includes(ctx.from.id.toString())) return next();
    if (ctx.message?.text?.startsWith('/')) await ctx.reply('🚫 Unauthorized.');
  });

  // 1. Commands
  bot.command('start', (ctx) => ctx.reply('👋 I am Jules Bot.\n/sessions - Manage\n/new - Create\n/check - Diagnostics'));

  bot.command('check', async (ctx) => {
      let report = "🛠 **System Check**\n\n";
      report += `✅ Admin ID: \`${ctx.from?.id}\`\n`;
      report += `✅ API Key: ${c.env.JULES_API_KEY ? 'OK' : '❌'}\n`;
      if (c.env.JULES_NOTIFICATIONS_KV) {
          try {
              await c.env.JULES_NOTIFICATIONS_KV.put('check_v9', 'ok');
              const raw = await c.env.JULES_NOTIFICATIONS_KV.get('track:registry');
              const registry: TrackedSession[] = raw ? JSON.parse(raw) : [];
              report += `✅ KV: Working\n\n**Tracking List (${registry.length}):**\n`;
              if (registry.length > 0) {
                  registry.forEach(s => {
                      const ageMin = Math.round((Date.now() - s.createTime) / 60000);
                      report += `- \`${s.id}\`: ${s.title} (${ageMin}m ago)\n`;
                  });
              } else report += "_No sessions currently being tracked._";
          }
          catch (e: any) { report += `❌ KV: Error (${e.message})\n`; }
      } else report += `ℹ️ KV: Not bound\n`;
      try { await jules.listSources(); report += `✅ API: Connected\n`; }
      catch (e: any) { report += `❌ API: Failed (${e.message})\n`; }
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
      for (const src of sources.slice(0, 8)) {
          const name = src.name.split('/').pop();
          const cb = await getCallbackData(c.env, 'wiz_repo', '', src.name);
          keyboard.text(name, cb).row();
      }
      await ctx.reply('🚀 Step 1: Select a repository:', { reply_markup: keyboard });
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
      await registerSession(c.env, sessionId, options.title || prompt.substring(0, 30));
      await ctx.reply(`🚀 Started! ID: \`${sessionId}\``);
    } catch (e: any) { await ctx.reply(`❌ Failed: ${e.message}`); }
  });

  // 2. Text Matcher (Conversational logic)
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    const replyTo = ctx.message.reply_to_message;
    const replyText = replyTo?.text || replyTo?.caption || '';

    // Pattern 1: Wizard Confirmation (Highest priority)
    // Robust regex to handle potential Markdown artifacts (**, `)
    const wizMatch = replyText.match(/(?:\*\*|__)?WizID(?:\*\*|__)?:\s*[`*_]*([a-z0-9]+)[`*_]*/i);
    if (wizMatch) {
        const wizId = wizMatch[1];
        const state = await getWizardState(c.env, wizId);
        if (state) {
            try {
                const session = await jules.createSession(state.source, text, state);
                const sid = session.name.split('/').pop();
                await registerSession(c.env, sid, state.title || text.substring(0, 30));
                return ctx.reply(`🚀 Session started! ID: \`${sid}\` (Tracked)`);
            } catch (e: any) { return ctx.reply(`❌ Failed to create session: ${e.message}`); }
        } else {
            return ctx.reply('⚠️ Wizard session expired or not found. Please start over with /new.');
        }
    }

    // Pattern 2: Normal reply to a session message
    if (replyTo) {
      // Use a negative lookahead to ensure we don't accidentally match WizID as a session ID
      const sidMatch = replyText.match(/(?<!Wiz)(?:Session|ID):\s*`?([0-9a-zA-Z_-]+)`?/i);
      if (sidMatch) {
        try {
          await jules.sendMessage(sidMatch[1], text);
          return ctx.reply(`✅ Sent to session \`${sidMatch[1]}\`.`, { reply_to_message_id: ctx.message.message_id });
        } catch (e: any) { return ctx.reply(`❌ Failed to send: ${e.message}`); }
      }
    }

    await ctx.reply('Use /help or reply to a session message to chat.');
  });

  // 3. Callback Handlers
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
        const targetRepo = args[2] || subId;
        const sources = await jules.listSources();
        const source = sources.sources?.find((s: any) => s.name === targetRepo);
        if (!source) return ctx.reply('Source not found.');
        const branches = source.githubRepo?.branches?.map((b: any) => b.displayName) || ['main'];
        const wizId = await saveWizardState(c.env, { source: targetRepo, startingBranch: 'main', branches });
        const keyboard = new InlineKeyboard();
        branches.slice(0, 10).forEach((br: string, idx: number) => {
            keyboard.text(br, `wiz_br:${wizId}:${idx}`).row();
        });
        await ctx.editMessageText(`📂 Repo: \`${targetRepo}\`\n\n🚀 Step 2: Select branch:`, { parse_mode: 'Markdown', reply_markup: keyboard });
    } else if (action === 'wiz_br') {
        const state = await getWizardState(c.env, id);
        if (!state || !state.branches) return ctx.reply('Wizard expired. Start over with /new.');
        state.startingBranch = state.branches[parseInt(subId)];
        const wizId = await saveWizardState(c.env, state);
        const keyboard = new InlineKeyboard().text('📋 Interactive', `wiz_mode:${wizId}:int`).row().text('⚡ Auto', `wiz_mode:${wizId}:auto`).row();
        await ctx.editMessageText(`📂 Repo: \`${state.source}\`\n🌿 Branch: \`${state.startingBranch}\`\n\n🚀 Step 3: Select mode:`, { parse_mode: 'Markdown', reply_markup: keyboard });
    } else if (action === 'wiz_mode') {
        const state = await getWizardState(c.env, id);
        if (!state) return ctx.reply('Wizard expired.');
        state.requirePlanApproval = (subId === 'int');
        const wizId = await saveWizardState(c.env, state);
        const keyboard = new InlineKeyboard().text('✅ Yes', `wiz_pr:${wizId}:yes`).text('❌ No', `wiz_pr:${wizId}:no`).row();
        await ctx.editMessageText(`🛠 Mode: \`${state.requirePlanApproval ? 'Interactive' : 'Auto'}\`\n\n🚀 Step 4: Auto PR?`, { parse_mode: 'Markdown', reply_markup: keyboard });
    } else if (action === 'wiz_pr') {
        const state = await getWizardState(c.env, id);
        if (!state) return ctx.reply('Wizard expired.');
        state.automationMode = (subId === 'yes' ? 'AUTO_CREATE_PR' : 'AUTOMATION_MODE_UNSPECIFIED');
        const wizId = await saveWizardState(c.env, state);
        await ctx.reply(`🚀 **READY TO START**\n\n📂 Repo: \`${state.source}\`\n🌿 Branch: \`${state.startingBranch}\`\n🛠 Mode: \`${state.requirePlanApproval ? 'Interactive' : 'Auto'}\`\n📦 PR: \`${state.automationMode === 'AUTO_CREATE_PR' ? 'Yes' : 'No'}\`\n\n**WizID:** \`${wizId}\`\nReply with your task prompt:`, {
            parse_mode: 'Markdown',
            reply_markup: { force_reply: true }
        });
    } else if (action === 'view') {
        try {
            const session = await jules.getSession(id);
            const title = session.title || session.displayName || id;
            const keyboard = new InlineKeyboard().text('🔄 Refresh', `view:${id}`).text('📋 Activities', `activities:${id}`).row().text('✅ View Plan', `plan_view:${id}`).text('🔙 List', 'sessions_back');
            await ctx.editMessageText(`**Session:** ${title}\n**ID:** \`${id}\`\n**Status:** \`${session.state}\`\n\n💡 _Reply to chat._`, { parse_mode: 'Markdown', reply_markup: keyboard });
        } catch (e: any) { await ctx.reply(`Error: ${e.message}`); }
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
            if (!activity) return ctx.reply('Expired.');
            const fullContent = `**Activity Detail**\n**ID:** \`${id}\`\n**Type:** ${getFriendlyType(activity.type)}\n\n${getSummary(activity, true)}`;
            const keyboard = new InlineKeyboard().text('🔙 Back', `activities:${id}`);
            if (fullContent.length <= 4000) await ctx.editMessageText(fullContent, { parse_mode: 'Markdown', reply_markup: keyboard });
            else { await sendLongMessage(bot, ctx.chat!.id, fullContent, { parse_mode: 'Markdown' }); await ctx.reply('^ Full details above.', { reply_markup: keyboard }); }
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
            else { await sendLongMessage(bot, ctx.chat!.id, content, { parse_mode: 'Markdown' }); await ctx.reply('^ Plan details above.', { reply_markup: keyboard }); }
        } catch (e: any) { await ctx.reply(`Error: ${e.message}`); }
    } else if (action === 'approve_do') {
        try { await jules.approvePlan(id); await ctx.editMessageText(`✅ Approved for \`${id}\`.`); }
        catch (e: any) { await ctx.reply(`Error: ${e.message}`); }
    }
  });

  bot.api.setMyCommands([
    { command: "sessions", description: "Manage tasks" },
    { command: "new", description: "Create task" },
    { command: "check", description: "Diagnostics" },
    { command: "help", description: "Help" }
  ]).catch(() => {});

  return webhookCallback(bot, 'std/http')(c.req.raw);
});

export default {
  fetch: app.fetch,
  scheduled: (event: any, env: Env, ctx: any) => {
    ctx.waitUntil(handleScheduled(env));
  }
};
