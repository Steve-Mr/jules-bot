import { Hono } from 'hono';
import { Bot, webhookCallback, InlineKeyboard, GrammyError, HttpError, Api, RawApi, CallbackQueryContext, Context as BotContext } from 'grammy';
import { Env, JulesClient, CreateSessionOptions } from './lib/jules';

const app = new Hono<{ Bindings: Env }>();

const WIZARD_EXPIRATION_TTL = 1800; // 30 minutes

const CallbackAction = {
    SetTimezone: 'set_tz',
    WizardRepoPage: 'wiz_repo_page',
    WizardRepo: 'wiz_repo',
    WizardBranch: 'wiz_br',
    WizardMode: 'wiz_mode',
    WizardPR: 'wiz_pr',
    ViewSession: 'view',
    Activities: 'activities',
    ActivityDetail: 'act_idx',
    PlanView: 'plan_view',
    ApprovePlan: 'approve_do',
    SessionsBack: 'sessions_back',
} as const;

// --- Wizard & Registry Types ---

interface WizardState extends CreateSessionOptions {
    source: string;
    branches?: string[]; // Cache branches to avoid repeated API calls
    userId?: number;
}

interface TrackedSession {
    id: string;
    title: string;
    createTime: number; // unix timestamp
    lastNotifiedState?: string;
}

// --- Helpers ---

