import { createHmac, timingSafeEqual } from 'node:crypto';

import * as v from 'valibot';

import type { GameAction, GameModule } from '../games/types';
import type { HttpRequest, HttpResponse, PluginContext } from '../sdk/types';
import type { TavernConfig } from './types';

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
    return { status: 200, body: { accept: true } };
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
      try {
        const text = game.describeEvent(req.body);
        if (text) {
          const wake = game.wakesBot(req.body);
          void ctx.capabilities.chat.publish(chatId, {
            kind: 'game_event',
            text,
            wake,
          });
        }
      } catch (err) {
        ctx.capabilities.log.error('Failed to describe or publish tavern event', { error: err });
      }
    }

    if (game.isGameEnd(req.body)) {
      matchRounds.delete(matchKey);
      matchSeqs.delete(matchKey);
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
