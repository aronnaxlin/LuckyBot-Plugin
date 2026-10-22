import { createHmac } from 'node:crypto';

import * as v from 'valibot';
import { describe, expect, it, vi } from 'vitest';

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
    http: { route: vi.fn() },
    chat: {
      publish: vi.fn(async (chatId, options) => {
        published.push({ chatId, options });
      }),
    },
    scene: {
      enter: vi.fn(),
      exit: vi.fn(),
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
    it('round_start stores private hand in memory and NEVER publishes to chat', async () => {
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
    });

    it('decision request processes private hand and NEVER publishes to chat', async () => {
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

    it('does not wake the bot on play events', async () => {
      const { ctx, published } = createMockContext();
      const handler = createTavernProtocolHandler(ctx.config, ctx, [liarsBarModule]);

      const playEvent = {
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

      const req = signRequest('POST', '/v1/games/liars_bar/matches/m_example_10/events', playEvent);
      const res = await handler.handleEvent(req, 'liars_bar', 'm_example_10');

      expect(res.status).toBe(200);
      expect(published.length).toBe(1);
      expect(published[0]!.options.wake).toBe(false);
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
  });
});
