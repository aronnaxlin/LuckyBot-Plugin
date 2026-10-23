import { createHmac, timingSafeEqual } from 'node:crypto';

import * as v from 'valibot';

import type { TavernConfig } from './types';
import type { GameAction, GameModule } from '../games/types';
import type { HttpRequest, HttpResponse, PluginContext } from '../sdk/types';

const MAX_STORED_ROUNDS = 50;
const ROUND_RETENTION_MS = 2 * 60 * 60 * 1000; // 2 hours

const InvitationRequestSchema = v.objectWithRest({
  protocol: v.optional(v.number()),
  seq: v.optional(v.number()),
  game: v.optional(v.string()),
  match_id: v.optional(v.string()),
  chat_id: v.optional(v.string()),
  humans: v.optional(v.array(v.string())),
}, v.unknown());

const RoundStartRequestSchema = v.objectWithRest({
  protocol: v.optional(v.number()),
  seq: v.optional(v.number()),
  game: v.optional(v.string()),
  match_id: v.optional(v.string()),
  chat_id: v.optional(v.string()),
  turn_id: v.optional(v.number()),
  round: v.optional(v.union([v.number(), v.string()])),
}, v.unknown());

const DecisionRequestSchema = v.objectWithRest({
  protocol: v.optional(v.number()),
  seq: v.optional(v.number()),
  game: v.optional(v.string()),
  match_id: v.optional(v.string()),
  chat_id: v.optional(v.string()),
  turn_id: v.optional(v.number()),
}, v.unknown());

const EventRequestSchema = v.objectWithRest({
  protocol: v.optional(v.number()),
  seq: v.optional(v.number()),
  game: v.optional(v.string()),
  match_id: v.optional(v.string()),
  chat_id: v.optional(v.string()),
  turn_id: v.optional(v.number()),
  event: v.string('event field is required'),
}, v.unknown());

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

  const ts = parseInt(tsStr, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Number.isNaN(ts) || Math.abs(now - ts) > 300) {
    return { ok: false, status: 401, error: 'Timestamp expired or invalid' };
  }

  // Base string per OpenAPI v1: timestamp.METHOD.path.rawBody
  const method = req.method.toUpperCase();
  const rawBodyStr = req.rawBody.toString('utf-8');
  const baseString = `${tsStr}.${method}.${req.path}.${rawBodyStr}`;

  const expectedHex = createHmac('sha256', secret).update(baseString).digest('hex');
  const expectedSig = `sha256=${expectedHex}`;

  const sigBuf = Buffer.from(sigStr, 'utf-8');
  const expBuf = Buffer.from(expectedSig, 'utf-8');

  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, status: 401, error: 'Invalid tavern signature' };
  }

  return { ok: true, timestamp: ts };
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

