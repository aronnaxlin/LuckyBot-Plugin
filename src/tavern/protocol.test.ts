import { createHmac } from 'node:crypto';

import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';

import { tavernPlugin } from './index';
import { createTavernProtocolHandler } from './protocol';
import { TavernConfigSchema, type TavernConfig } from './types';
import { liarsBarModule } from '../games/liars-bar';
import type { HttpRequest, PluginCapabilities, PluginContext } from '../sdk/types';

const SECRET = '{{SECRET_a3x3429z}}';

const createMockContext = () => {
  const published: Array<{ chatId: string; options: any }> = [];
  const logCalls: Array<{ level: string; msg: string; fields?: any }> = [];

  const capabilities: PluginCapabilities = {
    callModel: vi.fn(async () => '{"action": "play", "slots": [1]}'),
    ask: vi.fn(async () => ({ choice: '接受' })),
    isEnabledForChat: vi.fn((_chatId: string) => true),
    http: { route: vi.fn() },
    chat: {
      publish: vi.fn(async (chatId, options) => {
        published.push({ chatId, options });
      }),
    },
    scene: {
      enter: vi.fn(),
      exit: vi.fn(),
      note: vi.fn(),
    },
    storage: { rootDir: '/tmp/test-storage' },
    log: {
      log: (msg, fields) => logCalls.push({ level: 'log', msg, fields }),
      warn: (msg, fields) => logCalls.push({ level: 'warn', msg, fields }),
      error: (msg, fields) => logCalls.push({ level: 'error', msg, fields }),
      debug: (msg, fields) => logCalls.push({ level: 'debug', msg, fields }),
      withFields: () => capabilities.log,
      withError: () => capabilities.log,
    },
    media: {
      send: vi.fn(async () => {
        throw new Error('media.send unsupported');
      }),
    },
  };

  const config: TavernConfig = {
    enabled: true,
    secret: SECRET,
    model: 'probe',
    decisionTimeoutMs: 200,
    basePath: '',
    tableName: 'LuckyBot',
    games: {
      liars_bar: { enabled: true },
    },
  };

  const ctx: PluginContext<TavernConfig> = {
    config,
    capabilities,
  };

  return { ctx, published, logCalls };
};

