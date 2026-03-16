import { Hono } from 'hono';
import { Bot, webhookCallback, InlineKeyboard, GrammyError, HttpError, Api, RawApi, CallbackQueryContext, Context as BotContext } from 'grammy';
import { I18n, I18nFlavor } from '@grammyjs/i18n';
import { Env, JulesClient, CreateSessionOptions } from './lib/jules';
import { en } from './locales/en';
import { zh } from './locales/zh';

const app = new Hono<{ Bindings: Env }>();

type MyContext = BotContext & I18nFlavor;

const i18n = new I18n<MyContext>({
    defaultLocale: 'en',
    useSession: false, // We use KV for persistence, not grammY sessions
});

i18n.loadLocale('en', { source: en });
i18n.loadLocale('zh', { source: zh });

const WIZARD_EXPIRATION_TTL = 1800; // 30 minutes

const CallbackAction = {
    SetLanguage: 'set_lang',
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

async function sendLongMessage(bot: Bot<any>, chatId: string | number, text: string, options: Parameters<Api<RawApi>["sendMessage"]>[2] = {}) {
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

function getFriendlyType(type: string, t: (key: string, vars?: any) => string): string {
    const map: Record<string, string> = {
        'PLAN_GENERATED': t('status-plan-generated'),
        'PLAN_APPROVED': t('status-plan-approved'),
        'USER_MESSAGED': t('status-user-messaged'),
        'AGENT_MESSAGED': t('status-agent-messaged'),
        'SESSION_COMPLETED': t('status-completed'),
        'SESSION_FAILED': t('status-failed'),
        'AWAITING_PLAN_APPROVAL': t('status-awaiting-approval'),
        'AWAITING_USER_FEEDBACK': t('status-awaiting-feedback'),
        'PROGRESS_UPDATED': t('status-progress')
    };
    return map[type] || type || 'ACTIVITY';
}

function addTimestamp(text: string, t: (key: string, vars?: any) => string, timezone: string = 'UTC'): string {
    const now = new Date();
    try {
        const timeStr = new Intl.DateTimeFormat('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
            timeZone: timezone
        }).format(now);
        return `${text}\n\n${t('last-updated', { time: timeStr, tz: timezone })}`;
    } catch {
        const timeStr = now.toTimeString().slice(0, 8);
        return `${text}\n\n${t('last-updated-fallback', { time: timeStr })}`;
    }
}

async function getUserTimezone(env: Env, userId?: number): Promise<string> {
    if (!userId || !env.JULES_NOTIFICATIONS_KV) return 'UTC';
    return await env.JULES_NOTIFICATIONS_KV.get(`tz:${userId}`) || 'UTC';
}

async function getUserLanguage(env: Env, userId?: number): Promise<string | undefined> {
    if (!userId || !env.JULES_NOTIFICATIONS_KV) return undefined;
    return await env.JULES_NOTIFICATIONS_KV.get(`lang:${userId}`) || undefined;
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

function getSummary(activity: any, t: (key: string, vars?: any) => string, verbose = true): string {
    let raw = '';
    if (activity.agentMessaged?.agentMessage) raw = activity.agentMessaged.agentMessage;
    else if (activity.userMessaged?.userMessage) raw = activity.userMessaged.userMessage;
    else if (activity.planGenerated?.plan) raw = t('plan-steps-ready', { count: activity.planGenerated.plan.steps?.length || 0 });
    else if (activity.description) raw = activity.description;
    else if (activity.summary) raw = activity.summary;
    else if (activity.status?.message) raw = activity.status.message;
    else if (activity.userRequest?.prompt) raw = activity.userRequest.prompt;
    else if (activity.agentResponse?.text) raw = activity.agentResponse.text;
    else if (activity.progressUpdated?.description) raw = activity.progressUpdated.description;
    else if (activity.sessionCompleted) raw = t('msg-task-completed');
    else if (activity.sessionFailed?.reason) raw = activity.sessionFailed.reason;
    else if (activity.sessionFailed) raw = t('msg-task-failed');

    if (!raw && activity.artifacts && activity.artifacts.length > 0) {
        raw = t('msg-code-changes');
    }

    if (!raw) raw = t('msg-no-details');

    if (!verbose && raw.length > 60) return raw.substring(0, 57) + '...';
    return raw;
}

function formatPlan(activities: any[], t: (key: string, vars?: any) => string): string {
    const planActivity = activities.find(a => a.type === 'PLAN_GENERATED' || a.planGenerated);
    if (!planActivity) return t('plan-no-details');
    const plan = planActivity.planGenerated?.plan;
    if (plan && plan.steps) {
        return plan.steps.map((s: any, idx: number) => {
            const displayIndex = (typeof s.index === 'number') ? s.index + 1 : idx + 1;
            return `**${displayIndex}. ${escapeMarkdown(s.title)}**\n${escapeMarkdown(s.description)}`;
        }).join('\n\n');
    }
    return escapeMarkdown(getSummary(planActivity, t));
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
    const adminLang = await getUserLanguage(env, parseInt(adminId)) || 'en';
    const t = (key: string, vars?: any) => i18n.t(adminLang, key, vars);

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
                    keyboard.text(t('btn-approve'), `${CallbackAction.ApprovePlan}:${entry.id}`).row();
                }
                keyboard.text(t('btn-activities'), `${CallbackAction.ViewSession}:${entry.id}`).row();

                let notifyMsg = `${t('notify-title')}\n\n`;
                notifyMsg += `${t('session-view-title', { title: escapeMarkdown(entry.title) })}\n`;
                notifyMsg += `${t('session-view-status', { status: session.state })}\n\n`;
                notifyMsg += t('notify-reached-milestone');

                await bot.api.sendMessage(adminId, notifyMsg, { parse_mode: 'Markdown', reply_markup: keyboard });
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
  const bot = new Bot<MyContext>(c.env.TELEGRAM_TOKEN);

  bot.use(i18n);
  bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      const kvLang = await getUserLanguage(c.env, userId);
      if (kvLang) {
          await ctx.i18n.setLocale(kvLang);
      }
      return next();
  });

  const adminIds = c.env.ADMIN_USER_ID?.split(',').map(id => id.trim()) || [];
  const jules = new JulesClient(c.env.JULES_API_KEY);

  // Global Error Handler
  bot.catch((err) => {
    if (isMessageNotModifiedError(err.error)) return;
    const ctx = err.ctx;
    console.error(`Bot Error:`, err.error);
    const adminId = adminIds[0];
    if (adminId) {
        let errMsg = `${ctx.t('error-prefix')}\n\n`;
        if (err instanceof GrammyError) errMsg += ctx.t('error-grammy', { message: err.message });
        else if (err instanceof HttpError) errMsg += ctx.t('error-telegram', { message: err.message });
        else errMsg += ctx.t('error-generic', { message: String(err.error) });
        bot.api.sendMessage(adminId, errMsg, { parse_mode: 'Markdown' }).catch(() => {});
    }
  });

  bot.use(async (ctx, next) => {
    if (ctx.from && adminIds.includes(ctx.from.id.toString())) return next();
    if (ctx.message?.text?.startsWith('/')) await ctx.reply(ctx.t('unauthorized'));
  });

  // 1. Commands
  bot.command('start', (ctx) => ctx.reply(ctx.t('start-msg')));

  bot.command('lang', async (ctx) => {
      const keyboard = new InlineKeyboard()
          .text('English 🇺🇸', `${CallbackAction.SetLanguage}:en`)
          .text('中文 🇨🇳', `${CallbackAction.SetLanguage}:zh`);

      const currentLocale = await ctx.i18n.getLocale();
      const text = `${ctx.t('lang-title')}\n\n${ctx.t('lang-current', { lang: currentLocale })}\n\n${ctx.t('lang-select')}`;
      await ctx.reply(text, {
          parse_mode: 'Markdown',
          reply_markup: keyboard
      });
  });

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
                  return await ctx.reply(ctx.t('tz-updated', { tz: arg }), { parse_mode: 'Markdown' });
              } else {
                  return await ctx.reply(ctx.t('cancel-no-kv'));
              }
          } catch {
              return await ctx.reply(ctx.t('tz-invalid', { tz: arg }), { parse_mode: 'Markdown' });
          }
      }

      const keyboard = new InlineKeyboard()
          .text('Shanghai (UTC+8)', `${CallbackAction.SetTimezone}:Asia/Shanghai`).row()
          .text('Tokyo (UTC+9)', `${CallbackAction.SetTimezone}:Asia/Tokyo`).row()
          .text('London (UTC+0/1)', `${CallbackAction.SetTimezone}:Europe/London`).row()
          .text('New York (UTC-5/4)', `${CallbackAction.SetTimezone}:America/New_York`).row()
          .text('UTC', `${CallbackAction.SetTimezone}:UTC`).row();

      const tz = await getUserTimezone(c.env, ctx.from?.id);
      const tzText = `${ctx.t('tz-title')}\n\n${ctx.t('tz-current', { tz })}\n\n${ctx.t('tz-select')}`;
      await ctx.reply(tzText, {
          parse_mode: 'Markdown',
          reply_markup: keyboard
      });
  });

  bot.command('check', async (ctx) => {
      let report = `${ctx.t('check-report-title')}\n\n`;
      const userId = ctx.from?.id;
      report += ctx.t('check-admin-id', { id: userId || 'unknown' }) + '\n';
      report += ctx.t('check-api-key', { status: c.env.JULES_API_KEY ? 'OK' : '❌' }) + '\n';
      report += ctx.t('check-webhook-secret', { status: c.env.WEBHOOK_SECRET_TOKEN ? 'OK' : '❌ (Optional)' }) + '\n';
      if (c.env.JULES_NOTIFICATIONS_KV) {
          try {
              await c.env.JULES_NOTIFICATIONS_KV.put('check_v9', 'ok');
              const raw = await c.env.JULES_NOTIFICATIONS_KV.get('track:registry');
              const registry: TrackedSession[] = raw ? JSON.parse(raw) : [];
              report += ctx.t('check-kv-working') + '\n\n' + ctx.t('check-tracking-list', { count: registry.length }) + '\n';
              if (registry.length > 0) {
                  registry.forEach(s => {
                      const ageMin = Math.round((Date.now() - s.createTime) / 60000);
                      report += `- \`${s.id}\`: ${escapeMarkdown(s.title)} (${ageMin}m ago)\n`;
                  });
              } else report += ctx.t('check-no-sessions');
          }
          catch (e: unknown) {
              const errorMessage = e instanceof Error ? e.message : String(e);
              report += ctx.t('check-kv-error', { error: errorMessage }) + '\n';
          }
      } else report += ctx.t('check-kv-not-bound') + '\n';
      report += "\n";
      try { await jules.listSources(); report += ctx.t('check-api-connected') + '\n'; }
      catch (e: unknown) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          report += ctx.t('check-api-failed', { error: errorMessage }) + '\n';
      }
      await ctx.reply(report, { parse_mode: 'Markdown' });
  });

  bot.command('sessions', async (ctx) => {
    try {
      const { sessions } = await jules.listSessions();
      if (!sessions || sessions.length === 0) return ctx.reply(ctx.t('sessions-none'));
      const keyboard = new InlineKeyboard();
      sessions.slice(0, 10).forEach((s) => {
        const id = s.name.split('/').pop() || 'unknown';
        keyboard.text(`📝 ${s.title || s.displayName || id}`, `${CallbackAction.ViewSession}:${id}`).row();
      });
      await ctx.reply(ctx.t('sessions-recent'), { reply_markup: keyboard });
    } catch (e: unknown) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        await ctx.reply(`${ctx.t('error-prefix')}\n\n${ctx.t('error-generic', { message: errorMessage })}`);
    }
  });

  const showRepoList = async (ctx: MyContext, pageToken?: string) => {
    try {
      const { sources, nextPageToken } = await jules.listSources({ pageSize: 8, pageToken });
      if (!sources || sources.length === 0) return ctx.reply(ctx.t('msg-no-details'));
      const keyboard = new InlineKeyboard();
      for (const src of sources) {
          const name = src.name.split('/').pop() || 'unknown';
          const cb = await getCallbackData(c.env, CallbackAction.WizardRepo, '', src.name);
          keyboard.text(name, cb).row();
      }
      if (nextPageToken) {
          const nextCb = await getCallbackData(c.env, CallbackAction.WizardRepoPage, '', nextPageToken);
          keyboard.row().text(ctx.t('btn-next'), nextCb);
      }

      const tz = await getUserTimezone(c.env, ctx.from?.id);
      const text = addTimestamp(ctx.t('wizard-step-repo'), ctx.t, tz);
      if (ctx.callbackQuery) await ctx.editMessageText(text, { reply_markup: keyboard });
      else await ctx.reply(text, { reply_markup: keyboard });
    } catch (e: unknown) {
        if (isMessageNotModifiedError(e)) return;
        const errorMessage = e instanceof Error ? e.message : String(e);
        await ctx.reply(`${ctx.t('error-prefix')}\n\n${ctx.t('error-generic', { message: errorMessage })}`);
    }
  };

  bot.command('new', (ctx) => showRepoList(ctx));

  bot.command('cancel', async (ctx) => {
      if (!c.env.JULES_NOTIFICATIONS_KV) return ctx.reply(ctx.t('cancel-no-kv'));
      const userId = ctx.from?.id;
      if (!userId) return ctx.reply('❌ Unable to identify user.');
      await clearUserWizards(c.env, userId);
      await ctx.reply(ctx.t('cancel-success'));
  });

  bot.command('reply', async (ctx) => {
    const match = ctx.message?.text?.match(/\/reply\s+([^\s]+)\s+(.+)/);
    if (!match) return ctx.reply(ctx.t('reply-usage'));
    const sid = match[1];
    try {
      await jules.sendMessage(sid, match[2]);
      await registerSession(c.env, jules, sid);
      await ctx.reply(ctx.t('reply-success', { id: sid }));
    } catch (e: unknown) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        await ctx.reply(ctx.t('reply-failed', { error: errorMessage }));
    }
  });

  bot.command('start_session', async (ctx) => {
    const parts = ctx.message?.text?.split(/\s+/) || [];
    if (parts.length < 3) return ctx.reply(ctx.t('start-session-usage'));
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
    if (!prompt) return ctx.reply(ctx.t('start-session-no-prompt'));
    try {
      const session = await jules.createSession(sourceName, prompt, options);
      const sessionId = session.name.split('/').pop() || 'unknown';
      await registerSession(c.env, jules, sessionId, options.title || prompt.substring(0, 30));
      await ctx.reply(ctx.t('start-session-success', { id: sessionId }));
    } catch (e: unknown) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        await ctx.reply(`${ctx.t('error-prefix')}\n\n${ctx.t('error-generic', { message: errorMessage })}`);
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

                return ctx.reply(ctx.t('session-started', { id: sid }));
            } catch (e: unknown) {
                const errorMessage = e instanceof Error ? e.message : String(e);
                return ctx.reply(`${ctx.t('error-prefix')}\n\n${ctx.t('error-generic', { message: errorMessage })}`);
            }
        } else {
            return ctx.reply(ctx.t('wizard-expired'));
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
          return ctx.reply(ctx.t('reply-success', { id: sessionId }), { reply_to_message_id: ctx.message.message_id });
        } catch (e: unknown) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            return ctx.reply(ctx.t('reply-failed', { error: errorMessage }));
        }
      }
    }

    await ctx.reply(ctx.t('session-chat-help'));
  });

  // 3. Callback Handlers
  const approvePlan = async (ctx: MyContext, sessionId: string) => {
    await jules.approvePlan(sessionId);
    await registerSession(c.env, jules, sessionId);
    const session = await jules.getSession(sessionId);
    const title = session.title || session.displayName || sessionId;
    const keyboard = new InlineKeyboard()
            .text(ctx.t('btn-refresh'), `${CallbackAction.ViewSession}:${sessionId}`)
            .text(ctx.t('btn-activities'), `${CallbackAction.Activities}:${sessionId}`).row()
            .text(ctx.t('btn-view-plan'), `${CallbackAction.PlanView}:${sessionId}`)
            .text(ctx.t('btn-list'), CallbackAction.SessionsBack);
    const tz = await getUserTimezone(c.env, ctx.from?.id);
    const text = addTimestamp(`${ctx.t('status-plan-approved')}! ${ctx.t('session-view-status', { status: session.state })}\n\n${ctx.t('session-view-title', { title: escapeMarkdown(title) })}\n${ctx.t('session-view-id', { id: sessionId })}`, ctx.t, tz);
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
            case CallbackAction.SetLanguage: {
                const newLang = id;
                if (!c.env.JULES_NOTIFICATIONS_KV) return await ctx.reply(ctx.t('cancel-no-kv'));
                const userId = ctx.from?.id;
                if (!userId) return await ctx.reply('❌ Unable to identify user.');
                await c.env.JULES_NOTIFICATIONS_KV.put(`lang:${userId}`, newLang);
                await ctx.i18n.setLocale(newLang);
                await ctx.editMessageText(ctx.t('lang-updated'), { parse_mode: 'Markdown' });
                break;
            }
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
                if (!source) return ctx.reply(ctx.t('msg-no-details'));
                const branches = source.githubRepo?.branches?.map((b) => b.displayName) || ['main'];
                const userId = ctx.from?.id;
                if (!userId) return await ctx.reply('❌ Unable to identify user.');
                const wizId = await saveWizardState(c.env, { source: targetRepo, startingBranch: 'main', branches, userId });
                const keyboard = new InlineKeyboard();
                branches.slice(0, 10).forEach((br: string, idx: number) => {
                    keyboard.text(br, `${CallbackAction.WizardBranch}:${wizId}:${idx}`).row();
                });
                const tz = await getUserTimezone(c.env, ctx.from?.id);
                const text = addTimestamp(`${ctx.t('wizard-repo-label', { repo: targetRepo })}\n\n${ctx.t('wizard-step-branch')}`, ctx.t, tz);
                await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
                break;
            }
            case CallbackAction.WizardBranch: {
                const state = await getWizardState(c.env, id);
                if (!state || !state.branches) return ctx.reply(ctx.t('wizard-expired'));
                state.startingBranch = state.branches[parseInt(subId)];
                const wizId = await saveWizardState(c.env, state);
                const keyboard = new InlineKeyboard()
                    .text(`📋 ${ctx.t('wizard-mode-interactive')}`, `${CallbackAction.WizardMode}:${wizId}:int`).row()
                    .text(`⚡ ${ctx.t('wizard-mode-auto')}`, `${CallbackAction.WizardMode}:${wizId}:auto`).row();
                const tz = await getUserTimezone(c.env, ctx.from?.id);
                const text = addTimestamp(`${ctx.t('wizard-repo-label', { repo: state.source })}\n${ctx.t('wizard-branch-label', { branch: state.startingBranch || '' })}\n\n${ctx.t('wizard-step-mode')}`, ctx.t, tz);
                await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
                break;
            }
            case CallbackAction.WizardMode: {
                const state = await getWizardState(c.env, id);
                if (!state) return ctx.reply(ctx.t('wizard-expired'));
                state.requirePlanApproval = (subId === 'int');
                const wizId = await saveWizardState(c.env, state);
                const keyboard = new InlineKeyboard()
                    .text(ctx.t('btn-yes'), `${CallbackAction.WizardPR}:${wizId}:yes`)
                    .text(ctx.t('btn-no'), `${CallbackAction.WizardPR}:${wizId}:no`).row();
                const tz = await getUserTimezone(c.env, ctx.from?.id);
                const modeStr = state.requirePlanApproval ? ctx.t('wizard-mode-interactive') : ctx.t('wizard-mode-auto');
                const text = addTimestamp(`${ctx.t('wizard-mode-label', { mode: modeStr })}\n\n${ctx.t('wizard-step-pr')}`, ctx.t, tz);
                await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard });
                break;
            }
            case CallbackAction.WizardPR: {
                const state = await getWizardState(c.env, id);
                if (!state) return ctx.reply(ctx.t('wizard-expired'));
                state.automationMode = (subId === 'yes' ? 'AUTO_CREATE_PR' : 'AUTOMATION_MODE_UNSPECIFIED');
                const wizId = await saveWizardState(c.env, state);
                const modeStr = state.requirePlanApproval ? ctx.t('wizard-mode-interactive') : ctx.t('wizard-mode-auto');
                const prStr = state.automationMode === 'AUTO_CREATE_PR' ? ctx.t('btn-yes') : ctx.t('btn-no');

                let readyMsg = `${ctx.t('wizard-ready-title')}\n\n`;
                readyMsg += `${ctx.t('wizard-repo-label', { repo: state.source })}\n`;
                readyMsg += `${ctx.t('wizard-branch-label', { branch: state.startingBranch || '' })}\n`;
                readyMsg += `${ctx.t('wizard-mode-label', { mode: modeStr })}\n`;
                readyMsg += `${ctx.t('wizard-pr-label', { pr: prStr })}\n\n`;
                readyMsg += `**WizID:** \`${wizId}\`\n${ctx.t('wizard-reply-prompt')}`;

                await ctx.reply(readyMsg, {
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
                    keyboard.text(ctx.t('btn-approve'), `${CallbackAction.ApprovePlan}:${id}`).row();
                }
                keyboard.text(ctx.t('btn-refresh'), `${CallbackAction.ViewSession}:${id}`)
                        .text(ctx.t('btn-activities'), `${CallbackAction.Activities}:${id}`).row()
                        .text(ctx.t('btn-view-plan'), `${CallbackAction.PlanView}:${id}`)
                        .text(ctx.t('btn-list'), CallbackAction.SessionsBack);
                const tz = await getUserTimezone(c.env, ctx.from?.id);
                let text = `${ctx.t('session-view-title', { title: escapeMarkdown(title) })}\n`;
                text += `${ctx.t('session-view-id', { id })}\n`;
                text += `${ctx.t('session-view-status', { status: session.state })}\n\n`;
                text += ctx.t('session-view-reply-hint');
                await ctx.editMessageText(addTimestamp(text, ctx.t, tz), { parse_mode: 'Markdown', reply_markup: keyboard });
                break;
            }
            case CallbackAction.Activities: {
                const { activities } = await jules.getAllActivities(id);
                const filtered = activities.filter((a) => getActivityType(a) !== 'PROGRESS_UPDATED');
                const keyboard = new InlineKeyboard();
                let listText = `${ctx.t('activities-title')}\nID: \`${id}\`\n\n`;
                const items = filtered.slice(-5).reverse();
                const tz = await getUserTimezone(c.env, ctx.from?.id);
                const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
                for (let i=0; i<items.length; i++) {
                    const a = items[i];
                    const type = getActivityType(a);
                    const time = new Date(a.createTime).toLocaleTimeString('en-GB', { timeZone: tz, hour12: false });
                    const originalIdx = filtered.length - 1 - i;
                    const emoji = emojis[i] || `${i + 1}`;
                    listText += `${emoji} 🕒 ${time} **${getFriendlyType(type, ctx.t)}**\n${escapeMarkdown(getSummary(a, ctx.t, false))}\n\n`;
                    const cb = await getCallbackData(c.env, CallbackAction.ActivityDetail, id, originalIdx.toString());
                    keyboard.text(emoji, cb);
                }
                keyboard.row().text(ctx.t('btn-back'), `${CallbackAction.ViewSession}:${id}`);
                await ctx.editMessageText(addTimestamp(listText.substring(0, 4000), ctx.t, tz), { parse_mode: 'Markdown', reply_markup: keyboard });
                break;
            }
            case CallbackAction.ActivityDetail: {
                const { activities } = await jules.getAllActivities(id);
                const filtered = activities.filter((a) => getActivityType(a) !== 'PROGRESS_UPDATED');
                const activity = filtered[parseInt(subId)];
                if (!activity) return ctx.reply(ctx.t('msg-no-details'));
                const type = getActivityType(activity);
                const fullContent = `${ctx.t('activity-detail-title')}\n**ID:** \`${id}\`\n${ctx.t('activity-detail-type', { type: getFriendlyType(type, ctx.t) })}\n\n${escapeMarkdown(getSummary(activity, ctx.t, true))}`;
                const keyboard = new InlineKeyboard().text(ctx.t('btn-back'), `${CallbackAction.Activities}:${id}`);
                const tz = await getUserTimezone(c.env, ctx.from?.id);
                if (fullContent.length <= 4000) await ctx.editMessageText(addTimestamp(fullContent, ctx.t, tz), { parse_mode: 'Markdown', reply_markup: keyboard });
                else {
                    await sendLongMessage(bot, ctx.chat!.id, fullContent, { parse_mode: 'Markdown' });
                    await ctx.reply('^ Full details above.', { reply_markup: keyboard });
                }
                break;
            }
            case CallbackAction.PlanView: {
                const session = await jules.getSession(id);
                const { activities } = await jules.getAllActivities(id);
                const planText = formatPlan(activities, ctx.t);
                const keyboard = new InlineKeyboard();
                if (session.state === 'AWAITING_PLAN_APPROVAL') {
                    keyboard.text(ctx.t('btn-approve'), `${CallbackAction.ApprovePlan}:${id}`).row();
                }
                keyboard.text(ctx.t('btn-back'), `${CallbackAction.ViewSession}:${id}`);
                const content = `${ctx.t('plan-details-title')}\n**ID:** \`${id}\`\n\n${planText}`;
                const tz = await getUserTimezone(c.env, ctx.from?.id);
                if (content.length <= 4000) await ctx.editMessageText(addTimestamp(content, ctx.t, tz), { parse_mode: 'Markdown', reply_markup: keyboard });
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
                if (!sessions || sessions.length === 0) return ctx.editMessageText(addTimestamp(ctx.t('sessions-none'), ctx.t, tz));
                const keyboard = new InlineKeyboard();
                sessions.slice(0, 10).forEach((s) => {
                    const id = s.name.split('/').pop() || 'unknown';
                    keyboard.text(`📝 ${s.title || s.displayName || id}`, `${CallbackAction.ViewSession}:${id}`).row();
                });
                await ctx.editMessageText(addTimestamp(ctx.t('sessions-recent'), ctx.t, tz), { reply_markup: keyboard });
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
    { command: "lang", description: "Set language" },
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