export const createTavernProtocolHandler = (
  config: TavernConfig,
  ctx: PluginContext<TavernConfig>,
  gameModules: readonly GameModule[],
): TavernProtocolHandler => {
  const matchSeqs = new Map<string, number>();
  const matchRounds = new Map<string, StoredRound>();
  const matchChatIds = new Map<string, string>();
  const activeSceneMatches = new Set<string>();

  const getGameModule = (gameKey: string): GameModule | undefined =>
    gameModules.find(m => m.id === gameKey);

  const isGameEnabled = (gameKey: string): boolean => {
    const gameConf = config.games?.[gameKey];
    return gameConf?.enabled !== false;
  };

  const checkSeq = (matchKey: string, seq: unknown): boolean => {
    if (typeof seq !== 'number') return true;
    const lastSeq = matchSeqs.get(matchKey) ?? 0;
    if (seq === 1) {
      matchSeqs.set(matchKey, 1);
      return true;
    }
    if (seq <= lastSeq) {
      ctx.capabilities.log.warn('Out of order or duplicate tavern seq received', { matchKey, seq, lastSeq });
      return false;
    }
    matchSeqs.set(matchKey, seq);
    return true;
  };

  const pruneOldRounds = (): void => {
    const now = Date.now();
    for (const [key, stored] of matchRounds.entries()) {
      if (now - stored.receivedAt > ROUND_RETENTION_MS) {
        matchRounds.delete(key);
      }
    }
    if (matchRounds.size > MAX_STORED_ROUNDS) {
      const sorted = [...matchRounds.entries()].sort((a, b) => a[1].receivedAt - b[1].receivedAt);
      const toRemove = sorted.slice(0, matchRounds.size - MAX_STORED_ROUNDS);
      for (const [key] of toRemove) {
        matchRounds.delete(key);
      }
    }
  };

  const handleInvitation = async (req: HttpRequest, gameKey: string): Promise<HttpResponse> => {
    const auth = verifyTavernAuth(req, config.secret);
    if (!auth.ok) return { status: auth.status, body: { error: auth.error } };

    const parsed = v.safeParse(InvitationRequestSchema, req.body);
    if (!parsed.success) {
      return { status: 400, body: { error: 'Invalid invitation request body schema' } };
    }

    const body = parsed.output;
    const matchKey = `${gameKey}:${body.match_id ?? 'global'}`;
    checkSeq(matchKey, body.seq);

    const game = getGameModule(gameKey);
    const enabled = Boolean(game && isGameEnabled(gameKey));

    if (!enabled) {
      return { status: 200, body: { accept: false } };
    }

    const chatId = typeof body.chat_id === 'string' && body.chat_id.trim() ? body.chat_id.trim() : undefined;
    if (!chatId) {
      ctx.capabilities.log.warn('Tavern invitation rejected: missing chat_id', { game: gameKey });
      return { status: 200, body: { accept: false } };
    }

    const isChatEnabled = ctx.isEnabledForChat
      ? ctx.isEnabledForChat(chatId)
      : ctx.capabilities.isEnabledForChat
        ? ctx.capabilities.isEnabledForChat(chatId)
        : true;

    if (!isChatEnabled) {
      ctx.capabilities.log.warn('Tavern invitation rejected: tavern not enabled for chat', { chatId, game: gameKey });
      return { status: 200, body: { accept: false } };
    }

    const invitationConf = config.invitation ?? {
      decide: 'always',
      timeoutMs: 8000,
      onTimeout: 'accept',
    };

    const humans = Array.isArray(body.humans)
      ? (body.humans as unknown[]).filter((h): h is string => typeof h === 'string' && h.trim().length > 0)
      : [];

    const gameNames: Record<string, string> = {
      liars_bar: '骗子酒馆',
    };
    const gameName = gameNames[gameKey] ?? gameKey;

    let accept = false;
    let source: 'ask' | 'fallback' | 'always' = 'always';
    const startMs = Date.now();

    if (invitationConf.decide === 'ask') {
      source = 'ask';
      const humanDesc = humans.length > 0
        ? `当前有 ${humans.length} 位玩家（${humans.join('、')}）在等待`
        : '当前有玩家在等待';
      const question = `荷官邀请你加入游戏【${gameName}】凑齐一桌，${humanDesc}，让你填补一个空位。你要接受上桌邀请还是拒绝？`;

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
        ctx.capabilities.log.warn('Tavern invitation decision failed or timed out, executing fallback', {
          chatId,
          game: gameKey,
          error: err instanceof Error ? err.message : String(err),
          fallback: invitationConf.onTimeout,
        });
      }
    } else {
      accept = true;
    }

    const latencyMs = Date.now() - startMs;
    ctx.capabilities.log.log('Tavern invitation decision completed', {
      chatId,
      game: gameKey,
      source,
      latencyMs,
      accept,
    });

    const waitingDesc = humans.length > 0 ? `，等你的有 ${humans.join('、')}` : '';
    const publicText = `荷官邀请你上桌（${gameName}${waitingDesc}）。${accept ? '你接受了。' : '你拒绝了。'}`;

    void ctx.capabilities.chat.publish(chatId, {
      kind: 'game_event',
      text: publicText,
      wake: true,
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

    const body = parsed.output;
    const matchKey = `${gameKey}:${matchId}`;
    checkSeq(matchKey, body.seq);

    const game = getGameModule(gameKey);
    if (!game || !isGameEnabled(gameKey)) {
      return { status: 404, body: { error: `Game ${gameKey} not found or disabled` } };
    }

    // Store private round info in memory; NEVER publish to chat
    pruneOldRounds();
    matchRounds.set(matchKey, {
      round: parseInt(round, 10),
      data: req.body,
      receivedAt: Date.now(),
    });

    const chatId = typeof body.chat_id === 'string' ? body.chat_id : undefined;
    if (chatId) {
      matchChatIds.set(matchKey, chatId);
      if (!activeSceneMatches.has(matchKey)) {
        activeSceneMatches.add(matchKey);
        ctx.capabilities.scene.enter(chatId, 'table');
      }
      if (game.createRoundNote) {
        const note = game.createRoundNote(req.body);
        if (note) {
          ctx.capabilities.scene.note(chatId, 'table', note);
        }
      }
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

    const body = parsed.output;
    const matchKey = `${gameKey}:${matchId}`;
    checkSeq(matchKey, body.seq);

    const turnId = parseInt(turnIdStr, 10);
    if (Number.isNaN(turnId)) {
      return { status: 400, body: { error: 'Invalid turn_id parameter' } };
    }

    const game = getGameModule(gameKey);
    if (!game || !isGameEnabled(gameKey)) {
      return { status: 404, body: { error: `Game ${gameKey} not found or disabled` } };
    }

    const decisionTimeoutMs = config.decisionTimeoutMs ?? 10000;
    const rawDeadlineMs = typeof (req.body as Record<string, unknown>)?.deadline_ms === 'number'
      ? ((req.body as Record<string, unknown>).deadline_ms as number)
      : decisionTimeoutMs;
    const budgetMs = Math.min(decisionTimeoutMs, Math.max(1000, rawDeadlineMs - 2000));

    const startMs = Date.now();
    let action: GameAction;
    let source: 'model' | 'fallback' = 'fallback';

    try {
      const modelName = config.model ?? 'probe';
      action = await withTimeout(
        game.decide(req.body, {
          callModel: (prompt, opts) =>
            ctx.capabilities.callModel(modelName, prompt, {
              timeoutSec: opts?.timeoutSec ?? Math.max(1, Math.floor(budgetMs / 1000)),
              dumpId: typeof body.chat_id === 'string' ? `${body.chat_id}.game` : undefined,
            }),
          log: ctx.capabilities.log,
          remainingMs: budgetMs,
        }),
        budgetMs,
      );

      if (!game.validate(req.body, action)) {
        throw new Error('Model produced invalid action for table state');
      }
      source = 'model';
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      const errCause = err instanceof Error && err.cause ? String(err.cause) : undefined;
      ctx.capabilities.log.warn('Game decision failed or timed out, executing fallback', {
        game: gameKey,
        matchId,
        turnId,
        error: errMessage,
        cause: errCause,
      });
      action = game.fallback(req.body);
    }

    const latencyMs = Date.now() - startMs;
    ctx.capabilities.log.log('Game decision completed', {
      game: gameKey,
      matchId,
      turnId,
      source,
      latencyMs,
      action: action.action,
    });

    const chatId = typeof body.chat_id === 'string' ? body.chat_id : matchChatIds.get(matchKey);
    if (chatId) {
      if (!activeSceneMatches.has(matchKey)) {
        activeSceneMatches.add(matchKey);
        ctx.capabilities.scene.enter(chatId, 'table');
      }
      if (game.createDecisionNote) {
        const note = game.createDecisionNote(req.body, action);
        if (note) {
          ctx.capabilities.scene.note(chatId, 'table', note);
        }
      }
    }

    return {
      status: 200,
      body: {
        turn_id: turnId,
        ...action,
      },
    };
  };

  const handleEvent = async (req: HttpRequest, gameKey: string, matchId: string): Promise<HttpResponse> => {
    const auth = verifyTavernAuth(req, config.secret);
    if (!auth.ok) return { status: auth.status, body: { error: auth.error } };

    const parsed = v.safeParse(EventRequestSchema, req.body);
    if (!parsed.success) {
      return { status: 400, body: { error: 'Invalid event request body schema' } };
    }

    const body = parsed.output;
    const matchKey = `${gameKey}:${matchId}`;
    const isNewSeq = checkSeq(matchKey, body.seq);

    const game = getGameModule(gameKey);
    if (!game || !isGameEnabled(gameKey)) {
      return { status: 404, body: { error: `Game ${gameKey} not found or disabled` } };
    }

    // If duplicate or out-of-order seq, still return 200 immediately, but do NOT publish to chat
    if (!isNewSeq) {
      ctx.capabilities.log.warn('Duplicate event delivery ignored, skipping chat publish', {
        game: gameKey,
        matchId,
        seq: body.seq,
      });
      return { status: 200, body: {} };
    }

    const chatId = typeof body.chat_id === 'string' ? body.chat_id : undefined;
    if (chatId) {
      matchChatIds.set(matchKey, chatId);
      try {
        const stored = matchRounds.get(matchKey);
        const storedTarget = (stored?.data as Record<string, unknown> | undefined)?.target;
        const eventWithContext = storedTarget && !(req.body as Record<string, unknown>).target
          ? { ...(req.body as Record<string, unknown>), target: storedTarget }
          : req.body;
        const text = game.describeEvent(eventWithContext);
        if (text) {
          const wake = game.wakesBot(req.body);
          void ctx.capabilities.chat.publish(chatId, {
            kind: 'game_event',
            text,
            wake,
          });
          if (!activeSceneMatches.has(matchKey)) {
            activeSceneMatches.add(matchKey);
            ctx.capabilities.scene.enter(chatId, 'table');
          }
        }
      } catch (err) {
        ctx.capabilities.log.error('Failed to describe or publish tavern event', { error: err });
      }
    }

    if (game.isGameEnd(req.body)) {
      matchRounds.delete(matchKey);
      matchSeqs.delete(matchKey);
      activeSceneMatches.delete(matchKey);
      const targetChatId = chatId ?? matchChatIds.get(matchKey);
      if (targetChatId) {
        ctx.capabilities.scene.exit(targetChatId, 'table');
      }
      matchChatIds.delete(matchKey);
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