const signRequest = (
  method: string,
  path: string,
  bodyObj: unknown,
  secret = SECRET,
  ts = Math.floor(Date.now() / 1000),
): HttpRequest => {
  const rawBodyStr = JSON.stringify(bodyObj);
  const rawBody = Buffer.from(rawBodyStr, 'utf-8');
  const baseString = `${ts}.${method.toUpperCase()}.${path}.${rawBodyStr}`;
  const hex = createHmac('sha256', secret).update(baseString).digest('hex');

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

describe('Tavern Protocol Handler (OpenAPI v1, de-identified)', () => {
  it('authenticates valid signatures with timestamp.METHOD.path.rawBody', async () => {
    const { ctx } = createMockContext();
    const handler = createTavernProtocolHandler(ctx.config, ctx, [liarsBarModule]);

    const req = signRequest('POST', '/v1/games/liars_bar/invitations', {
      protocol: 1,
      seq: 1,
      game: 'liars_bar',
      match_id: 'm_example',
      chat_id: 'oc_example',
      humans: ['Alice'],
    });

    const res = await handler.handleInvitation(req, 'liars_bar');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accept: true });
  });

  it('rejects expired timestamps (> 300 s)', async () => {
    const { ctx } = createMockContext();
    const handler = createTavernProtocolHandler(ctx.config, ctx, [liarsBarModule]);

    const expiredTs = Math.floor(Date.now() / 1000) - 305;
    const req = signRequest('POST', '/v1/games/liars_bar/invitations', { seq: 1 }, SECRET, expiredTs);

    const res = await handler.handleInvitation(req, 'liars_bar');
    expect(res.status).toBe(401);
  });

  it('rejects wrong HMAC signatures', async () => {
    const { ctx } = createMockContext();
    const handler = createTavernProtocolHandler(ctx.config, ctx, [liarsBarModule]);

    const req = signRequest('POST', '/v1/games/liars_bar/invitations', { seq: 1 }, 'wrong_secret');
    const res = await handler.handleInvitation(req, 'liars_bar');
    expect(res.status).toBe(401);
  });

  it('answers accept: false for unsupported games', async () => {
    const { ctx } = createMockContext();
    const handler = createTavernProtocolHandler(ctx.config, ctx, [liarsBarModule]);

    const req = signRequest('POST', '/v1/games/poker/invitations', {
      protocol: 1,
      seq: 1,
      game: 'poker',
      match_id: 'm_example',
    });

    const res = await handler.handleInvitation(req, 'poker');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accept: false });
  });

  describe('Validation at boundary (R5)', () => {
    it('rejects malformed event bodies with 400 without crashing', async () => {
      const { ctx } = createMockContext();
      const handler = createTavernProtocolHandler(ctx.config, ctx, [liarsBarModule]);

      // Missing required event field
      const req = signRequest('POST', '/v1/games/liars_bar/matches/m_1/events', {
        protocol: 1,
        seq: 1,
        chat_id: 'oc_example',
      });
      const res = await handler.handleEvent(req, 'liars_bar', 'm_1');
      expect(res.status).toBe(400);
    });
  });

  describe('Privacy Invariant', () => {
    it('round_start stores private hand in memory, sets scene note, and NEVER publishes to chat', async () => {
      const { ctx, published } = createMockContext();
      const handler = createTavernProtocolHandler(ctx.config, ctx, [liarsBarModule]);

      const roundPayload = {
        protocol: 1,
        seq: 2,
        game: 'liars_bar',
        match_id: 'm_example_10',
        chat_id: 'oc_example',
        turn_id: 1,
        you: { seat: 1, name: 'Carol' },
        round: 1,
        target: 'K',
        hand: [{ slot: 1, card: 'SECRET_CARD_1' }, { slot: 2, card: 'SECRET_CARD_2' }],
      };

      const req = signRequest('PUT', '/v1/games/liars_bar/matches/m_example_10/rounds/1', roundPayload);
      const res = await handler.handleRoundStart(req, 'liars_bar', 'm_example_10', '1');

      expect(res.status).toBe(200);
      expect(ctx.capabilities.chat.publish).not.toHaveBeenCalled();
      expect(published.length).toBe(0);

      // Enters scene table and sets private scene note
      expect(ctx.capabilities.scene.enter).toHaveBeenCalledWith('oc_example', 'table');
      expect(ctx.capabilities.scene.note).toHaveBeenCalledWith(
        'oc_example',
        'table',
        '轮次: 1 | 目标牌: K | 当前手牌: [SECRET_CARD_1, SECRET_CARD_2]',
      );
    });

    it('decision request processes private hand, sets scene note, and NEVER publishes to chat', async () => {
      const { ctx, published } = createMockContext();
      const handler = createTavernProtocolHandler(ctx.config, ctx, [liarsBarModule]);

      const decidePayload = {
        protocol: 1,
        seq: 3,
        game: 'liars_bar',
        match_id: 'm_example_10',
        chat_id: 'oc_example',
        turn_id: 7,
        you: { seat: 1, name: 'Carol' },
        round: 1,
        target: 'K',
        hand: [{ slot: 1, card: 'SECRET_CARD_A' }, { slot: 2, card: 'SECRET_CARD_B' }],
        can_challenge: true,
        must_challenge: false,
        last_play: { seat: 0, name: 'Alice', count: 1 },
        pile: 1,
        players: [],
      };

      const req = signRequest('POST', '/v1/games/liars_bar/matches/m_example_10/turns/7/decision', decidePayload);
      const res = await handler.handleDecision(req, 'liars_bar', 'm_example_10', '7');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ turn_id: 7, action: 'play', slots: [1] });
      expect(ctx.capabilities.chat.publish).not.toHaveBeenCalled();
      expect(published.length).toBe(0);

      // Sets private scene note with decision and remaining hand
      expect(ctx.capabilities.scene.note).toHaveBeenCalledWith(
        'oc_example',
        'table',
        expect.stringContaining('轮次: 1 | 目标牌: K | 当前手牌: [SECRET_CARD_B] | 上一手: 出牌 [SECRET_CARD_A]（诈唬）'),
      );
    });

    it('fallback decision also sets scene note and never publishes to chat', async () => {
      const { ctx, published } = createMockContext();
      // Model call throws
      (ctx.capabilities.callModel as any).mockRejectedValueOnce(new Error('Model timeout'));
      const handler = createTavernProtocolHandler(ctx.config, ctx, [liarsBarModule]);

      const decidePayload = {
        protocol: 1,
        seq: 3,
        game: 'liars_bar',
        match_id: 'm_example_fb',
        chat_id: 'oc_example',
        turn_id: 9,
        you: { seat: 1, name: 'Carol' },
        round: 2,
        target: 'Q',
        hand: [{ slot: 1, card: 'Q' }, { slot: 2, card: 'K' }],
        can_challenge: true,
        must_challenge: false,
        last_play: { seat: 0, name: 'Alice', count: 1 },
      };

      const req = signRequest('POST', '/v1/games/liars_bar/matches/m_example_fb/turns/9/decision', decidePayload);
      const res = await handler.handleDecision(req, 'liars_bar', 'm_example_fb', '9');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ turn_id: 9, action: 'play', slots: [1] });
      expect(ctx.capabilities.chat.publish).not.toHaveBeenCalled();
      expect(published.length).toBe(0);

      // Note was set even on fallback
      expect(ctx.capabilities.scene.note).toHaveBeenCalledWith(
        'oc_example',
        'table',
        expect.stringContaining('轮次: 2 | 目标牌: Q | 当前手牌: [K] | 上一手: 出牌 [Q]（真牌）'),
      );
    });
  });

  describe('Events and Chat Publishing', () => {
    it('publishes public events to chat with proper wake flag', async () => {
      const { ctx, published } = createMockContext();
      const handler = createTavernProtocolHandler(ctx.config, ctx, [liarsBarModule]);

      const challengeEvent = {
        protocol: 1,
        seq: 4,
        game: 'liars_bar',
        match_id: 'm_example_10',
        chat_id: 'oc_example',
        turn_id: 8,
        you: { seat: 1, name: 'Carol' },
        event: 'challenge',
        challenger: { seat: 0, name: 'Alice' },
        accused: { seat: 1, name: 'Carol' },
        revealed: ['Q'],
        lied: true,
        shooter: { seat: 1, name: 'Carol' },
      };

      const req = signRequest('POST', '/v1/games/liars_bar/matches/m_example_10/events', challengeEvent);
      const res = await handler.handleEvent(req, 'liars_bar', 'm_example_10');

      expect(res.status).toBe(200);
      expect(published.length).toBe(1);
      const pub = published[0]!;
      expect(pub.chatId).toBe('oc_example');
      expect(pub.options.kind).toBe('game_event');
      expect(pub.options.text).toContain('Alice 质疑了 Carol');
      expect(pub.options.wake).toBe(true);
    });

    it('wakes the bot on every play event and marks its own play', async () => {
      const { ctx, published } = createMockContext();
      const handler = createTavernProtocolHandler(ctx.config, ctx, [liarsBarModule]);

      // 1. Opponent play of 2 cards -> wake = true (every public event wakes)
      const play2Event = {
        protocol: 1,
        seq: 5,
        game: 'liars_bar',
        match_id: 'm_example_10',
        chat_id: 'oc_example',
        turn_id: 9,
        you: { seat: 1, name: 'Carol' },
        event: 'play',
        seat: 0,
        name: 'Alice',
        count: 2,
        cards_left: 3,
      };

      await handler.handleEvent(signRequest('POST', '/v1/games/liars_bar/matches/m_example_10/events', play2Event), 'liars_bar', 'm_example_10');
      expect(published[0]!.options.wake).toBe(true);

      // 2. Opponent play of 3 cards -> wake = true
      const play3Event = {
        ...play2Event,
        seq: 6,
        count: 3,
      };
      await handler.handleEvent(signRequest('POST', '/v1/games/liars_bar/matches/m_example_10/events', play3Event), 'liars_bar', 'm_example_10');
      expect(published[1]!.options.wake).toBe(true);

      // 3. Bot's own play (seat == you.seat) -> wake = true and marked with "你出了 2 张（声称都是 K）"
      const ownPlayEvent = {
        ...play2Event,
        seq: 7,
        seat: 1,
        name: 'Carol',
        count: 2,
        target: 'K',
      };
      await handler.handleEvent(signRequest('POST', '/v1/games/liars_bar/matches/m_example_10/events', ownPlayEvent), 'liars_bar', 'm_example_10');
      expect(published[2]!.options.wake).toBe(true);
      expect(published[2]!.options.text).toContain('你出了 2 张（声称都是 K）');
    });

    it('handles shot events: click wakes and includes odds; bang wakes', async () => {
      const { ctx, published } = createMockContext();
      const handler = createTavernProtocolHandler(ctx.config, ctx, [liarsBarModule]);

      // Click shot -> wake = true, text contains odds
      const clickEvent = {
        protocol: 1,
        seq: 10,
        game: 'liars_bar',
        match_id: 'm_shot_test',
        chat_id: 'oc_example',
        turn_id: 11,
        event: 'shot',
        seat: 0,
        name: 'Alice',
        result: 'click',
        shots_fired: 3,
        nth: 3,
      };
      await handler.handleEvent(signRequest('POST', '/v1/games/liars_bar/matches/m_shot_test/events', clickEvent), 'liars_bar', 'm_shot_test');
      expect(published[0]!.options.wake).toBe(true);
      expect(published[0]!.options.text).toContain('下一枪中弹概率 1/3');

      // Bang shot -> wake = true
      const bangEvent = {
        ...clickEvent,
        seq: 11,
        result: 'bang',
        nth: 4,
      };
      await handler.handleEvent(signRequest('POST', '/v1/games/liars_bar/matches/m_shot_test/events', bangEvent), 'liars_bar', 'm_shot_test');
      expect(published[1]!.options.wake).toBe(true);
      expect(published[1]!.options.text).toContain('BANG！实弹击中');
    });

    it('ignores duplicate event deliveries without republishing to chat (R2)', async () => {
      const { ctx, published } = createMockContext();
      const handler = createTavernProtocolHandler(ctx.config, ctx, [liarsBarModule]);

      const playEvent = {
        protocol: 1,
        seq: 6,
        game: 'liars_bar',
        match_id: 'm_example_dup',
        chat_id: 'oc_example',
        turn_id: 10,
        event: 'play',
        seat: 0,
        name: 'Alice',
        count: 1,
      };

      const req1 = signRequest('POST', '/v1/games/liars_bar/matches/m_example_dup/events', playEvent);
      const res1 = await handler.handleEvent(req1, 'liars_bar', 'm_example_dup');
      expect(res1.status).toBe(200);
      expect(published.length).toBe(1);

      // Duplicate delivery with the same seq 6
      const req2 = signRequest('POST', '/v1/games/liars_bar/matches/m_example_dup/events', playEvent);
      const res2 = await handler.handleEvent(req2, 'liars_bar', 'm_example_dup');
      expect(res2.status).toBe(200); // still responds 200 to dealer
      expect(published.length).toBe(1); // but does NOT publish duplicate event to group
    });

    it('enters scene table on the first public event and exits on isGameEnd', async () => {
      const { ctx } = createMockContext();
      const handler = createTavernProtocolHandler(ctx.config, ctx, [liarsBarModule]);

      const playEvent = {
        seq: 1,
        game: 'liars_bar',
        match_id: 'm_scene_test',
        chat_id: 'oc_scene_chat',
        turn_id: 1,
        event: 'play',
        seat: 0,
        name: 'Alice',
        count: 1,
      };

      const req1 = signRequest('POST', '/v1/games/liars_bar/matches/m_scene_test/events', playEvent);
      await handler.handleEvent(req1, 'liars_bar', 'm_scene_test');
      expect(ctx.capabilities.scene.enter).toHaveBeenCalledWith('oc_scene_chat', 'table');
      expect(ctx.capabilities.scene.enter).toHaveBeenCalledTimes(1);

      // Second public event should not enter scene again
      const playEvent2 = {
        ...playEvent,
        seq: 2,
        turn_id: 2,
        name: 'Bob',
      };
      const req2 = signRequest('POST', '/v1/games/liars_bar/matches/m_scene_test/events', playEvent2);
      await handler.handleEvent(req2, 'liars_bar', 'm_scene_test');
      expect(ctx.capabilities.scene.enter).toHaveBeenCalledTimes(1);
      expect(ctx.capabilities.scene.exit).not.toHaveBeenCalled();

      // Game over event triggers scene.exit
      const gameOverEvent = {
        seq: 3,
        game: 'liars_bar',
        match_id: 'm_scene_test',
        chat_id: 'oc_scene_chat',
        event: 'game_over',
        winner: 0,
        winner_name: 'Alice',
      };
      const req3 = signRequest('POST', '/v1/games/liars_bar/matches/m_scene_test/events', gameOverEvent);
      await handler.handleEvent(req3, 'liars_bar', 'm_scene_test');
      expect(ctx.capabilities.scene.exit).toHaveBeenCalledWith('oc_scene_chat', 'table');
    });
  });

  describe('TavernConfigSchema (R9)', () => {
    it('rejects empty secret when tavern plugin is enabled', () => {
      expect(() =>
        v.parse(TavernConfigSchema, {
          enabled: true,
          secret: '',
        })).toThrow('tavern.secret is required when tavern plugin is enabled');
    });

    it('permits empty secret when tavern plugin is disabled', () => {
      const parsed = v.parse(TavernConfigSchema, {
        enabled: false,
        secret: '',
      });
      expect(parsed.enabled).toBe(false);
    });

    it('accepts a decision timeout for a 30 s dealer deadline', () => {
      const parsed = v.parse(TavernConfigSchema, { secret: 's', decisionTimeoutMs: 28000 });
      expect(parsed.decisionTimeoutMs).toBe(28000);
      expect(() => v.parse(TavernConfigSchema, { secret: 's', decisionTimeoutMs: 60001 })).toThrow();
    });
  });

  describe('Decision budget', () => {
    const decide = async (decisionTimeoutMs: number, deadline_ms?: number) => {
      const { ctx, logCalls } = createMockContext();
      const handler = createTavernProtocolHandler({ ...ctx.config, decisionTimeoutMs }, ctx, [liarsBarModule]);
      const payload = {
        protocol: 1,
        seq: 1,
        game: 'liars_bar',
        match_id: 'm_budget',
        chat_id: 'oc_example',
        turn_id: 1,
        you: { seat: 1, name: 'Carol' },
        round: 1,
        target: 'K',
        hand: [{ slot: 1, card: 'K' }],
        can_challenge: false,
        must_challenge: false,
        ...(deadline_ms === undefined ? {} : { deadline_ms }),
      };
      const req = signRequest('POST', '/v1/games/liars_bar/matches/m_budget/turns/1/decision', payload);
      await handler.handleDecision(req, 'liars_bar', 'm_budget', '1');
      return logCalls.find(c => c.msg === 'Game decision completed')!.fields;
    };

    it('uses our timeout when the dealer deadline leaves more room', async () => {
      expect(await decide(28000, 30000)).toMatchObject({ budgetMs: 28000, deadlineMs: 30000 });
    });

    it('keeps a 2 s margin under a tighter dealer deadline', async () => {
      expect(await decide(28000, 15000)).toMatchObject({ budgetMs: 13000, deadlineMs: 15000 });
    });
  });

  describe('Invitations', () => {
    it('rejects invitation when chat_id is missing', async () => {
      const { ctx, published } = createMockContext();
      const handler = createTavernProtocolHandler(ctx.config, ctx, [liarsBarModule]);

      const req = signRequest('POST', '/v1/games/liars_bar/invitations', {
        protocol: 1,
        game: 'liars_bar',
        match_id: 'm_inv_1',
        humans: ['Alice'],
      });

      const res = await handler.handleInvitation(req, 'liars_bar');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ accept: false });
      expect(published).toHaveLength(0);
    });

    it('rejects invitation when tavern is disabled for that chat', async () => {
      const { ctx, published } = createMockContext();
      ctx.isEnabledForChat = vi.fn((chatId: string) => chatId !== 'oc_disabled_chat');
      const handler = createTavernProtocolHandler(ctx.config, ctx, [liarsBarModule]);

      const req = signRequest('POST', '/v1/games/liars_bar/invitations', {
        protocol: 1,
        chat_id: 'oc_disabled_chat',
        game: 'liars_bar',
        match_id: 'm_inv_2',
        humans: ['Bob'],
      });

      const res = await handler.handleInvitation(req, 'liars_bar');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ accept: false });
      expect(published).toHaveLength(0);
    });

    it('accepts by default when decide is always, publishes public line with wake=true', async () => {
      const { ctx, published } = createMockContext();
      const handler = createTavernProtocolHandler(ctx.config, ctx, [liarsBarModule]);

      const req = signRequest('POST', '/v1/games/liars_bar/invitations', {
        protocol: 1,
        chat_id: 'oc_chat_1',
        game: 'liars_bar',
        match_id: 'm_inv_3',
        humans: ['Alice', 'Bob'],
      });

      const res = await handler.handleInvitation(req, 'liars_bar');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ accept: true });
      expect(published).toHaveLength(1);
      expect(published[0]).toEqual({
        chatId: 'oc_chat_1',
        options: {
          kind: 'game_event',
          text: '荷官邀请你上桌（骗子酒馆，等你的有 Alice、Bob）。你接受了。',
          wake: true,
        },
      });
      // Scene enter is not called on invitation
      expect(ctx.capabilities.scene.enter).not.toHaveBeenCalled();
    });

    it('decides via ask capability when configured: accepts', async () => {
      const { ctx, published } = createMockContext();
      ctx.config.invitation = {
        decide: 'ask',
        timeoutMs: 5000,
        onTimeout: 'decline',
      };
      (ctx.capabilities.ask as any).mockResolvedValueOnce({
        choice: '接受',
        reason: '想玩',
      });
      const handler = createTavernProtocolHandler(ctx.config, ctx, [liarsBarModule]);

      const req = signRequest('POST', '/v1/games/liars_bar/invitations', {
        protocol: 1,
        chat_id: 'oc_chat_1',
        game: 'liars_bar',
        match_id: 'm_inv_4',
        humans: ['Alice'],
      });

      const res = await handler.handleInvitation(req, 'liars_bar');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ accept: true });

      expect(ctx.capabilities.ask).toHaveBeenCalledWith(
        'oc_chat_1',
        expect.objectContaining({
          question: expect.stringContaining('骗子酒馆'),
          choices: ['接受', '拒绝'],
          timeoutMs: 5000,
        }),
      );

      expect(published).toHaveLength(1);
      expect(published[0]!.options.text).toBe('荷官邀请你上桌（骗子酒馆，等你的有 Alice）。你接受了。');
      expect(published[0]!.options.wake).toBe(true);
      expect(ctx.capabilities.scene.enter).not.toHaveBeenCalled();
    });

    it('decides via ask capability when configured: declines and does not enter scene', async () => {
      const { ctx, published } = createMockContext();
      ctx.config.invitation = {
        decide: 'ask',
        timeoutMs: 5000,
        onTimeout: 'accept',
      };
      (ctx.capabilities.ask as any).mockResolvedValueOnce({
        choice: '拒绝',
        reason: '没空',
      });
      const handler = createTavernProtocolHandler(ctx.config, ctx, [liarsBarModule]);

      const req = signRequest('POST', '/v1/games/liars_bar/invitations', {
        protocol: 1,
        chat_id: 'oc_chat_1',
        game: 'liars_bar',
        match_id: 'm_inv_5',
        humans: ['Alice'],
      });

      const res = await handler.handleInvitation(req, 'liars_bar');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ accept: false });

      expect(published).toHaveLength(1);
      expect(published[0]!.options.text).toBe('荷官邀请你上桌（骗子酒馆，等你的有 Alice）。你拒绝了。');
      expect(published[0]!.options.wake).toBe(true);
      expect(ctx.capabilities.scene.enter).not.toHaveBeenCalled();
    });

    it('falls back to onTimeout when ask throws or times out', async () => {
      const { ctx, published, logCalls } = createMockContext();
      ctx.config.invitation = {
        decide: 'ask',
        timeoutMs: 3000,
        onTimeout: 'decline',
      };
      (ctx.capabilities.ask as any).mockRejectedValueOnce(new Error('timeout'));
      const handler = createTavernProtocolHandler(ctx.config, ctx, [liarsBarModule]);

      const req = signRequest('POST', '/v1/games/liars_bar/invitations', {
        protocol: 1,
        chat_id: 'oc_chat_1',
        game: 'liars_bar',
        match_id: 'm_inv_6',
      });

      const res = await handler.handleInvitation(req, 'liars_bar');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ accept: false });

      expect(published).toHaveLength(1);
      expect(published[0]!.options.text).toBe('荷官邀请你上桌（骗子酒馆）。你拒绝了。');
      expect(published[0]!.options.wake).toBe(true);
      expect(ctx.capabilities.scene.enter).not.toHaveBeenCalled();

      // Verified log contains source: fallback
      expect(logCalls.some(c => c.msg.includes('invitation decision') && c.fields?.source === 'fallback')).toBe(true);
    });

    it('includes dealer command prohibition in prompt hint', () => {
      const hints = tavernPlugin.contributes?.promptHints?.('oc_test');
      expect(hints).toBeDefined();
      expect(hints![0]!.text).toContain('!加入');
      expect(hints![0]!.text).toContain('!开始');
      expect(hints![0]!.text).toContain('seats are offered by the dealer');
    });
  });
});
