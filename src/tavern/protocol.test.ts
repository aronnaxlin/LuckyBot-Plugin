import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { tavernPlugin } from './index';
import { buildTavernChoicePrompt, computeDecisionBudgetMs, createTavernProtocolHandler, verifyTavernAuth } from './protocol';
import { TavernConfigSchema, type TavernConfig } from './types';
import { bulletPokerModule } from '../games/bullet-poker';
import { liarsBarModule } from '../games/liars-bar';
import type { ChatPublishOptions, HttpRequest, HttpRoute, PluginCapabilities, PluginContext, PluginLogger } from '../sdk/types';

const SECRET = '{{SECRET_a3x3429z}}';

const makeConfig = (overrides: Partial<TavernConfig> = {}): TavernConfig => ({
  enabled: true,
  secret: SECRET,
  model: 'probe',
  decisionTimeoutMs: 40000,
  basePath: '',
  tableName: 'LuckyBot',
  games: {
    liars_bar: { enabled: true },
    bullet_poker: { enabled: true },
  },
  ...overrides,
});

const createMockContext = (configOverrides: Partial<TavernConfig> = {}) => {
  const published: { chatId: string; options: ChatPublishOptions }[] = [];
  const notes: string[] = [];
  const logCalls: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const routes: HttpRoute[] = [];

  const log: PluginLogger = {
    log: (msg, fields) => logCalls.push({ level: 'log', msg, fields }),
    warn: (msg, fields) => logCalls.push({ level: 'warn', msg, fields }),
    error: (msg, fields) => logCalls.push({ level: 'error', msg, fields }),
    debug: (msg, fields) => logCalls.push({ level: 'debug', msg, fields }),
    withFields: () => log,
    withError: () => log,
  };

  const callModel = vi.fn(async (
    _model: string,
    _prompt: string,
    _options?: { timeoutSec?: number; dumpId?: string },
  ): Promise<string> => '{"choice":"play:2"}');
  const ask = vi.fn(async (
    _chatId: string,
    _options: { question: string; choices: string[]; timeoutMs?: number },
  ): Promise<{ choice: string; reason?: string }> => ({ choice: '接受' }));

  const capabilities: PluginCapabilities = {
    callModel,
    ask,
    isEnabledForChat: vi.fn(() => true),
    http: {
      route: vi.fn((route: HttpRoute) => {
        routes.push(route);
      }),
    },
    chat: {
      publish: vi.fn(async (chatId: string, options: ChatPublishOptions) => {
        published.push({ chatId, options });
      }),
    },
    scene: {
      enter: vi.fn(),
      exit: vi.fn(),
      note: vi.fn((_chatId: string, _sceneId: string, text: string | null) => {
        if (typeof text === 'string') notes.push(text);
      }),
    },
    storage: { rootDir: '/tmp/test-storage' },
    log,
    media: {
      send: vi.fn(async () => {
        throw new Error('media.send unsupported');
      }),
    },
  };

  const config = makeConfig(configOverrides);
  const ctx: PluginContext<TavernConfig> = { config, capabilities };

  return { ctx, config, capabilities, published, notes, logCalls, routes, callModel, ask };
};

interface SignOptions {
  secret?: string;
  ts?: number;
  rawBody?: Buffer;
  signPath?: string;
}

const signRequest = (
  method: string,
  path: string,
  bodyObj: unknown,
  options: SignOptions = {},
): HttpRequest => {
  const rawBody = options.rawBody ?? Buffer.from(JSON.stringify(bodyObj), 'utf-8');
  const signPath = options.signPath ?? path.split('?')[0] ?? path;
  const ts = options.ts ?? Math.floor(Date.now() / 1000);
  const hex = createHmac('sha256', options.secret ?? SECRET)
    .update(`${ts}.${method.toUpperCase()}.${signPath}.`)
    .update(rawBody)
    .digest('hex');

  return {
    method,
    path,
    headers: {
      'x-tavern-timestamp': String(ts),
      'x-tavern-signature': `sha256=${hex}`,
    },
    rawBody,
    body: bodyObj,
  };
};

const handlersOf = (configOverrides: Partial<TavernConfig> = {}) => {
  const mock = createMockContext(configOverrides);
  const handler = createTavernProtocolHandler(mock.ctx.config, mock.ctx, [liarsBarModule, bulletPokerModule]);
  return { ...mock, handler };
};

const legacyDecisionBody = (
  overrides: Record<string, unknown> = {},
  keepAsk = false,
): Record<string, unknown> => {
  const body = choiceDecisionBody(overrides);
  delete body.choices;
  delete body.prompt;
  delete body.rules;
  if (!keepAsk) delete body.ask;
  return body;
};

const choiceDecisionBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  protocol: 1,
  seq: 20,
  game: 'liars_bar',
  match_id: 'm_choice',
  chat_id: 'oc_example',
  turn_id: 37,
  you: { seat: 2, name: 'Carol' },
  round: 3,
  target: 'K',
  hand: [{ slot: 2, card: 'K' }, { slot: 3, card: 'JOKER' }, { slot: 4, card: 'A' }],
  can_challenge: true,
  must_challenge: false,
  last_play: { seat: 1, name: 'Bob', count: 2 },
  pile: 3,
  players: [
    { seat: 0, name: 'Alice', alive: true, cards_left: 4, shots_fired: 1, is_bot: false },
    { seat: 1, name: 'Bob', alive: true, cards_left: 2, shots_fired: 4, is_bot: true },
    { seat: 2, name: 'Carol', alive: true, cards_left: 3, shots_fired: 2, is_bot: true },
  ],
  deadline_ms: 58000,
  ask: 'move',
  prompt: '轮到你：扣着出 1 到 3 张牌，声称都是目标牌 K，或者质疑上家',
  rules: '这是本局的规则文本',
  choices: [
    { id: 'play:2', say: '出 K（2 号位），声称都是 K' },
    { id: 'play:2,3', say: '出 K、Joker（2、3 号位），声称都是 K' },
    { id: 'challenge', say: '质疑 Bob 刚出的 2 张' },
  ],
  ...overrides,
});

const bulletDecisionBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  protocol: 1,
  seq: 30,
  game: 'bullet_poker',
  match_id: 'bp1',
  chat_id: 'oc_example',
  turn_id: 10,
  you: { seat: 2, name: 'Carol' },
  hand_no: 1,
  round: 1,
  board: [],
  hole: ['As', '7d'],
  bet: 1,
  folds_left: 3,
  swapped: false,
  options: { raise: true, fold: true, swap: true, allin: false, call: false, pick: false, responding: false },
  offer: null,
  allin_by: null,
  button: 0,
  players: [
    { seat: 0, name: 'Alice', alive: true, folded: false, allin: false, bet: 1, acted: false, swapped: false, folds_left: 3, is_bot: false },
    { seat: 2, name: 'Carol', alive: true, folded: false, allin: false, bet: 1, acted: false, swapped: false, folds_left: 3, is_bot: true },
  ],
  deadline_ms: 58000,
  ...overrides,
});

const invokeDecision = async (
  handler: ReturnType<typeof handlersOf>['handler'],
  body: Record<string, unknown>,
  turnId = String(body.turn_id ?? 0),
  path?: string,
) => {
  const decisionPath = path ?? `/v1/games/${String(body.game)}/matches/${String(body.match_id)}/turns/${turnId}/decision`;
  return await handler.handleDecision(
    signRequest('POST', decisionPath, body),
    String(body.game),
    String(body.match_id),
    turnId,
  );
};

