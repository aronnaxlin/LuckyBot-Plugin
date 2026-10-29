import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import * as v from 'valibot';

import type { TavernConfig } from './types';
import type { GameChoice, GameDecideDeps, GameModule, GameReply } from '../games/types';
import { parseChoiceResponse, randomChoiceId } from '../games/types';
import type { HttpRequest, HttpResponse, PluginContext } from '../sdk/types';

const MAX_SEEN_REQUESTS = 1024;
const MAX_CACHED_DECISIONS = 256;
const MAX_CACHED_INVITATIONS = 64;
const MAX_STORED_ROUNDS = 50;
const ROUND_RETENTION_MS = 2 * 60 * 60 * 1000; // 2 hours
const SIGNATURE_WINDOW_SEC = 300;
const DECISION_DEADLINE_MARGIN_MS = 3000;
const MIN_DECISION_BUDGET_MS = 1000;
const RULES_EXCERPT_CHARS = 260;

const CommonRequestFields = {
  protocol: v.optional(v.number()),
  seq: v.optional(v.number()),
  game: v.optional(v.string()),
  match_id: v.optional(v.string()),
  chat_id: v.optional(v.string()),
  turn_id: v.optional(v.number()),
};

const InvitationRequestSchema = v.objectWithRest({
  ...CommonRequestFields,
  humans: v.optional(v.array(v.string())),
  bots: v.optional(v.array(v.string())),
  seats_left: v.optional(v.number()),
  mode: v.optional(v.string()),
  rules: v.optional(v.string()),
}, v.unknown());

const RoundStartRequestSchema = v.objectWithRest({
  ...CommonRequestFields,
  round: v.optional(v.union([v.number(), v.string()])),
}, v.unknown());

const DecisionRequestSchema = v.objectWithRest({
  ...CommonRequestFields,
  deadline_ms: v.optional(v.number()),
}, v.unknown());

const EventRequestSchema = v.objectWithRest({
  ...CommonRequestFields,
  event: v.string('event field is required'),
}, v.unknown());

const ChoiceSchema = v.objectWithRest({
  id: v.pipe(v.string(), v.nonEmpty()),
  say: v.optional(v.string(), ''),
}, v.unknown());

const ChoiceFieldsSchema = v.objectWithRest({
  ask: v.optional(v.string()),
  prompt: v.optional(v.string()),
  rules: v.optional(v.string()),
  choices: v.optional(v.array(ChoiceSchema)),
}, v.unknown());

export interface TavernChoiceFields {
  ask?: string;
  prompt?: string;
  rules?: string;
  choices: GameChoice[];
}

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Tavern decision timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

/**
 * HMAC-SHA256 over `{timestamp}.{METHOD}.{path}.{raw body bytes}`. The path
 * includes the deployment prefix (`basePath`) and excludes the query string.
 * The body is hashed as received bytes, never re-serialized.
 */
export const verifyTavernAuth = (
  req: HttpRequest,
  secret: string,
): { ok: true; timestamp: number } | { ok: false; status: number; error: string } => {
  const tsHeader = req.headers['x-tavern-timestamp'];
  const sigHeader = req.headers['x-tavern-signature'];

  const tsStr = Array.isArray(tsHeader) ? tsHeader[0] : tsHeader;
  const sigStr = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;

  if (!tsStr || !sigStr) {
    return { ok: false, status: 401, error: 'Missing tavern authentication headers' };
  }

  const timestamp = Number.parseInt(tsStr, 10);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(timestamp) || Math.abs(now - timestamp) > SIGNATURE_WINDOW_SEC) {
    return { ok: false, status: 401, error: 'Timestamp expired or invalid' };
  }

  const path = req.path.split('?')[0] ?? req.path;
  const mac = createHmac('sha256', secret)
    .update(`${tsStr}.${req.method.toUpperCase()}.${path}.`)
    .update(req.rawBody)
    .digest('hex');
  const expected = Buffer.from(`sha256=${mac}`, 'utf-8');
  const actual = Buffer.from(sigStr, 'utf-8');

  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, status: 401, error: 'Invalid tavern signature' };
  }

  return { ok: true, timestamp };
};

export interface StoredRound {
  round: number;
  data: unknown;
  receivedAt: number;
}