function escapeMarkdown(text: string): string {
    return text.replace(/([_*\[`])/g, '\\$1');
}

async function sendLongMessage(bot: Bot, chatId: string | number, text: string, options: Parameters<Api<RawApi>["sendMessage"]>[2] = {}) {
    const CHUNK_SIZE = 4000;
    for (let i = 0; i < text.length; i += CHUNK_SIZE) {
        await bot.api.sendMessage(chatId, text.substring(i, i + CHUNK_SIZE), options);
    }
}

function getActivityType(activity: any): string {
    if (activity.type) return activity.type;
    if (activity.planGenerated) return 'PLAN_GENERATED';
    if (activity.planApproved) return 'PLAN_APPROVED';
    if (activity.userMessaged) return 'USER_MESSAGED';
    if (activity.agentMessaged) return 'AGENT_MESSAGED';
    if (activity.sessionCompleted) return 'SESSION_COMPLETED';
    if (activity.sessionFailed) return 'SESSION_FAILED';
    if (activity.progressUpdated) return 'PROGRESS_UPDATED';
    return 'ACTIVITY';
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

function addTimestamp(text: string, timezone: string = 'UTC'): string {
    const now = new Date();
    try {
        const timeStr = new Intl.DateTimeFormat('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
            timeZone: timezone
        }).format(now);
        return `${text}\n\n🕒 _Last updated: ${timeStr} (${timezone})_`;
    } catch {
        const timeStr = now.toTimeString().slice(0, 8);
        return `${text}\n\n🕒 _Last updated: ${timeStr} (UTC-Fallback)_`;
    }
}

async function getUserTimezone(env: Env, userId?: number): Promise<string> {
    if (!userId || !env.JULES_NOTIFICATIONS_KV) return 'UTC';
    return await env.JULES_NOTIFICATIONS_KV.get(`tz:${userId}`) || 'UTC';
}

function isMessageNotModifiedError(e: unknown): boolean {
    let msg: string | undefined;
    if (typeof e === 'object' && e !== null) {
        if ('description' in e && typeof (e as { description: unknown }).description === 'string') {
            msg = (e as { description: string }).description;
        } else if ('message' in e && typeof (e as { message: unknown }).message === 'string') {
            msg = (e as { message: string }).message;
        }
    }
    return msg?.includes('message is not modified') ?? false;
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
    else if (activity.sessionCompleted) raw = 'The task was completed successfully.';
    else if (activity.sessionFailed?.reason) raw = activity.sessionFailed.reason;
    else if (activity.sessionFailed) raw = 'The task failed to complete.';

    if (!raw && activity.artifacts && activity.artifacts.length > 0) {
        raw = 'Code changes applied.';
    }

    if (!raw) raw = '(No details available)';

    if (!verbose && raw.length > 60) return raw.substring(0, 57) + '...';
    return raw;
}

function formatPlan(activities: any[]): string {
    const planActivity = activities.find(a => a.type === 'PLAN_GENERATED' || a.planGenerated);
    if (!planActivity) return 'Check details on GitHub or Jules web app.';
    const plan = planActivity.planGenerated?.plan;
    if (plan && plan.steps) {
        return plan.steps.map((s: any, idx: number) => {
            const displayIndex = (typeof s.index === 'number') ? s.index + 1 : idx + 1;
            return `**${displayIndex}. ${escapeMarkdown(s.title)}**\n${escapeMarkdown(s.description)}`;
        }).join('\n\n');
    }
    return escapeMarkdown(getSummary(planActivity));
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
        await env.JULES_NOTIFICATIONS_KV.put(`wiz:${wizId}`, JSON.stringify(state), { expirationTtl: WIZARD_EXPIRATION_TTL });
        if (state.userId) {
            await env.JULES_NOTIFICATIONS_KV.put(`uwiz:${state.userId}:${wizId}`, '1', { expirationTtl: WIZARD_EXPIRATION_TTL });
        }
    }
    return wizId;
}

async function clearUserWizards(env: Env, userId: number): Promise<void> {
    if (!env.JULES_NOTIFICATIONS_KV) return;
    const prefix = `uwiz:${userId}:`;
    const list = await env.JULES_NOTIFICATIONS_KV.list({ prefix });
    const keys = list.keys.map(k => k.name);
    const deletePromises = keys.map(async (key) => {
        const wizId = key.split(':').pop();
        await env.JULES_NOTIFICATIONS_KV!.delete(`wiz:${wizId}`);
        await env.JULES_NOTIFICATIONS_KV!.delete(key);
    });
    await Promise.all(deletePromises);
}

async function deleteWizardState(env: Env, wizId: string, userId?: number): Promise<void> {
    if (!env.JULES_NOTIFICATIONS_KV) return;
    await env.JULES_NOTIFICATIONS_KV.delete(`wiz:${wizId}`);
    if (userId) {
        await env.JULES_NOTIFICATIONS_KV.delete(`uwiz:${userId}:${wizId}`);
    }
}

async function getWizardState(env: Env, wizId: string): Promise<WizardState | null> {
    if (!env.JULES_NOTIFICATIONS_KV) return null;
    const raw = await env.JULES_NOTIFICATIONS_KV.get(`wiz:${wizId}`);
    return raw ? JSON.parse(raw) : null;
}

async function registerSession(env: Env, jules: JulesClient, sessionId: string, title?: string) {
    if (!env.JULES_NOTIFICATIONS_KV) return;
    const raw = await env.JULES_NOTIFICATIONS_KV.get('track:registry');
    let registry: TrackedSession[] = raw ? JSON.parse(raw) : [];

    // Prevent duplicate entries
    if (!registry.find(s => s.id === sessionId)) {
        let finalTitle = title;
        if (!finalTitle) {
            try {
                const session = await jules.getSession(sessionId);
                finalTitle = session.title || session.displayName || sessionId;
            } catch {
                finalTitle = sessionId;
            }
        }
        registry.push({ id: sessionId, title: finalTitle!, createTime: Date.now() });
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
      // Skip very new entries (less than 1 minute) to avoid premature terminal-state false positives or transient initial states
      if (now - entry.createTime < 60000) {
          updatedRegistry.push(entry);
          continue;
      }

      try {
        const session = await jules.getSession(entry.id);
        const sigStates = ['AWAITING_PLAN_APPROVAL', 'AWAITING_USER_FEEDBACK', 'COMPLETED', 'FAILED'];

        if (sigStates.includes(session.state)) {
            // Only notify if the state has changed since last notification
            if (session.state !== entry.lastNotifiedState) {
                const keyboard = new InlineKeyboard();
                if (session.state === 'AWAITING_PLAN_APPROVAL') {
                    keyboard.text('👍 Approve Plan', `${CallbackAction.ApprovePlan}:${entry.id}`).row();
                }
                keyboard.text('📋 View Details', `${CallbackAction.ViewSession}:${entry.id}`).row();
                await bot.api.sendMessage(adminId,
                  `🔔 **Jules Task Update**\n\n**Title:** ${escapeMarkdown(entry.title)}\n**Status:** \`${session.state}\`\n\nReached milestone.`,
                  { parse_mode: 'Markdown', reply_markup: keyboard }
                );
                entry.lastNotifiedState = session.state;
            }

            // Only remove from registry if it's a terminal state
            if (session.state === 'COMPLETED' || session.state === 'FAILED') {
                // Do not push back to updatedRegistry
            } else {
                updatedRegistry.push(entry);
            }
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
    if (isMessageNotModifiedError(err.error)) return;
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
  bot.command('start', (ctx) => ctx.reply('👋 I am Jules Bot.\n/sessions - Manage tasks\n/new - Create task\n/cancel - Cancel wizard\n/tz - Set timezone\n/check - Diagnostics'));

  bot.command('tz', async (ctx) => {
      const arg = ctx.match?.trim();
      if (arg) {
          try {
              // Validate timezone
              new Intl.DateTimeFormat('en-GB', { timeZone: arg });
              if (c.env.JULES_NOTIFICATIONS_KV) {
                  const userId = ctx.from?.id;
                  if (!userId) return await ctx.reply('❌ Unable to identify user.');
                  await c.env.JULES_NOTIFICATIONS_KV.put(`tz:${userId}`, arg);
                  return await ctx.reply(`✅ Timezone updated to \`${arg}\``, { parse_mode: 'Markdown' });
              } else {
                  return await ctx.reply('❌ KV not configured.');
              }
          } catch {
              return await ctx.reply(`❌ Invalid timezone: \`${arg}\`\n\nExamples:\n- \`Asia/Shanghai\`\n- \`Europe/London\`\n- \`UTC\``, { parse_mode: 'Markdown' });
          }
      }

      const keyboard = new InlineKeyboard()
          .text('Shanghai (UTC+8)', `${CallbackAction.SetTimezone}:Asia/Shanghai`).row()
          .text('Tokyo (UTC+9)', `${CallbackAction.SetTimezone}:Asia/Tokyo`).row()
          .text('London (UTC+0/1)', `${CallbackAction.SetTimezone}:Europe/London`).row()
          .text('New York (UTC-5/4)', `${CallbackAction.SetTimezone}:America/New_York`).row()
          .text('UTC', `${CallbackAction.SetTimezone}:UTC`).row();

      const tz = await getUserTimezone(c.env, ctx.from?.id);
      await ctx.reply(`🕒 **Timezone Settings**\n\nCurrent: \`${tz}\`\n\nSelect a timezone or use: \`/tz Asia/Shanghai\``, {
          parse_mode: 'Markdown',
          reply_markup: keyboard
      });
  });

  bot.command('check', async (ctx) => {
      let report = "🛠 **System Check**\n\n";
      const userId = ctx.from?.id;
      report += `✅ Admin ID: \`${userId || 'unknown'}\`\n`;
      report += `✅ API Key: ${c.env.JULES_API_KEY ? 'OK' : '❌'}\n`;
      report += `✅ Webhook Secret: ${c.env.WEBHOOK_SECRET_TOKEN ? 'OK' : '❌ (Optional)'}\n`;
      if (c.env.JULES_NOTIFICATIONS_KV) {
          try {
              await c.env.JULES_NOTIFICATIONS_KV.put('check_v9', 'ok');
              const raw = await c.env.JULES_NOTIFICATIONS_KV.get('track:registry');
              const registry: TrackedSession[] = raw ? JSON.parse(raw) : [];
              report += `✅ KV: Working\n\n**Tracking List (${registry.length}):**\n`;
              if (registry.length > 0) {
                  registry.forEach(s => {
                      const ageMin = Math.round((Date.now() - s.createTime) / 60000);
                      report += `- \`${s.id}\`: ${escapeMarkdown(s.title)} (${ageMin}m ago)\n`;
                  });
              } else report += "_No sessions currently being tracked._";
          }
          catch (e: unknown) {
              const errorMessage = e instanceof Error ? e.message : String(e);
              report += `❌ KV: Error (${errorMessage})\n`;
          }
      } else report += `ℹ️ KV: Not bound\n`;
      try { await jules.listSources(); report += `✅ API: Connected\n`; }
      catch (e: unknown) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          report += `❌ API: Failed (${errorMessage})\n`;
      }
      await ctx.reply(report, { parse_mode: 'Markdown' });
  });

  bot.command('sessions', async (ctx) => {
    try {
      const { sessions } = await jules.listSessions();
      if (!sessions || sessions.length === 0) return ctx.reply('No active sessions.');
      const keyboard = new InlineKeyboard();
      sessions.slice(0, 10).forEach((s) => {
        const id = s.name.split('/').pop() || 'unknown';
        keyboard.text(`📝 ${s.title || s.displayName || id}`, `${CallbackAction.ViewSession}:${id}`).row();
      });
      await ctx.reply('Recent Sessions:', { reply_markup: keyboard });
    } catch (e: unknown) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        await ctx.reply(`❌ Error: ${errorMessage}`);
    }
  });

  const showRepoList = async (ctx: BotContext, pageToken?: string) => {
    try {
      const { sources, nextPageToken } = await jules.listSources({ pageSize: 8, pageToken });
      if (!sources || sources.length === 0) return ctx.reply('No repositories found.');
      const keyboard = new InlineKeyboard();
      for (const src of sources) {
          const name = src.name.split('/').pop() || 'unknown';
          const cb = await getCallbackData(c.env, CallbackAction.WizardRepo, '', src.name);
          keyboard.text(name, cb).row();
      }
      if (nextPageToken) {
          const nextCb = await getCallbackData(c.env, CallbackAction.WizardRepoPage, '', nextPageToken);
          keyboard.row().text('Next ➡️', nextCb);
      }

      const tz = await getUserTimezone(c.env, ctx.from?.id);
      const text = addTimestamp('🚀 Step 1: Select a repository:', tz);
      if (ctx.callbackQuery) await ctx.editMessageText(text, { reply_markup: keyboard });
      else await ctx.reply(text, { reply_markup: keyboard });
    } catch (e: unknown) {
        if (isMessageNotModifiedError(e)) return;
        const errorMessage = e instanceof Error ? e.message : String(e);
        await ctx.reply(`❌ Error: ${errorMessage}`);
    }
  };

  bot.command('new', (ctx) => showRepoList(ctx));

  bot.command('cancel', async (ctx) => {
      if (!c.env.JULES_NOTIFICATIONS_KV) return ctx.reply('❌ KV not configured.');
      const userId = ctx.from?.id;
      if (!userId) return ctx.reply('❌ Unable to identify user.');
      await clearUserWizards(c.env, userId);
      await ctx.reply('✅ All ongoing /new wizard flows have been cancelled.');
  });

  bot.command('reply', async (ctx) => {
    const match = ctx.message?.text?.match(/\/reply\s+([^\s]+)\s+(.+)/);
    if (!match) return ctx.reply('Usage: /reply [session_id] [message]');
    const sid = match[1];
    try {
      await jules.sendMessage(sid, match[2]);
      await registerSession(c.env, jules, sid);
      await ctx.reply(`✅ Sent to \`${sid}\`. (Now tracking)`);
    } catch (e: unknown) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        await ctx.reply(`❌ Failed: ${errorMessage}`);
    }
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
      const sessionId = session.name.split('/').pop() || 'unknown';
      await registerSession(c.env, jules, sessionId, options.title || prompt.substring(0, 30));
      await ctx.reply(`🚀 Started! ID: \`${sessionId}\``);
    } catch (e: unknown) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        await ctx.reply(`❌ Failed: ${errorMessage}`);
    }
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
                const sid = session.name.split('/').pop() || 'unknown';
                await registerSession(c.env, jules, sid, state.title || text.substring(0, 30));

                // Cleanup wizard state
                await deleteWizardState(c.env, wizId, state.userId);

                return ctx.reply(`🚀 Session started! ID: \`${sid}\` (Tracked)`);
            } catch (e: unknown) {
                const errorMessage = e instanceof Error ? e.message : String(e);
                return ctx.reply(`❌ Failed to create session: ${errorMessage}`);
            }
        } else {
            return ctx.reply('⚠️ Wizard session expired or not found. Please start over with /new.');
        }
    }

    // Pattern 2: Normal reply to a session message
    if (replyTo) {
      // Use multiple patterns to robustly extract session ID.
      // Use a negative lookbehind (?<!Wiz) to ensure we don't accidentally match WizID as a session ID.
      // Prioritize ID: field, then generic "session <ID>", then fallback to Session:
      const sidPatterns = [
        /(?<!Wiz)(?:\*\*|__)?ID(?:\*\*|__)?\s*[:：]\s*[`*_]*([0-9a-zA-Z._-]+)[`*_]*/i,
        /(?<!Wiz)(?:\*\*|__)?ID(?:\*\*|__)?\s*(?:\*\*|__)?[:：](?:\*\*|__)?\s*[`*_]*([0-9a-zA-Z._-]+)[`*_]*/i,
        /session\s+[`*_]*([0-9a-zA-Z._-]+)[`*_]*/i,
        /(?<!Wiz)(?:\*\*|__)?Session(?:\*\*|__)?\s*[:：]\s*[`*_]*([0-9a-zA-Z._-]+)[`*_]*/i
      ];

      let sessionId: string | null = null;
      for (const p of sidPatterns) {
        const match = replyText.match(p);
        if (match) {
          sessionId = match[1];
          break;
        }
      }

      if (sessionId) {
        try {
          await jules.sendMessage(sessionId, text);
          await registerSession(c.env, jules, sessionId);
          return ctx.reply(`✅ Sent to session \`${sessionId}\`. (Now tracking)`, { reply_to_message_id: ctx.message.message_id });
        } catch (e: unknown) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            return ctx.reply(`❌ Failed to send: ${errorMessage}`);
        }
      }
    }

    await ctx.reply('Use /help or reply to a session message to chat.');
  });

  // 3. Callback Handlers
  const approvePlan = async (ctx: BotContext, sessionId: string) => {
    await jules.approvePlan(sessionId);
    await registerSession(c.env, jules, sessionId);
    const session = await jules.getSession(sessionId);
    const title = session.title || session.displayName || sessionId;
    const keyboard = new InlineKeyboard()
            .text('🔄 Refresh', `${CallbackAction.ViewSession}:${sessionId}`)
            .text('📋 Activities', `${CallbackAction.Activities}:${sessionId}`).row()
            .text('📋 View Plan', `${CallbackAction.PlanView}:${sessionId}`)
            .text('🔙 List', CallbackAction.SessionsBack);
    const tz = await getUserTimezone(c.env, ctx.from?.id);
    const text = addTimestamp(`✅ Approved! Current status: \`${session.state}\`\n\n**Session:** ${escapeMarkdown(title)}\n**ID:** \`${sessionId}\``, tz);
    await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
  };

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

    const handleAction = async () => {
        switch (action) {
            case CallbackAction.SetTimezone: {
                const newTz = id;
                if (!c.env.JULES_NOTIFICATIONS_KV) return await ctx.reply('❌ KV not configured.');
                const userId = ctx.from?.id;
                if (!userId) return await ctx.reply('❌ Unable to identify user.');
                await c.env.JULES_NOTIFICATIONS_KV.put(`tz:${userId}`, newTz);
                await ctx.editMessageText(`✅ Timezone updated to \`${newTz}\``, { parse_mode: 'Markdown' });
                break;
            }
            case CallbackAction.WizardRepoPage:
                await showRepoList(ctx, args[2] || subId);
                break;
            case CallbackAction.WizardRepo: {
                const targetRepo = args[2] || subId;
                const { sources } = await jules.listSources({ pageSize: 100 });
                const source = sources?.find((s) => s.name === targetRepo);
                if (!source) return ctx.reply('Source not found.');
                const branches = source.githubRepo?.branches?.map((b) => b.displayName) || ['main'];
                const userId = ctx.from?.id;
                if (!userId) return await ctx.reply('❌ Unable to identify user.');
                const wizId = await saveWizardState(c.env, { source: targetRepo, startingBranch: 'main', branches, userId });
                const keyboard = new InlineKeyboard();
                branches.slice(0, 10).forEach((br: string, idx: number) => {
                    keyboard.text(br, `${CallbackAction.WizardBranch}:${wizId}:${idx}`).row();
                });
                const tz = await getUserTimezone(c.env, ctx.from?.id);
                await ctx.editMessageText(addTimestamp(`📂 Repo: \`${targetRepo}\`\n\n🚀 Step 2: Select branch:`, tz), { parse_mode: 'Markdown', reply_markup: keyboard });
                break;
            }
            case CallbackAction.WizardBranch: {
                const state = await getWizardState(c.env, id);
                if (!state || !state.branches) return ctx.reply('Wizard expired. Start over with /new.');
                state.startingBranch = state.branches[parseInt(subId)];
                const wizId = await saveWizardState(c.env, state);
                const keyboard = new InlineKeyboard()
                    .text('📋 Interactive', `${CallbackAction.WizardMode}:${wizId}:int`).row()
                    .text('⚡ Auto', `${CallbackAction.WizardMode}:${wizId}:auto`).row();
                const tz = await getUserTimezone(c.env, ctx.from?.id);
                await ctx.editMessageText(addTimestamp(`📂 Repo: \`${state.source}\`\n🌿 Branch: \`${state.startingBranch}\`\n\n🚀 Step 3: Select mode:`, tz), { parse_mode: 'Markdown', reply_markup: keyboard });
                break;
            }
            case CallbackAction.WizardMode: {
                const state = await getWizardState(c.env, id);
                if (!state) return ctx.reply('Wizard expired.');
                state.requirePlanApproval = (subId === 'int');
                const wizId = await saveWizardState(c.env, state);
                const keyboard = new InlineKeyboard()
                    .text('✅ Yes', `${CallbackAction.WizardPR}:${wizId}:yes`)
                    .text('❌ No', `${CallbackAction.WizardPR}:${wizId}:no`).row();
                const tz = await getUserTimezone(c.env, ctx.from?.id);
                await ctx.editMessageText(addTimestamp(`🛠 Mode: \`${state.requirePlanApproval ? 'Interactive' : 'Auto'}\`\n\n🚀 Step 4: Auto PR?`, tz), { parse_mode: 'Markdown', reply_markup: keyboard });
                break;
            }
            case CallbackAction.WizardPR: {
                const state = await getWizardState(c.env, id);
                if (!state) return ctx.reply('Wizard expired.');
                state.automationMode = (subId === 'yes' ? 'AUTO_CREATE_PR' : 'AUTOMATION_MODE_UNSPECIFIED');
                const wizId = await saveWizardState(c.env, state);
                await ctx.reply(`🚀 **READY TO START**\n\n📂 Repo: \`${state.source}\`\n🌿 Branch: \`${state.startingBranch}\`\n🛠 Mode: \`${state.requirePlanApproval ? 'Interactive' : 'Auto'}\`\n📦 PR: \`${state.automationMode === 'AUTO_CREATE_PR' ? 'Yes' : 'No'}\`\n\n**WizID:** \`${wizId}\`\nReply with your task prompt:`, {
                    parse_mode: 'Markdown',
                    reply_markup: { force_reply: true }
                });
                break;
            }
            case CallbackAction.ViewSession: {
                const session = await jules.getSession(id);
                const title = session.title || session.displayName || id;
                const keyboard = new InlineKeyboard();
                if (session.state === 'AWAITING_PLAN_APPROVAL') {
                    keyboard.text('👍 Approve Plan', `${CallbackAction.ApprovePlan}:${id}`).row();
                }
                keyboard.text('🔄 Refresh', `${CallbackAction.ViewSession}:${id}`)
                        .text('📋 Activities', `${CallbackAction.Activities}:${id}`).row()
                        .text('📋 View Plan', `${CallbackAction.PlanView}:${id}`)
                        .text('🔙 List', CallbackAction.SessionsBack);
                const tz = await getUserTimezone(c.env, ctx.from?.id);
                const text = addTimestamp(`**Session:** ${escapeMarkdown(title)}\n**ID:** \`${id}\`\n**Status:** \`${session.state}\`\n\n💡 _Reply to chat._`, tz);
                await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
                break;
            }
            case CallbackAction.Activities: {
                const { activities } = await jules.getAllActivities(id);
                const filtered = activities.filter((a) => getActivityType(a) !== 'PROGRESS_UPDATED');
                const keyboard = new InlineKeyboard();
                let listText = `**Recent Activities**\nID: \`${id}\`\n\n`;
                const items = filtered.slice(-5).reverse();
                const tz = await getUserTimezone(c.env, ctx.from?.id);
                const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
                for (let i=0; i<items.length; i++) {
                    const a = items[i];
                    const type = getActivityType(a);
                    const time = new Date(a.createTime).toLocaleTimeString('en-GB', { timeZone: tz, hour12: false });
                    const originalIdx = filtered.length - 1 - i;
                    const emoji = emojis[i] || `${i + 1}`;
                    listText += `${emoji} 🕒 ${time} **${getFriendlyType(type)}**\n${escapeMarkdown(getSummary(a, false))}\n\n`;
                    const cb = await getCallbackData(c.env, CallbackAction.ActivityDetail, id, originalIdx.toString());
                    keyboard.text(emoji, cb);
                }
                keyboard.row().text('🔙 Back', `${CallbackAction.ViewSession}:${id}`);
                await ctx.editMessageText(addTimestamp(listText.substring(0, 4000), tz), { parse_mode: 'Markdown', reply_markup: keyboard });
                break;
            }
            case CallbackAction.ActivityDetail: {
                const { activities } = await jules.getAllActivities(id);
                const filtered = activities.filter((a) => getActivityType(a) !== 'PROGRESS_UPDATED');
                const activity = filtered[parseInt(subId)];
                if (!activity) return ctx.reply('Expired.');
                const type = getActivityType(activity);
                const fullContent = `**Activity Detail**\n**ID:** \`${id}\`\n**Type:** ${getFriendlyType(type)}\n\n${escapeMarkdown(getSummary(activity, true))}`;
                const keyboard = new InlineKeyboard().text('🔙 Back', `${CallbackAction.Activities}:${id}`);
                const tz = await getUserTimezone(c.env, ctx.from?.id);
                if (fullContent.length <= 4000) await ctx.editMessageText(addTimestamp(fullContent, tz), { parse_mode: 'Markdown', reply_markup: keyboard });
                else {
                    await sendLongMessage(bot, ctx.chat!.id, fullContent, { parse_mode: 'Markdown' });
                    await ctx.reply('^ Full details above.', { reply_markup: keyboard });
                }
                break;
            }
            case CallbackAction.PlanView: {
                const session = await jules.getSession(id);
                const { activities } = await jules.getAllActivities(id);
                const planText = formatPlan(activities);
                const keyboard = new InlineKeyboard();
                if (session.state === 'AWAITING_PLAN_APPROVAL') {
                    keyboard.text('👍 Approve Plan', `${CallbackAction.ApprovePlan}:${id}`).row();
                }
                keyboard.text('⬅️ Back', `${CallbackAction.ViewSession}:${id}`);
                const content = `📋 **Plan Details**\n**ID:** \`${id}\`\n\n${planText}`;
                const tz = await getUserTimezone(c.env, ctx.from?.id);
                if (content.length <= 4000) await ctx.editMessageText(addTimestamp(content, tz), { parse_mode: 'Markdown', reply_markup: keyboard });
                else {
                    await sendLongMessage(bot, ctx.chat!.id, content, { parse_mode: 'Markdown' });
                    await ctx.reply('^ Plan details above.', { reply_markup: keyboard });
                }
                break;
            }
            case CallbackAction.ApprovePlan:
                await approvePlan(ctx, id);
                break;
            case CallbackAction.SessionsBack: {
                const { sessions } = await jules.listSessions();
                const tz = await getUserTimezone(c.env, ctx.from?.id);
                if (!sessions || sessions.length === 0) return ctx.editMessageText(addTimestamp('No active sessions.', tz));
                const keyboard = new InlineKeyboard();
                sessions.slice(0, 10).forEach((s) => {
                    const id = s.name.split('/').pop() || 'unknown';
                    keyboard.text(`📝 ${s.title || s.displayName || id}`, `${CallbackAction.ViewSession}:${id}`).row();
                });
                await ctx.editMessageText(addTimestamp('Recent Sessions:', tz), { reply_markup: keyboard });
                break;
            }
        }
    };

    try {
        await handleAction();
    } catch (e: unknown) {
        if (isMessageNotModifiedError(e)) return;
        const errorMessage = e instanceof Error ? e.message : String(e);
        await ctx.reply(`Error: ${errorMessage}`);
    }
  });

  bot.api.setMyCommands([
    { command: "sessions", description: "Manage tasks" },
    { command: "new", description: "Create task" },
    { command: "cancel", description: "Cancel current wizard flow" },
    { command: "tz", description: "Set timezone" },
    { command: "check", description: "Diagnostics" },
    { command: "help", description: "Help" }
  ]).catch(() => {});

  return webhookCallback(bot, 'std/http', {
    secretToken: c.env.WEBHOOK_SECRET_TOKEN,
  })(c.req.raw);
});

export default {
  fetch: app.fetch,
  scheduled: (event: any, env: Env, ctx: any) => {
    ctx.waitUntil(handleScheduled(env));
  }
};