describe('Tavern signature (protocol §签名)', () => {
  it('hashes the raw body bytes instead of a UTF-8 round trip', () => {
    const rawBody = Buffer.concat([Buffer.from('{"x":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]);
    const ts = Math.floor(Date.now() / 1000);
    const path = '/v1/games/liars_bar/invitations';
    const hex = createHmac('sha256', SECRET)
      .update(`${ts}.POST.${path}.`)
      .update(rawBody)
      .digest('hex');

    const req: HttpRequest = {
      method: 'POST',
      path,
      headers: { 'x-tavern-timestamp': String(ts), 'x-tavern-signature': `sha256=${hex}` },
      rawBody,
      body: {},
    };

    expect(verifyTavernAuth(req, SECRET).ok).toBe(true);
  });

  it('signs the path including basePath and excluding the query string', async () => {
    const { ctx, handler } = handlersOf({ basePath: '/tavern' });
    const body = {
      protocol: 1,
      seq: 1,
      game: 'liars_bar',
      match_id: 'm_sig',
      chat_id: 'oc_example',
      humans: ['Alice'],
      bots: [],
      seats_left: 3,
    };
    const req = signRequest(
      'POST',
      '/tavern/v1/games/liars_bar/invitations?dealer=1',
      body,
      { signPath: '/tavern/v1/games/liars_bar/invitations' },
    );

    expect(ctx.config.basePath).toBe('/tavern');
    const res = await handler.handleInvitation(req, 'liars_bar');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accept: true });
  });

  it('registers routes under the deployment prefix and verifies them end to end', async () => {
    const { ctx, routes } = createMockContext();
    (ctx.config as TavernConfig).basePath = '/tavern';
    await tavernPlugin.setup(ctx);

    expect(routes.map(route => route.path)).toEqual([
      '/tavern/v1/games/:game/invitations',
      '/tavern/v1/games/:game/matches/:match_id/rounds/:round',
      '/tavern/v1/games/:game/matches/:match_id/turns/:turn_id/decision',
      '/tavern/v1/games/:game/matches/:match_id/events',
    ]);

    const inviteRoute = routes.find(route => route.path.endsWith('/invitations'))!;
    const body = { protocol: 1, seq: 1, game: 'liars_bar', match_id: 'm_route', chat_id: 'oc_example' };
    const req = {
      ...signRequest('POST', '/tavern/v1/games/liars_bar/invitations?x=1', body, {
        signPath: '/tavern/v1/games/liars_bar/invitations',
      }),
      params: { game: 'liars_bar' },
    };
    const res = await inviteRoute.handler(req);
    expect(res).toMatchObject({ status: 200 });
  });

  it('rejects a tampered body, path or method with 401 before processing', async () => {
    const { handler } = handlersOf();
    const body = { protocol: 1, seq: 1, game: 'liars_bar', match_id: 'm_tamper', chat_id: 'oc_example' };

    const signed = signRequest('POST', '/v1/games/liars_bar/invitations', body);
    const tamperedBody: HttpRequest = {
      ...signed,
      rawBody: Buffer.from(JSON.stringify({ ...body, match_id: 'm_other' }), 'utf-8'),
    };
    expect((await handler.handleInvitation(tamperedBody, 'liars_bar')).status).toBe(401);

    const tamperedPath: HttpRequest = { ...signed, path: '/v1/games/liars_bar/matches/x/events' };
    expect((await handler.handleInvitation(tamperedPath, 'liars_bar')).status).toBe(401);

    const tamperedMethod: HttpRequest = { ...signed, method: 'PUT' };
    expect((await handler.handleInvitation(tamperedMethod, 'liars_bar')).status).toBe(401);
  });

  it('rejects expired timestamps and wrong secrets', async () => {
    const { handler } = handlersOf();
    const body = { protocol: 1, seq: 1, game: 'liars_bar', match_id: 'm_exp', chat_id: 'oc_example' };

    const expired = signRequest('POST', '/v1/games/liars_bar/invitations', body, {
      ts: Math.floor(Date.now() / 1000) - 305,
    });
    expect((await handler.handleInvitation(expired, 'liars_bar')).status).toBe(401);

    const wrongSecret = signRequest('POST', '/v1/games/liars_bar/invitations', body, { secret: 'wrong' });
    expect((await handler.handleInvitation(wrongSecret, 'liars_bar')).status).toBe(401);
  });
});

describe('Invitations', () => {
  const inviteBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    protocol: 1,
    seq: 1,
    game: 'liars_bar',
    match_id: 'm_inv',
    chat_id: 'oc_example',
    humans: ['鹿饮'],
    bots: ['奶豆'],
    seats_left: 2,
    mode: 'devil',
    rules: '牌堆 Q、K、A 各 6 张，加了恶魔牌；恶魔牌只能单出。'.repeat(20),
    ...overrides,
  });

  it('parses the full invitation and asks with game, mode, seats, seated players and a bounded rules excerpt', async () => {
    const { handler, ask, published } = handlersOf({
      invitation: { decide: 'ask', timeoutMs: 5000, onTimeout: 'decline' },
    });

    const res = await handler.handleInvitation(
      signRequest('POST', '/v1/games/liars_bar/invitations', inviteBody()),
      'liars_bar',
    );

    expect(res).toEqual({ status: 200, body: { accept: true } });
    expect(ask).toHaveBeenCalledOnce();
    const askOptions = ask.mock.calls[0]?.[1];
    expect(askOptions).toBeDefined();
    const question = askOptions?.question ?? '';
    expect(question).toContain('骗子酒馆');
    expect(question).toContain('devil');
    expect(question).toContain('2 个空位');
    expect(question).toContain('鹿饮');
    expect(question).toContain('奶豆');
    expect(question).toContain('这一局的规则（节选）');
    expect(question).toContain('…');
    expect(question.length).toBeLessThan(600);
    expect(askOptions?.timeoutMs).toBe(5000);
    expect(askOptions?.choices).toEqual(['接受', '拒绝']);
    expect(published).toHaveLength(1);
    expect(published[0]!.options.text).toContain('骗子酒馆 · devil');
  });

  it('returns accept:false for unsupported or disabled games without asking', async () => {
    const unsupported = handlersOf();
    expect((await unsupported.handler.handleInvitation(
      signRequest('POST', '/v1/games/poker/invitations', inviteBody({ game: 'poker' })),
      'poker',
    )).body).toEqual({ accept: false });
    expect(unsupported.ask).not.toHaveBeenCalled();

    const disabled = handlersOf({ games: { liars_bar: { enabled: false } } });
    expect((await disabled.handler.handleInvitation(
      signRequest('POST', '/v1/games/liars_bar/invitations', inviteBody()),
      'liars_bar',
    )).body).toEqual({ accept: false });
    expect(disabled.ask).not.toHaveBeenCalled();
  });

  it('declines modes that the per-game config does not accept', async () => {
    const allowed = handlersOf({ games: { liars_bar: { enabled: true, modes: ['classic', 'devil'] } } });
    const chaos = await allowed.handler.handleInvitation(
      signRequest('POST', '/v1/games/liars_bar/invitations', inviteBody({ mode: 'chaos' })),
      'liars_bar',
    );
    expect(chaos.body).toEqual({ accept: false });
    expect(allowed.published).toHaveLength(0);

    const devil = await allowed.handler.handleInvitation(
      signRequest('POST', '/v1/games/liars_bar/invitations', inviteBody({ mode: 'devil', seq: 2 })),
      'liars_bar',
    );
    expect(devil.body).toEqual({ accept: true });
  });

  it('rejects invitations without chat_id or for a disabled chat', async () => {
    const missing = handlersOf();
    expect((await missing.handler.handleInvitation(
      signRequest('POST', '/v1/games/liars_bar/invitations', inviteBody({ chat_id: undefined })),
      'liars_bar',
    )).body).toEqual({ accept: false });

    const disabled = handlersOf();
    const isEnabled = disabled.capabilities.isEnabledForChat as unknown as { mockReturnValue: (value: boolean) => void };
    isEnabled.mockReturnValue(false);
    expect((await disabled.handler.handleInvitation(
      signRequest('POST', '/v1/games/liars_bar/invitations', inviteBody()),
      'liars_bar',
    )).body).toEqual({ accept: false });
  });

  it('answers a repeated invitation from cache without asking twice', async () => {
    const { handler, ask } = handlersOf({ invitation: { decide: 'ask', timeoutMs: 8000, onTimeout: 'accept' } });
    const body = inviteBody({ match_id: 'm_inv_cached' });
    await handler.handleInvitation(signRequest('POST', '/v1/games/liars_bar/invitations', body), 'liars_bar');
    const second = await handler.handleInvitation(
      signRequest('POST', '/v1/games/liars_bar/invitations', body),
      'liars_bar',
    );
    expect(second.body).toEqual({ accept: true });
    expect(ask).toHaveBeenCalledOnce();
  });
});