export interface TavernProtocolHandler {
  handleInvitation(req: HttpRequest, gameKey: string): Promise<HttpResponse>;
  handleRoundStart(req: HttpRequest, gameKey: string, matchId: string, round: string): Promise<HttpResponse>;
  handleDecision(req: HttpRequest, gameKey: string, matchId: string, turnIdStr: string): Promise<HttpResponse>;
  handleEvent(req: HttpRequest, gameKey: string, matchId: string): Promise<HttpResponse>;
}

export interface TavernInvitationQuestionInput {
  gameName: string;
  mode?: string;
  seatsLeft?: number;
  humans: readonly string[];
  bots: readonly string[];
  rules?: string;
}

const excerpt = (text: string, maxChars: number): string => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}…`;
};

export const buildTavernInvitationQuestion = (input: TavernInvitationQuestionInput): string => {
  const parts = [`荷官邀请你上桌玩【${input.gameName}】`];
  if (input.mode) parts.push(`这一局的玩法是「${input.mode}」`);
  if (input.seatsLeft !== undefined) parts.push(`桌上还剩 ${input.seatsLeft} 个空位`);
  parts.push(`已经上桌的真人：${input.humans.length > 0 ? input.humans.join('、') : '无'}`);
  parts.push(`已经上桌的机器人：${input.bots.length > 0 ? input.bots.join('、') : '无'}`);
  if (input.rules) parts.push(`这一局的规则（节选）：${excerpt(input.rules, RULES_EXCERPT_CHARS)}`);
  return `${parts.join('，')}。你要接受上桌邀请还是拒绝？`;
};

export const buildTavernInvitationPublicText = (input: TavernInvitationQuestionInput & { accept: boolean }): string => {
  const modeText = input.mode ? ` · ${input.mode}` : '';
  const seatText = input.seatsLeft !== undefined ? `，还剩 ${input.seatsLeft} 个空位` : '';
  const seated = [
    ...input.humans.map(name => `真人 ${name}`),
    ...input.bots.map(name => `机器人 ${name}`),
  ].join('、');
  const seatedText = seated ? `，桌上：${seated}` : '';
  return `荷官邀请你上桌（${input.gameName}${modeText}${seatText}${seatedText}）。${input.accept ? '你接受了。' : '你拒绝了。'}`;
};

export const computeDecisionBudgetMs = (configuredTimeoutMs: number, deadlineMs: number | undefined): number => {
  if (deadlineMs === undefined) return configuredTimeoutMs;
  return Math.max(MIN_DECISION_BUDGET_MS, Math.min(configuredTimeoutMs, deadlineMs - DECISION_DEADLINE_MARGIN_MS));
};

export const buildTavernChoicePrompt = (fields: TavernChoiceFields, state: string | undefined): string => {
  const askLine = fields.ask === 'aim'
    ? '这次要你决定：aim（选一个人开枪）'
    : `这次要你决定：${fields.ask ?? 'move'}（出手）`;
  const choicesText = fields.choices
    .map((choice, index) => `${index + 1}. ${choice.id} — ${choice.say || choice.id}`)
    .join('\n');

  return [
    fields.rules?.trim() ? `规则：\n${fields.rules.trim()}` : undefined,
    askLine,
    fields.prompt?.trim() ? `现在：${fields.prompt.trim()}` : undefined,
    state?.trim() ? `局面（只有你看得到）：\n${state.trim()}` : undefined,
    `从下面选一个，只回 JSON：{"choice": "<id>"}，id 必须原样照抄。\n${choicesText}`,
  ].filter((part): part is string => Boolean(part)).join('\n\n');
};

const parseChoiceFields = (body: unknown): TavernChoiceFields | undefined => {
  const parsed = v.safeParse(ChoiceFieldsSchema, body);
  if (!parsed.success) return undefined;
  if (!Array.isArray(parsed.output.choices) || parsed.output.choices.length === 0) return undefined;

  const choices: GameChoice[] = [];
  for (const choice of parsed.output.choices) {
    if (choices.some(existing => existing.id === choice.id)) continue;
    choices.push({ id: choice.id, say: choice.say });
  }
  if (choices.length === 0) return undefined;

  return {
    ask: parsed.output.ask,
    prompt: parsed.output.prompt,
    rules: parsed.output.rules,
    choices,
  };
};

const chatIdOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const stringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map(item => item.trim());
};

const rememberBounded = <T>(map: Map<string, T>, key: string, value: T, maxEntries: number): void => {
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
};

const bodyDigest = (rawBody: Buffer): string => createHash('sha256').update(rawBody).digest('hex').slice(0, 16);

export const createTavernProtocolHandler = (
  config: TavernConfig,
  ctx: PluginContext<TavernConfig>,
  gameModules: readonly GameModule[],
): TavernProtocolHandler => {
  const logger = ctx.capabilities.log;
  const seenRequests = new Map<string, true>();
  const decisionReplies = new Map<string, GameReply>();
  const invitationReplies = new Map<string, boolean>();
  const matchRounds = new Map<string, StoredRound>();
  const matchChatIds = new Map<string, string>();
  const activeSceneMatches = new Set<string>();

  const getGameModule = (gameKey: string): GameModule | undefined =>
    gameModules.find(module => module.id === gameKey);

  const isGameEnabled = (gameKey: string): boolean => config.games?.[gameKey]?.enabled !== false;

  const resolveGame = (gameKey: string): GameModule | undefined => {
    const game = getGameModule(gameKey);
    return game && isGameEnabled(gameKey) ? game : undefined;
  };

  const isChatEnabled = (chatId: string): boolean => {
    if (ctx.isEnabledForChat) return ctx.isEnabledForChat(chatId);
    if (ctx.capabilities.isEnabledForChat) return ctx.capabilities.isEnabledForChat(chatId);
    return true;
  };

  // The dealer's seq restarts at 1 when it restarts, so it is not a monotonic
  // cursor. Only a byte-identical repeat of a request (same match, seq, method,
  // path and body) is a duplicate delivery.
  const isDuplicateRequest = (
    matchKey: string,
    seq: unknown,
    method: string,
    path: string,
    rawBody: Buffer,
  ): boolean => {
    const key = `${matchKey}|${String(seq ?? '-')}|${method.toUpperCase()}|${path.split('?')[0] ?? path}|${bodyDigest(rawBody)}`;
    if (seenRequests.has(key)) return true;
    rememberBounded(seenRequests, key, true, MAX_SEEN_REQUESTS);
    return false;
  };

  const publish = (chatId: string, text: string, wake: boolean): void => {
    void Promise.resolve(ctx.capabilities.chat.publish(chatId, { kind: 'game_event', text, wake }))
      .catch((err: unknown) => {
        logger.error('Failed to publish tavern event to chat', { chatId, error: String(err) });
      });
  };

  const enterMatchScene = (matchKey: string, chatId: string, note: string | undefined): void => {
    if (!activeSceneMatches.has(matchKey)) {
      activeSceneMatches.add(matchKey);
      ctx.capabilities.scene.enter(chatId, 'table');
    }
    if (note) ctx.capabilities.scene.note(chatId, 'table', note);
  };

  const createNote = (factory: (() => string | undefined) | undefined): string | undefined => {
    if (!factory) return undefined;
    try {
      return factory();
    } catch (err) {
      logger.error('Failed to build tavern scene note', { error: String(err) });
      return undefined;
    }
  };

  const pruneOldRounds = (): void => {
    const now = Date.now();
    for (const [key, stored] of matchRounds.entries()) {
      if (now - stored.receivedAt > ROUND_RETENTION_MS) {
        matchRounds.delete(key);
      }
    }
    while (matchRounds.size > MAX_STORED_ROUNDS) {
      const oldest = matchRounds.keys().next().value;
      if (oldest === undefined) break;
      matchRounds.delete(oldest);
    }
  };

  const clearMatch = (matchKey: string, chatId: string | undefined): void => {
    matchRounds.delete(matchKey);
    matchChatIds.delete(matchKey);
    activeSceneMatches.delete(matchKey);
    invitationReplies.delete(matchKey);
    for (const key of decisionReplies.keys()) {
      if (key.startsWith(`${matchKey}:`)) decisionReplies.delete(key);
    }
    if (chatId) ctx.capabilities.scene.exit(chatId, 'table');
  };

  const handleInvitation = async (req: HttpRequest, gameKey: string): Promise<HttpResponse> => {
    const auth = verifyTavernAuth(req, config.secret);
    if (!auth.ok) return { status: auth.status, body: { error: auth.error } };

    const parsed = v.safeParse(InvitationRequestSchema, req.body);
    if (!parsed.success) {
      return { status: 400, body: { error: 'Invalid invitation request body schema' } };
    }

    const body = parsed.output;
    const game = resolveGame(gameKey);
    if (!game) {
      logger.warn('Tavern invitation rejected: game not supported or disabled', { game: gameKey });
      return { status: 200, body: { accept: false } };
    }

    const chatId = chatIdOf(body.chat_id);
    if (!chatId) {
      logger.warn('Tavern invitation rejected: missing chat_id', { game: gameKey });
      return { status: 200, body: { accept: false } };
    }
    if (!isChatEnabled(chatId)) {
      logger.warn('Tavern invitation rejected: tavern not enabled for chat', { chatId, game: gameKey });
      return { status: 200, body: { accept: false } };
    }

    const mode = typeof body.mode === 'string' && body.mode.trim().length > 0 ? body.mode.trim() : undefined;
    const allowedModes = config.games?.[gameKey]?.modes;
    if (mode && allowedModes && !allowedModes.includes(mode)) {
      logger.log('Tavern invitation declined: mode not accepted by config', { chatId, game: gameKey, mode });
      return { status: 200, body: { accept: false } };
    }

    const matchKey = typeof body.match_id === 'string' && body.match_id.length > 0
      ? `${gameKey}:${body.match_id}`
      : undefined;
    const cached = matchKey ? invitationReplies.get(matchKey) : undefined;
    if (cached !== undefined) {
      return { status: 200, body: { accept: cached } };
    }

    const humans = stringList(body.humans);
    const bots = stringList(body.bots);
    const seatsLeft = typeof body.seats_left === 'number' ? body.seats_left : undefined;
    const rules = typeof body.rules === 'string' ? body.rules : undefined;

    const invitationConf = {
      decide: config.invitation?.decide ?? 'always',
      timeoutMs: config.invitation?.timeoutMs ?? 8000,
      onTimeout: config.invitation?.onTimeout ?? 'accept',
    };

    const startMs = Date.now();
    let accept = true;
    let source: 'ask' | 'fallback' | 'always' = 'always';

    if (invitationConf.decide === 'ask') {
      source = 'ask';
      const question = buildTavernInvitationQuestion({
        gameName: game.displayName,
        mode,
        seatsLeft,
        humans,
        bots,
        rules,
      });

      try {
        const result = await ctx.capabilities.ask(chatId, {
          question,
          choices: ['接受', '拒绝'],
          timeoutMs: invitationConf.timeoutMs,
        });
        accept = result.choice === '接受';
      } catch (err) {
        source = 'fallback';
        accept = invitationConf.onTimeout === 'accept';
        logger.warn('Tavern invitation decision failed or timed out, executing fallback', {
          chatId,
          game: gameKey,
          error: err instanceof Error ? err.message : String(err),
          fallback: invitationConf.onTimeout,
        });
      }
    }

    if (matchKey) rememberBounded(invitationReplies, matchKey, accept, MAX_CACHED_INVITATIONS);

    const publicInput = { gameName: game.displayName, mode, seatsLeft, humans, bots, rules };
    publish(chatId, buildTavernInvitationPublicText({ ...publicInput, accept }), true);

    logger.log('Tavern invitation decision completed', {
      chatId,
      game: gameKey,
      mode,
      source,
      latencyMs: Date.now() - startMs,
      accept,
    });

    return { status: 200, body: { accept } };
  };

  const handleRoundStart = async (
    req: HttpRequest,
    gameKey: string,
    matchId: string,
    round: string,
  ): Promise<HttpResponse> => {
    const auth = verifyTavernAuth(req, config.secret);
    if (!auth.ok) return { status: auth.status, body: { error: auth.error } };

    const parsed = v.safeParse(RoundStartRequestSchema, req.body);
    if (!parsed.success) {
      return { status: 400, body: { error: 'Invalid round_start request body schema' } };
    }

    const game = resolveGame(gameKey);
    if (!game) {
      return { status: 404, body: { error: `Game ${gameKey} not found or disabled` } };
    }

    const body = parsed.output;
    const matchKey = `${gameKey}:${matchId}`;
    if (isDuplicateRequest(matchKey, body.seq, req.method, req.path, req.rawBody)) {
      logger.debug('Duplicate tavern round_start ignored', { game: gameKey, matchId, seq: body.seq });
      return { status: 200, body: {} };
    }

    // Store private round info in memory; NEVER publish it to the chat.
    pruneOldRounds();
    matchRounds.set(matchKey, {
      round: Number.parseInt(round, 10) || 1,
      data: req.body,
      receivedAt: Date.now(),
    });

    const chatId = chatIdOf(body.chat_id);
    if (chatId) {
      matchChatIds.set(matchKey, chatId);
      enterMatchScene(
        matchKey,
        chatId,
        createNote(game.createRoundNote ? () => game.createRoundNote?.(req.body) : undefined),
      );
    }

    return { status: 200, body: {} };
  };

  const handleDecision = async (
    req: HttpRequest,
    gameKey: string,
    matchId: string,
    turnIdStr: string,
  ): Promise<HttpResponse> => {
    const auth = verifyTavernAuth(req, config.secret);
    if (!auth.ok) return { status: auth.status, body: { error: auth.error } };

    const parsed = v.safeParse(DecisionRequestSchema, req.body);
    if (!parsed.success) {
      return { status: 400, body: { error: 'Invalid decision request body schema' } };
    }

    const game = resolveGame(gameKey);
    if (!game) {
      return { status: 404, body: { error: `Game ${gameKey} not found or disabled` } };
    }

    const turnId = Number.parseInt(turnIdStr, 10);
    if (!Number.isInteger(turnId) || turnId < 0) {
      return { status: 400, body: { error: 'Invalid turn_id parameter' } };
    }

    const body = parsed.output;
    const matchKey = `${gameKey}:${matchId}`;
    // Several requests of one round can share a turn_id (protocol §公共字段),
    // so only a redelivery of the same request (same seq, or the same bytes
    // when seq is missing) may reuse a reply.
    const decisionKey = `${matchKey}:${turnId}:${typeof body.seq === 'number' ? body.seq : bodyDigest(req.rawBody)}`;
    const cached = decisionReplies.get(decisionKey);
    if (cached) {
      logger.log('Duplicate tavern decision returned from cache', { game: gameKey, matchId, turnId });
      return { status: 200, body: { ...cached } };
    }

    const configuredTimeoutMs = config.decisionTimeoutMs ?? 40000;
    const budgetMs = computeDecisionBudgetMs(configuredTimeoutMs, body.deadline_ms);
    const chatId = chatIdOf(body.chat_id) ?? matchChatIds.get(matchKey);
    const choiceFields = parseChoiceFields(req.body);
    const deps: GameDecideDeps = {
      callModel: (prompt, options) =>
        ctx.capabilities.callModel(config.model ?? 'probe', prompt, {
          timeoutSec: options?.timeoutSec ?? Math.max(1, Math.floor(budgetMs / 1000)),
          dumpId: chatId ? `${chatId}.game` : undefined,
        }),
      log: logger,
      remainingMs: budgetMs,
    };

    const startMs = Date.now();
    let reply: GameReply;
    let source: 'model' | 'fallback' = 'fallback';

    try {
      if (choiceFields) {
        const ids = choiceFields.choices.map(choice => choice.id);
        let state: string | undefined;
        try {
          state = game.describeState(req.body);
        } catch (err) {
          logger.warn('Game failed to describe private state for a choice decision', {
            game: gameKey,
            error: String(err),
          });
        }
        const prompt = buildTavernChoicePrompt(choiceFields, state);
        const raw = await withTimeout(
          deps.callModel(prompt, { timeoutSec: Math.max(1, Math.floor(budgetMs / 1000)) }),
          budgetMs,
        );
        const choice = parseChoiceResponse(raw, ids);
        if (!choice) {
          throw new Error(`Model returned no valid choice id: ${raw.slice(0, 200)}`);
        }
        reply = { turn_id: turnId, choice };
      } else {
        const legacyReply = await withTimeout(game.decideAction(req.body, deps), budgetMs);
        if (!game.validate(req.body, legacyReply)) {
          throw new Error('Model produced invalid action for table state');
        }
        reply = legacyReply;
      }
      source = 'model';
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      const errCause = err instanceof Error && err.cause ? String(err.cause) : undefined;
      logger.warn('Game decision failed or timed out, executing fallback', {
        game: gameKey,
        matchId,
        turnId,
        error: errMessage,
        cause: errCause,
      });

      if (choiceFields) {
        reply = { turn_id: turnId, choice: chooseFallbackChoice(game, req.body, choiceFields.choices) };
      } else {
        reply = game.fallback(req.body);
      }
    }

    // The path turn_id is authoritative; never reject a reply for a lower turn_id.
    reply = { ...reply, turn_id: turnId } as GameReply;
    rememberBounded(decisionReplies, decisionKey, reply, MAX_CACHED_DECISIONS);

    const latencyMs = Date.now() - startMs;
    logger.log('Game decision completed', {
      game: gameKey,
      matchId,
      turnId,
      source,
      latencyMs,
      budgetMs,
      deadlineMs: body.deadline_ms,
      choice: 'choice' in reply ? reply.choice : undefined,
      action: 'action' in reply ? reply.action : undefined,
    });

    if (chatId) {
      if (!matchChatIds.has(matchKey)) matchChatIds.set(matchKey, chatId);
      enterMatchScene(
        matchKey,
        chatId,
        createNote(game.createDecisionNote ? () => game.createDecisionNote?.(req.body, reply) : undefined),
      );
    }

    return { status: 200, body: { ...reply } };
  };

  const handleEvent = async (req: HttpRequest, gameKey: string, matchId: string): Promise<HttpResponse> => {
    const auth = verifyTavernAuth(req, config.secret);
    if (!auth.ok) return { status: auth.status, body: { error: auth.error } };

    const parsed = v.safeParse(EventRequestSchema, req.body);
    if (!parsed.success) {
      return { status: 400, body: { error: 'Invalid event request body schema' } };
    }

    const game = resolveGame(gameKey);
    if (!game) {
      return { status: 404, body: { error: `Game ${gameKey} not found or disabled` } };
    }

    const body = parsed.output;
    const matchKey = `${gameKey}:${matchId}`;
    if (isDuplicateRequest(matchKey, body.seq, req.method, req.path, req.rawBody)) {
      logger.debug('Duplicate tavern event ignored, skipping chat publish', {
        game: gameKey,
        matchId,
        seq: body.seq,
      });
      return { status: 200, body: {} };
    }

    const chatId = chatIdOf(body.chat_id) ?? matchChatIds.get(matchKey);
    if (chatId) {
      matchChatIds.set(matchKey, chatId);
      try {
        const stored = matchRounds.get(matchKey)?.data;
        const storedTarget = stored && typeof stored === 'object'
          ? (stored as Record<string, unknown>).target
          : undefined;
        const eventBody = req.body as Record<string, unknown>;
        const eventWithContext = storedTarget !== undefined && eventBody.target === undefined
          ? { ...eventBody, target: storedTarget }
          : req.body;

        const text = game.describeEvent(eventWithContext);
        if (text) {
          publish(chatId, text, game.wakesBot(req.body));
          if (!activeSceneMatches.has(matchKey)) {
            activeSceneMatches.add(matchKey);
            ctx.capabilities.scene.enter(chatId, 'table');
          }
        }
      } catch (err) {
        logger.error('Failed to describe or publish tavern event', { game: gameKey, matchId, error: String(err) });
      }
    }

    if (game.isGameEnd(req.body)) {
      clearMatch(matchKey, chatId);
    }

    return { status: 200, body: {} };
  };

  return {
    handleInvitation,
    handleRoundStart,
    handleDecision,
    handleEvent,
  };
};

const chooseFallbackChoice = (game: GameModule, body: unknown, choices: readonly GameChoice[]): string => {
  const ids = choices.map(choice => choice.id);
  try {
    const id = game.fallbackChoice(body);
    if (typeof id === 'string' && ids.includes(id)) return id;
  } catch {
    // Fall through to a uniformly random valid choice.
  }
  return randomChoiceId(ids);
};