describe('Generic choices decision path', () => {
  it('builds the prompt from rules, prompt, private state and choices, and replies with the chosen id', async () => {
    const { handler, callModel, published, notes } = handlersOf();
    const body = choiceDecisionBody();
    const res = await invokeDecision(handler, body, '37');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ turn_id: 37, choice: 'play:2' });
    expect(Object.keys(res.body as Record<string, unknown>)).not.toContain('line');
    expect(published).toHaveLength(0);

    const prompt = callModel.mock.calls[0]?.[1] ?? '';
    expect(prompt).toContain('这是本局的规则文本');
    expect(prompt).toContain('轮到你：扣着出 1 到 3 张牌');
    expect(prompt).toContain('你的手牌: 2 号位=K');
    expect(prompt).toContain('play:2,3');
    expect(prompt).toContain('{"choice": "<id>"}');

    expect(notes.join('\n')).toContain('你这一手: 出 1 张，对外声称都是 K');
    expect(notes.join('\n')).not.toContain('JOKER');
  });

  it('falls back to the module heuristic when the model returns an invalid id', async () => {
    const { handler, callModel } = handlersOf();
    callModel.mockResolvedValueOnce('{"choice": "not-an-id"}');
    const body = choiceDecisionBody({ must_challenge: true });
    const res = await invokeDecision(handler, body, '37');
    expect(res.body).toEqual({ turn_id: 37, choice: 'challenge' });
  });

  it('falls back when the model call times out', async () => {
    vi.useFakeTimers();
    try {
      const { handler, callModel } = handlersOf({ decisionTimeoutMs: 1000 });
      callModel.mockImplementationOnce(() => new Promise<string>(() => {}));
      const body = choiceDecisionBody({ must_challenge: true });
      const pending = invokeDecision(handler, body, '37');
      await vi.advanceTimersByTimeAsync(1100);
      const res = await pending;
      expect(res.body).toEqual({ turn_id: 37, choice: 'challenge' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('replies to an aim request and falls back to the most-shot living target', async () => {
    const aimBody = (overrides: Record<string, unknown> = {}) => choiceDecisionBody({
      ask: 'aim',
      prompt: '选一个人开枪',
      aim: { kind: 'chaos', targets: [0, 1, 2] },
      choices: [
        { id: 'aim:0', say: '打 Alice' },
        { id: 'aim:1', say: '打 Bob' },
      ],
      ...overrides,
    });

    const first = handlersOf();
    first.callModel.mockResolvedValueOnce('{"choice": "aim:1"}');
    const res = await invokeDecision(first.handler, aimBody(), '38');
    expect(res.body).toEqual({ turn_id: 38, choice: 'aim:1' });
    expect(first.notes.join('\n')).toContain('你这一手: 选了 Bob 开枪');

    const fallback = handlersOf();
    fallback.callModel.mockResolvedValueOnce('garbage');
    const res2 = await invokeDecision(fallback.handler, aimBody(), '39');
    // Bob (seat 1) has more shots fired than Alice, so the fallback aims at him.
    expect(res2.body).toEqual({ turn_id: 39, choice: 'aim:1' });
  });

  it('uses the legacy per-game action path when choices are absent', async () => {
    const { handler, callModel } = handlersOf();
    callModel.mockResolvedValueOnce('{"action":"play","slots":[3]}');
    const res = await invokeDecision(handler, legacyDecisionBody(), '40');
    expect(res.body).toEqual({ turn_id: 40, action: 'play', slots: [3] });
  });

  it('uses the legacy aim reply shape when choices are absent', async () => {
    const { handler, callModel } = handlersOf();
    callModel.mockResolvedValueOnce('{"target": 0}');
    const legacy = legacyDecisionBody({ ask: 'aim', aim: { kind: 'chaos', targets: [0, 1] } }, true);
    const res = await invokeDecision(handler, legacy, '41');
    expect(res.body).toEqual({ turn_id: 41, target: 0 });
  });

  it('falls back for a legacy model error', async () => {
    const { handler, callModel } = handlersOf();
    callModel.mockRejectedValueOnce(new Error('model down'));
    const legacy = legacyDecisionBody({ must_challenge: true, can_challenge: true });
    const res = await invokeDecision(handler, legacy, '42');
    expect(res.body).toEqual({ turn_id: 42, action: 'challenge' });
  });

  it('returns a uniformly valid fallback id for an unknown request shape with choices', async () => {
    const { handler, callModel } = handlersOf();
    callModel.mockResolvedValueOnce('nope');
    const body = {
      seq: 1,
      game: 'liars_bar',
      match_id: 'm_unknown',
      turn_id: 1,
      chat_id: 'oc_example',
      choices: [
        { id: 'a', say: 'A' },
        { id: 'b', say: 'B' },
      ],
    };
    const res = await invokeDecision(handler, body, '1');
    expect(['a', 'b']).toContain((res.body as Record<string, unknown>).choice);
  });

  it('does not reject a decision because turn_id went down', async () => {
    const { handler, callModel } = handlersOf();
    const first = await invokeDecision(handler, choiceDecisionBody({ turn_id: 9, seq: 9 }), '9');
    callModel.mockResolvedValueOnce('{"choice":"challenge"}');
    const second = await invokeDecision(handler, choiceDecisionBody({ turn_id: 1, seq: 1 }), '1');
    expect(first.body).toEqual({ turn_id: 9, choice: 'play:2' });
    expect(second.body).toEqual({ turn_id: 1, choice: 'challenge' });
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it('returns the cached reply for a duplicate decision without calling the model again', async () => {
    const { handler, callModel, notes } = handlersOf();
    const body = choiceDecisionBody();
    const req = signRequest('POST', '/v1/games/liars_bar/matches/m_choice/turns/37/decision', body);

    const first = await handler.handleDecision(req, 'liars_bar', 'm_choice', '37');
    const second = await handler.handleDecision(req, 'liars_bar', 'm_choice', '37');

    expect(second).toEqual(first);
    expect(callModel).toHaveBeenCalledOnce();
    expect(notes).toHaveLength(1);
  });

  it('decides afresh for a different request that shares the turn_id', async () => {
    const { handler, callModel } = handlersOf();
    const first = await invokeDecision(handler, choiceDecisionBody({ seq: 20 }), '37');
    callModel.mockResolvedValueOnce('{"choice":"challenge"}');
    const second = await invokeDecision(handler, choiceDecisionBody({ seq: 21 }), '37');
    expect(first.body).toEqual({ turn_id: 37, choice: 'play:2' });
    expect(second.body).toEqual({ turn_id: 37, choice: 'challenge' });
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it('uses the path turn_id as authoritative', async () => {
    const { handler } = handlersOf();
    const res = await invokeDecision(handler, choiceDecisionBody({ turn_id: 7 }), '42');
    expect((res.body as Record<string, unknown>).turn_id).toBe(42);
  });

  it('returns 404 for an unknown game', async () => {
    const { handler } = handlersOf();
    const res = await invokeDecision(handler, choiceDecisionBody({ game: 'nope', match_id: 'm_x' }), '1');
    expect(res.status).toBe(404);
  });
});

describe('Decision budget', () => {
  it('computes min(config, deadline - 3000) with a 1000 ms floor', () => {
    expect(computeDecisionBudgetMs(40000, 58000)).toBe(40000);
    expect(computeDecisionBudgetMs(40000, 30000)).toBe(27000);
    expect(computeDecisionBudgetMs(40000, 25000)).toBe(22000);
    expect(computeDecisionBudgetMs(40000, 3000)).toBe(1000);
    expect(computeDecisionBudgetMs(40000, undefined)).toBe(40000);
    expect(computeDecisionBudgetMs(58000, 60000)).toBe(57000);
  });

  it('reports the applied budget', async () => {
    const { handler, logCalls } = handlersOf({ decisionTimeoutMs: 28000 });
    await invokeDecision(handler, choiceDecisionBody({ deadline_ms: 15000 }), '37');
    const completed = logCalls.find(call => call.msg === 'Game decision completed')!;
    expect(completed.fields).toMatchObject({ budgetMs: 12000, deadlineMs: 15000 });
  });
});

describe('Events', () => {
  const playEvent = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    protocol: 1,
    seq: 5,
    game: 'liars_bar',
    match_id: 'm_events',
    chat_id: 'oc_example',
    turn_id: 8,
    you: { seat: 2, name: 'Carol' },
    event: 'play',
    seat: 0,
    name: 'Alice',
    count: 2,
    cards_left: 3,
    ...overrides,
  });

  it('publishes public events to chat with the wake flag', async () => {
    const { handler, published } = handlersOf();
    const res = await handler.handleEvent(
      signRequest('POST', '/v1/games/liars_bar/matches/m_events/events', playEvent()),
      'liars_bar',
      'm_events',
    );
    expect(res).toEqual({ status: 200, body: {} });
    expect(published).toHaveLength(1);
    expect(published[0]!.options).toMatchObject({ kind: 'game_event', wake: true });
    expect(published[0]!.options.text).toContain('Alice 出了 2 张牌');
  });

  it('acknowledges a duplicate event with 200 {} and does not publish it twice', async () => {
    const { handler, published } = handlersOf();
    const req = signRequest('POST', '/v1/games/liars_bar/matches/m_events/events', playEvent({ match_id: 'm_dup' }));
    await handler.handleEvent(req, 'liars_bar', 'm_dup');
    await handler.handleEvent(req, 'liars_bar', 'm_dup');
    expect(published).toHaveLength(1);
  });

  it('does not drop a lower seq after a dealer restart', async () => {
    const { handler, published } = handlersOf();
    await handler.handleEvent(
      signRequest('POST', '/v1/games/liars_bar/matches/m_seq/events', playEvent({ match_id: 'm_seq', seq: 9 })),
      'liars_bar',
      'm_seq',
    );
    await handler.handleEvent(
      signRequest('POST', '/v1/games/liars_bar/matches/m_seq/events', playEvent({ match_id: 'm_seq', seq: 1, name: 'Bob' })),
      'liars_bar',
      'm_seq',
    );
    expect(published).toHaveLength(2);
    expect(published[1]!.options.text).toContain('Bob');
  });

  it('ignores unknown event types with 200 {} and no publication', async () => {
    const { handler, published } = handlersOf();
    const res = await handler.handleEvent(
      signRequest('POST', '/v1/games/liars_bar/matches/m_events/events', playEvent({ event: 'mystery' })),
      'liars_bar',
      'm_events',
    );
    expect(res).toEqual({ status: 200, body: {} });
    expect(published).toHaveLength(0);
  });

  it('returns 404 for rounds and events of an unknown game', async () => {
    const { handler, published } = handlersOf();
    const round = await handler.handleRoundStart(
      signRequest('PUT', '/v1/games/nope/matches/m_x/rounds/1', { protocol: 1, seq: 1, game: 'nope', match_id: 'm_x' }),
      'nope',
      'm_x',
      '1',
    );
    expect(round.status).toBe(404);

    const event = await handler.handleEvent(
      signRequest('POST', '/v1/games/nope/matches/m_x/events', { protocol: 1, seq: 2, game: 'nope', match_id: 'm_x', event: 'play' }),
      'nope',
      'm_x',
    );
    expect(event.status).toBe(404);
    expect(published).toHaveLength(0);
  });

  it('rejects an event body without an event field', async () => {
    const { handler } = handlersOf();
    const res = await handler.handleEvent(
      signRequest('POST', '/v1/games/liars_bar/matches/m_events/events', { protocol: 1, seq: 1, chat_id: 'oc_example' }),
      'liars_bar',
      'm_events',
    );
    expect(res.status).toBe(400);
  });

  it('injects the round target into a play event for the table talker', async () => {
    const { handler, published } = handlersOf();
    const roundBody = {
      protocol: 1,
      seq: 10,
      game: 'liars_bar',
      match_id: 'm_target',
      chat_id: 'oc_example',
      turn_id: 1,
      you: { seat: 2, name: 'Carol' },
      round: 1,
      target: 'K',
      hand: [{ slot: 1, card: 'Q' }],
    };
    await handler.handleRoundStart(
      signRequest('PUT', '/v1/games/liars_bar/matches/m_target/rounds/1', roundBody),
      'liars_bar',
      'm_target',
      '1',
    );
    await handler.handleEvent(
      signRequest('POST', '/v1/games/liars_bar/matches/m_target/events', playEvent({ match_id: 'm_target', seq: 11 })),
      'liars_bar',
      'm_target',
    );
    expect(published[0]!.options.text).toContain('（声称都是 K）');
  });

  it('describes demon challenges and aimed shots', async () => {
    const { handler, published } = handlersOf();
    const demon = {
      ...playEvent({ match_id: 'm_special' }),
      event: 'challenge',
      challenger: { seat: 0, name: 'Alice' },
      accused: { seat: 2, name: 'Carol' },
      revealed: ['K_devil'],
      lied: true,
      shooter: null,
      special: 'devil',
      shooters: [{ seat: 0, name: 'Alice' }],
    };
    await handler.handleEvent(
      signRequest('POST', '/v1/games/liars_bar/matches/m_special/events', demon),
      'liars_bar',
      'm_special',
    );
    expect(published[0]!.options.text).toContain('翻出恶魔牌 [K_devil]');

    const aimed = {
      ...playEvent({ match_id: 'm_special', seq: 12 }),
      event: 'shot',
      seat: 2,
      name: 'Carol',
      result: 'bang',
      shots_fired: 2,
      nth: 3,
      by: { seat: 0, name: 'Alice' },
    };
    await handler.handleEvent(
      signRequest('POST', '/v1/games/liars_bar/matches/m_special/events', aimed),
      'liars_bar',
      'm_special',
    );
    expect(published[1]!.options.text).toContain('Alice 朝 你 扣动扳机');
  });

  it('enters the table scene on the first event and exits on game_over', async () => {
    const { handler, capabilities, published } = handlersOf();
    await handler.handleEvent(
      signRequest('POST', '/v1/games/liars_bar/matches/m_scene/events', playEvent({ match_id: 'm_scene', seq: 1 })),
      'liars_bar',
      'm_scene',
    );
    expect(capabilities.scene.enter).toHaveBeenCalledWith('oc_example', 'table');
    expect(capabilities.scene.enter).toHaveBeenCalledTimes(1);

    await handler.handleEvent(
      signRequest('POST', '/v1/games/liars_bar/matches/m_scene/events', playEvent({ match_id: 'm_scene', seq: 2, name: 'Bob' })),
      'liars_bar',
      'm_scene',
    );
    expect(capabilities.scene.enter).toHaveBeenCalledTimes(1);

    await handler.handleEvent(
      signRequest('POST', '/v1/games/liars_bar/matches/m_scene/events', {
        ...playEvent({ match_id: 'm_scene', seq: 3 }),
        event: 'game_over',
        winner: { seat: 0, name: 'Alice' },
      }),
      'liars_bar',
      'm_scene',
    );
    expect(capabilities.scene.exit).toHaveBeenCalledWith('oc_example', 'table');
    expect(published[2]!.options.text).toBe('游戏结束！胜者：Alice。');
  });
});

describe('Bullet Poker through the protocol', () => {
  it('handles the swap -> pick -> normal decision flow under one table', async () => {
    const { handler, callModel } = handlersOf();
    const matchId = 'bp_flow';

    const round = await handler.handleRoundStart(
      signRequest('PUT', `/v1/games/bullet_poker/matches/${matchId}/rounds/1`, {
        protocol: 1,
        seq: 1,
        game: 'bullet_poker',
        match_id: matchId,
        chat_id: 'oc_example',
        turn_id: 0,
        you: { seat: 2, name: 'Carol' },
        round: 1,
        hand_no: 1,
        hole: ['As', '7d'],
        button: 0,
        order: [{ seat: 0, name: 'Alice', alive: true }, { seat: 2, name: 'Carol', alive: true }],
      }),
      'bullet_poker',
      matchId,
      '1',
    );
    expect(round).toEqual({ status: 200, body: {} });

    callModel.mockResolvedValueOnce('{"action":"swap","slot":1}');
    const swapped = await invokeDecision(handler, bulletDecisionBody({ match_id: matchId, turn_id: 10 }), '10');
    expect(swapped.body).toEqual({ turn_id: 10, action: 'swap', slot: 1 });

    callModel.mockResolvedValueOnce('{"action":"pick","choice":2}');
    const picked = await invokeDecision(handler, bulletDecisionBody({
      match_id: matchId,
      turn_id: 11,
      options: { raise: false, fold: false, swap: false, allin: false, call: false, pick: true, responding: false },
      offer: { slot: 1, cards: ['2c', '9h', 'Jd'] },
    }), '11');
    expect(picked.body).toEqual({ turn_id: 11, action: 'pick', choice: 2 });

    callModel.mockResolvedValueOnce('{"action":"raise"}');
    const raised = await invokeDecision(handler, bulletDecisionBody({ match_id: matchId, turn_id: 12, seq: 33 }), '12');
    expect(raised.body).toEqual({ turn_id: 12, action: 'raise' });
  });

  it('supports the generic choices path for poker', async () => {
    const { handler, callModel } = handlersOf();
    callModel.mockResolvedValueOnce('{"choice":"fold"}');
    const res = await invokeDecision(handler, bulletDecisionBody({
      turn_id: 20,
      choices: [
        { id: 'raise', say: '加注到 2 颗' },
        { id: 'fold', say: '弃牌' },
      ],
    }), '20');
    expect(res.body).toEqual({ turn_id: 20, choice: 'fold' });
  });
});

describe('Privacy invariant across scripted games', () => {
  const PRIVATE_LIARS_CARDS = ['K_devil', 'A_devil', 'CHAOS', 'MASTER'];

  it("never leaks Liar's Bar hand faces into scene notes or chat", async () => {
    const { handler, callModel, notes, published } = handlersOf();
    const matchId = 'm_privacy_lb';

    await handler.handleRoundStart(
      signRequest('PUT', `/v1/games/liars_bar/matches/${matchId}/rounds/1`, {
        protocol: 1,
        seq: 1,
        game: 'liars_bar',
        match_id: matchId,
        chat_id: 'oc_example',
        turn_id: 0,
        you: { seat: 2, name: 'Carol' },
        round: 1,
        mode: 'devil',
        target: 'K',
        devil_card: 'K_devil',
        hand: [{ slot: 1, card: 'K_devil' }, { slot: 2, card: 'CHAOS' }, { slot: 3, card: 'MASTER' }],
        order: [{ seat: 0, name: 'Alice' }, { seat: 2, name: 'Carol' }],
        first: 0,
      }),
      'liars_bar',
      matchId,
      '1',
    );

    callModel.mockResolvedValueOnce('{"action":"play","slots":[1]}');
    const legacyDecision = legacyDecisionBody({
      match_id: matchId,
      turn_id: 5,
      mode: 'devil',
      devil_card: 'K_devil',
      target: 'K',
      hand: [{ slot: 1, card: 'K_devil' }, { slot: 2, card: 'CHAOS' }, { slot: 3, card: 'MASTER' }],
    });
    await invokeDecision(handler, legacyDecision, '5');

    const challenge = {
      protocol: 1,
      seq: 3,
      game: 'liars_bar',
      match_id: matchId,
      chat_id: 'oc_example',
      turn_id: 6,
      you: { seat: 2, name: 'Carol' },
      event: 'challenge',
      challenger: { seat: 0, name: 'Alice' },
      accused: { seat: 2, name: 'Carol' },
      revealed: ['Q_devil', 'JOKER'],
      lied: true,
      shooter: null,
      special: 'devil',
      shooters: [{ seat: 0, name: 'Alice' }],
    };
    await handler.handleEvent(
      signRequest('POST', `/v1/games/liars_bar/matches/${matchId}/events`, challenge),
      'liars_bar',
      matchId,
    );

    const allNotes = notes.join('\n');
    const allPublished = published.map(entry => entry.options.text).join('\n');
    for (const card of PRIVATE_LIARS_CARDS) {
      expect(allNotes).not.toContain(card);
      expect(allPublished).not.toContain(card);
    }
    // Public reveals may be described.
    expect(allPublished).toContain('Q_devil');
    expect(allNotes).toContain('你这一手: 出 1 张');
  });

  it('never leaks Bullet Poker hole or offer cards into scene notes or chat', async () => {
    const { handler, callModel, notes, published } = handlersOf();
    const matchId = 'bp_privacy';
    const privateCards = ['As', '7d', '2c', '9h', 'Jd'];

    await handler.handleRoundStart(
      signRequest('PUT', `/v1/games/bullet_poker/matches/${matchId}/rounds/1`, {
        protocol: 1,
        seq: 1,
        game: 'bullet_poker',
        match_id: matchId,
        chat_id: 'oc_example',
        turn_id: 0,
        you: { seat: 2, name: 'Carol' },
        round: 1,
        hand_no: 1,
        hole: ['As', '7d'],
        button: 0,
        order: [{ seat: 0, name: 'Alice', alive: true }, { seat: 2, name: 'Carol', alive: true }],
      }),
      'bullet_poker',
      matchId,
      '1',
    );

    callModel.mockResolvedValueOnce('{"action":"raise"}');
    await invokeDecision(handler, bulletDecisionBody({ match_id: matchId, turn_id: 10 }), '10');

    callModel.mockResolvedValueOnce('{"action":"pick","choice":2}');
    await invokeDecision(handler, bulletDecisionBody({
      match_id: matchId,
      turn_id: 11,
      options: { raise: false, fold: false, swap: false, allin: false, call: false, pick: true, responding: false },
      offer: { slot: 1, cards: ['2c', '9h', 'Jd'] },
    }), '11');

    const events = [
      {
        event: 'street',
        round: 2,
        board: ['Kh', '7s', '9d'],
        seq: 3,
        turn_id: 12,
      },
      {
        event: 'showdown',
        board: ['Kh', '7s', '9d', 'Qc', '8h'],
        winners: [{ seat: 0, name: 'Alice' }],
        hands: [
          { seat: 0, name: 'Alice', hole: ['Qs', 'Jc'], hand: '一对' },
          { seat: 2, name: 'Carol', hole: ['Th', 'Tc'], hand: '两对' },
        ],
        seq: 4,
        turn_id: 13,
      },
      {
        event: 'fold',
        seat: 0,
        name: 'Alice',
        load: 3,
        seq: 5,
        turn_id: 14,
      },
      {
        event: 'shot',
        seat: 0,
        name: 'Alice',
        load: 3,
        result: 'click',
        seq: 6,
        turn_id: 15,
      },
      {
        event: 'game_over',
        winner: { seat: 2, name: 'Carol' },
        seq: 7,
        turn_id: 16,
      },
    ];

    for (const event of events) {
      await handler.handleEvent(
        signRequest('POST', `/v1/games/bullet_poker/matches/${matchId}/events`, {
          protocol: 1,
          game: 'bullet_poker',
          match_id: matchId,
          chat_id: 'oc_example',
          you: { seat: 2, name: 'Carol' },
          ...event,
        }),
        'bullet_poker',
        matchId,
      );
    }

    const allNotes = notes.join('\n');
    const allPublished = published.map(entry => entry.options.text).join('\n');
    for (const card of privateCards) {
      expect(allNotes).not.toContain(card);
      expect(allPublished).not.toContain(card);
    }
    expect(allNotes).toContain('你这一手: 加注');
    expect(allNotes).toContain('你这一手: 换了一张牌');
    expect(allPublished).toContain('摊牌！');
  });
});

describe('Vendored OpenAPI examples', () => {
  interface OperationLike {
    requestBody?: {
      content?: {
        'application/json'?: {
          example?: unknown;
          examples?: Record<string, { value?: unknown }>;
        };
      };
    };
  }

  const spec = JSON.parse(
    readFileSync(new URL('./openapi.json', import.meta.url), 'utf-8'),
  ) as { paths?: Record<string, Record<string, OperationLike>> };

  const requestExamples = (): { method: string; template: string; body: Record<string, unknown> }[] => {
    const found: { method: string; template: string; body: Record<string, unknown> }[] = [];
    for (const [template, operations] of Object.entries(spec.paths ?? {})) {
      for (const [method, operation] of Object.entries(operations)) {
        const content = operation.requestBody?.content?.['application/json'];
        if (!content) continue;
        if (content.example && typeof content.example === 'object') {
          found.push({ method, template, body: content.example as Record<string, unknown> });
        }
        for (const entry of Object.values(content.examples ?? {})) {
          if (entry.value && typeof entry.value === 'object') {
            found.push({ method, template, body: entry.value as Record<string, unknown> });
          }
        }
      }
    }
    return found;
  };

  it('contains request examples to exercise', () => {
    expect(requestExamples().length).toBeGreaterThanOrEqual(4);
  });

  it('runs every vendored request example through its handler with a conforming reply', async () => {
    const examples = requestExamples();
    expect(examples.length).toBeGreaterThan(0);

    for (const example of examples) {
      const { handler } = handlersOf();
      const body = example.body;
      const game = String(body.game ?? '');
      const matchId = String(body.match_id ?? 'm_example');
      const turnId = String(body.turn_id ?? 0);
      const round = String(body.round ?? 1);
      const path = example.template
        .replace('{game}', game)
        .replace('{match_id}', matchId)
        .replace('{round}', round)
        .replace('{turn_id}', turnId);
      const req = signRequest(example.method.toUpperCase(), path, body);

      if (example.template.endsWith('/invitations')) {
        const res = await handler.handleInvitation(req, game);
        expect(res.status).toBe(200);
        expect(typeof (res.body as Record<string, unknown>).accept).toBe('boolean');
        continue;
      }

      if (example.template.includes('/rounds/')) {
        const res = await handler.handleRoundStart(req, game, matchId, round);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({});
        continue;
      }

      if (example.template.includes('/decision')) {
        const res = await handler.handleDecision(req, game, matchId, turnId);
        expect(res.status).toBe(200);
        const reply = res.body as Record<string, unknown>;
        expect(reply.turn_id).toBe(Number(turnId));
        const choices = Array.isArray(body.choices) ? body.choices : [];
        if (typeof reply.choice === 'string') {
          const ids = choices.map(choice => String((choice as Record<string, unknown>).id));
          expect(ids).toContain(reply.choice);
        } else {
          expect(typeof reply.action).toBe('string');
        }
        continue;
      }

      const res = await handler.handleEvent(req, game, matchId);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({});
    }
  });
});

describe('Config schema', () => {
  it('defaults decision timeout to 40000 and caps it at 58000', () => {
    const parsed = v.parse(TavernConfigSchema, { secret: 's' });
    expect(parsed.decisionTimeoutMs).toBe(40000);
    expect(v.parse(TavernConfigSchema, { secret: 's', decisionTimeoutMs: 58000 }).decisionTimeoutMs).toBe(58000);
    expect(() => v.parse(TavernConfigSchema, { secret: 's', decisionTimeoutMs: 58001 })).toThrow();
  });

  it('caps invitation timeout at 14000 (host ask limit) while keeping the 8000 default', () => {
    const parsed = v.parse(TavernConfigSchema, { secret: 's' });
    expect(parsed.invitation?.timeoutMs).toBeUndefined();
    expect(v.parse(TavernConfigSchema, {
      secret: 's',
      invitation: { decide: 'ask', timeoutMs: 14000 },
    }).invitation?.timeoutMs).toBe(14000);
    expect(() => v.parse(TavernConfigSchema, {
      secret: 's',
      invitation: { decide: 'ask', timeoutMs: 14001 },
    })).toThrow();
  });

  it('accepts per-game mode allowlists', () => {
    const parsed = v.parse(TavernConfigSchema, {
      secret: 's',
      games: { liars_bar: { enabled: true, modes: ['classic', 'devil'] } },
    });
    expect(parsed.games.liars_bar?.modes).toEqual(['classic', 'devil']);
  });

  it('rejects an empty secret only when the plugin is enabled', () => {
    expect(() => v.parse(TavernConfigSchema, { enabled: true, secret: '' }))
      .toThrow('tavern.secret is required when tavern plugin is enabled');
    expect(v.parse(TavernConfigSchema, { enabled: false, secret: '' }).enabled).toBe(false);
  });
});

describe('Prompt hints', () => {
  it('covers both games, private cards, sign-up words and dealer commands', () => {
    const hints = tavernPlugin.contributes?.promptHints?.('oc_test');
    expect(hints).toBeDefined();
    const text = hints![0]!.text;
    expect(text).toContain("Liar's Bar");
    expect(text).toContain('Bullet Poker');
    expect(text).toContain('hole cards');
    expect(text).toContain('入座');
    expect(text).toContain('never use those words');
    expect(text).toContain('≤3 sentences');
    expect(text).toContain('two rounds');
    expect(text).toContain('!加入');
    expect(text).toContain('!开始');
  });

  it('keeps the scene hint blind to cards and signs up', () => {
    const scene = tavernPlugin.contributes?.scenes?.find(entry => entry.id === 'table');
    expect(scene?.hint).toContain('hole cards');
    expect(scene?.hint).toContain('入座/上桌/加入');
    expect(scene?.hint).toContain('two rounds');
    expect(scene?.hint).toContain('`!`');
  });
});

describe('Choice prompt helper', () => {
  it('includes ask, rules, state and numbered choices', () => {
    const prompt = buildTavernChoicePrompt({
      ask: 'aim',
      prompt: '选一个人开枪',
      rules: '混沌规则',
      choices: [{ id: 'aim:1', say: '打 Bob' }, { id: 'aim:2', say: '打 Carol' }],
    }, '局面文本');
    expect(prompt).toContain('aim（选一个人开枪）');
    expect(prompt).toContain('混沌规则');
    expect(prompt).toContain('选一个人开枪');
    expect(prompt).toContain('局面文本');
    expect(prompt).toContain('1. aim:1 — 打 Bob');
    expect(prompt).toContain('2. aim:2 — 打 Carol');
  });
});

afterEach(() => {
  vi.useRealTimers();
});
