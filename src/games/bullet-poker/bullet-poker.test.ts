import { describe, expect, it, vi } from 'vitest';

import {
  bulletPokerAvailableOptions,
  bulletPokerModule,
  buildBulletPokerPrompt,
  chooseBulletPokerFallback,
  createBulletPokerDecisionNote,
  createBulletPokerRoundNote,
  describeBulletPokerEvent,
  describeBulletPokerState,
  fallbackBulletPoker,
  isBulletPokerDecideRequest,
  isBulletPokerPair,
  isGameEndBulletPoker,
  parseBulletPokerResponse,
  validateBulletPokerAction,
  wakesBotBulletPoker,
  type BulletPokerDecisionRequest,
} from './bullet-poker';
import type { PluginLogger } from '../../sdk/types';

const logger = {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  withFields: vi.fn(),
  withError: vi.fn(),
} as unknown as PluginLogger;

const makeDecision = (overrides: Partial<BulletPokerDecisionRequest> = {}): BulletPokerDecisionRequest => ({
  protocol: 1,
  seq: 20,
  game: 'bullet_poker',
  match_id: 'bp1',
  chat_id: 'oc_example',
  turn_id: 9,
  you: { seat: 2, name: 'Carol' },
  hand_no: 1,
  round: 2,
  board: ['Kh', '7s', '2c'],
  hole: ['As', '7d'],
  bet: 2,
  folds_left: 3,
  swapped: false,
  options: {
    raise: true,
    fold: true,
    swap: true,
    allin: true,
    call: false,
    pick: false,
    responding: false,
  },
  offer: null,
  allin_by: null,
  button: 0,
  players: [
    { seat: 0, name: 'Alice', alive: true, folded: false, allin: false, bet: 3, acted: true, swapped: false, folds_left: 2, is_bot: false },
    { seat: 1, name: 'Bob', alive: true, folded: true, allin: false, bet: 2, acted: true, swapped: true, folds_left: 2, is_bot: true },
    { seat: 2, name: 'Carol', alive: true, folded: false, allin: false, bet: 2, acted: false, swapped: false, folds_left: 3, is_bot: true },
  ],
  log: ['第 1 手开始，每人先押 1 颗，从 Alice 开始表态', '都跟上了，翻出 3 张公共牌：Kh 7s 2c'],
  chat: [{ name: 'Alice', text: '这把我稳了' }],
  deadline_ms: 58000,
  ...overrides,
});

describe('Bullet Poker module', () => {
  describe('request shape and pair detection', () => {
    it('accepts a spec-shaped decision request', () => {
      expect(isBulletPokerDecideRequest(makeDecision())).toBe(true);
      expect(isBulletPokerDecideRequest({ game: 'bullet_poker' })).toBe(false);
    });

    it('detects pairs by rank only', () => {
      expect(isBulletPokerPair(['As', 'Ah'])).toBe(true);
      expect(isBulletPokerPair(['Ts', 'Td'])).toBe(true);
      expect(isBulletPokerPair(['As', 'Kd'])).toBe(false);
      expect(isBulletPokerPair(['As'])).toBe(false);
    });
  });

  describe('validateBulletPokerAction', () => {
    it('accepts only actions enabled by options', () => {
      const req = makeDecision();
      expect(validateBulletPokerAction(req, { turn_id: 9, action: 'raise' })).toBe(true);
      expect(validateBulletPokerAction(req, { turn_id: 9, action: 'fold' })).toBe(true);
      expect(validateBulletPokerAction(req, { turn_id: 9, action: 'allin' })).toBe(true);
      expect(validateBulletPokerAction(req, { turn_id: 9, action: 'swap', slot: 1 })).toBe(true);
      expect(validateBulletPokerAction(req, { turn_id: 9, action: 'swap', slot: 2 })).toBe(true);
      expect(validateBulletPokerAction(req, { turn_id: 9, action: 'call' })).toBe(false);
      expect(validateBulletPokerAction(req, { turn_id: 9, action: 'pick', choice: 1 })).toBe(false);
    });

    it('validates swap slots and pick choices', () => {
      const req = makeDecision({
        options: { raise: false, fold: false, swap: true, allin: false, call: false, pick: true, responding: false },
        offer: { slot: 1, cards: ['2c', '9h', 'Jd'] },
      });
      expect(validateBulletPokerAction(req, { turn_id: 9, action: 'swap', slot: 3 })).toBe(false);
      expect(validateBulletPokerAction(req, { turn_id: 9, action: 'pick', choice: 2 })).toBe(true);
      expect(validateBulletPokerAction(req, { turn_id: 9, action: 'pick', choice: 4 })).toBe(false);
      expect(validateBulletPokerAction(req, { turn_id: 9, action: 'pick' })).toBe(false);
    });

    it('rejects malformed actions', () => {
      const req = makeDecision();
      expect(validateBulletPokerAction(req, null)).toBe(false);
      expect(validateBulletPokerAction(req, {})).toBe(false);
      expect(validateBulletPokerAction(req, { turn_id: 9, action: 'yolo' })).toBe(false);
    });
  });

  describe('fallbackBulletPoker', () => {
    it('raises on a normal turn', () => {
      expect(fallbackBulletPoker(makeDecision())).toEqual({ turn_id: 9, action: 'raise' });
    });

    it('calls a responding turn with a pair, folds without one', () => {
      const responding = {
        options: { raise: false, fold: true, swap: false, allin: false, call: true, pick: false, responding: true },
        allin_by: { seat: 0, name: 'Alice' },
      };
      expect(fallbackBulletPoker(makeDecision({ ...responding, hole: ['As', 'Ah'] })))
        .toEqual({ turn_id: 9, action: 'call' });
      expect(fallbackBulletPoker(makeDecision({ ...responding, hole: ['As', 'Kd'], folds_left: 2 })))
        .toEqual({ turn_id: 9, action: 'fold' });
      expect(fallbackBulletPoker(makeDecision({ ...responding, hole: ['As', 'Kd'], folds_left: 0 })))
        .toEqual({ turn_id: 9, action: 'call' });
    });

    it('picks a random card from the swap offer', () => {
      const req = makeDecision({
        options: { raise: false, fold: false, swap: false, allin: false, call: false, pick: true, responding: false },
        offer: { slot: 1, cards: ['2c', '9h', 'Jd'] },
      });
      const reply = fallbackBulletPoker(req);
      expect('action' in reply && reply.action).toBe('pick');
      if (!('action' in reply)) throw new Error('expected an action reply');
      expect(Number(reply.choice)).toBeGreaterThanOrEqual(1);
      expect(Number(reply.choice)).toBeLessThanOrEqual(3);
      const fallback = chooseBulletPokerFallback(req);
      expect(fallback.kind).toBe('pick');
    });

    it('only falls back to actions that are enabled', () => {
      const req = makeDecision({
        options: { raise: false, fold: false, swap: true, allin: false, call: false, pick: false, responding: false },
      });
      expect(fallbackBulletPoker(req)).toEqual({ turn_id: 9, action: 'swap', slot: 1 });
    });
  });

  describe('choices fallback', () => {
    const choices = [
      { id: 'raise', say: '加注' },
      { id: 'fold', say: '弃牌' },
      { id: 'swap:1', say: '换第一张' },
      { id: 'swap:2', say: '换第二张' },
    ];

    it('maps the heuristic to the matching choice id', () => {
      expect(bulletPokerModule.fallbackChoice(makeDecision({ choices }))).toBe('raise');
    });

    it('uses the responding heuristic', () => {
      const req = makeDecision({
        choices: [{ id: 'call', say: '跟' }, { id: 'fold', say: '弃' }],
        options: { raise: false, fold: true, swap: false, allin: false, call: true, pick: false, responding: true },
        hole: ['As', 'Ah'],
      });
      expect(bulletPokerModule.fallbackChoice(req)).toBe('call');
    });

    it('returns a random valid id for an unknown shape', () => {
      const id = bulletPokerModule.fallbackChoice({ choices: [{ id: 'raise', say: '' }, { id: 'fold', say: '' }] });
      expect(['raise', 'fold']).toContain(id);
    });
  });

  describe('prompts', () => {
    it('prefers the request rules and lists the private state', () => {
      const req = makeDecision({ rules: 'CUSTOM POKER RULES' });
      const prompt = buildBulletPokerPrompt(req);
      expect(prompt).toContain('CUSTOM POKER RULES');
      expect(prompt).not.toContain('子弹德州》：德州扑克');
      expect(prompt).toContain('As、7d');
      expect(prompt).toContain('Kh、7s、2c');
      expect(prompt).toContain('{"action": "raise"}');
    });

    it('includes swap offer cards only in the private state', () => {
      const req = makeDecision({
        offer: { slot: 2, cards: ['2c', '9h', 'Jd'] },
        options: { raise: false, fold: false, swap: false, allin: false, call: false, pick: true, responding: false },
      });
      const state = describeBulletPokerState(req);
      expect(state).toContain('换第 2 张底牌');
      expect(state).toContain('2c、9h、Jd');
      expect(bulletPokerAvailableOptions(req).join('')).toContain('pick');
    });

    it('parses fenced model output', () => {
      expect(parseBulletPokerResponse('```json\n{"action":"raise"}\n```')).toEqual({ action: 'raise' });
    });
  });

  describe('decideAction', () => {
    it('returns the validated legacy action', async () => {
      const callModel = vi.fn(async () => '{"action": "raise"}');
      const action = await bulletPokerModule.decideAction(makeDecision(), { callModel, log: logger, remainingMs: 8000 });
      expect(action).toEqual({ turn_id: 9, action: 'raise' });
    });

    it('throws on an invalid action', async () => {
      const callModel = vi.fn(async () => '{"action": "call"}');
      await expect(
        bulletPokerModule.decideAction(makeDecision(), { callModel, log: logger, remainingMs: 8000 }),
      ).rejects.toThrow('Model decision is invalid');
    });
  });

  describe('describeBulletPokerEvent', () => {
    it('describes hand, bets and folds', () => {
      expect(describeBulletPokerEvent({ event: 'hand', hand_no: 2, button: 1 }))
        .toBe('第 2 手开始，从座位 1 开始表态。');
      expect(describeBulletPokerEvent({ event: 'raise', seat: 0, name: 'Alice', bet: 2 }))
        .toBe('Alice 加注，押到 2 颗。');
      expect(describeBulletPokerEvent({ event: 'allin', seat: 0, name: 'Alice' }))
        .toBe('Alice 全押了！');
      expect(describeBulletPokerEvent({ event: 'call', seat: 2, name: 'Carol' }))
        .toBe('Carol 跟了全押。');
      expect(describeBulletPokerEvent({ event: 'fold', seat: 1, name: 'Bob', load: 2 }))
        .toBe('Bob 弃牌，把 2 颗子弹装进枪。');
    });

    it('describes shots with the load odds', () => {
      expect(describeBulletPokerEvent({ event: 'shot', seat: 1, name: 'Bob', load: 2, result: 'click' }))
        .toBe('Bob 扣动扳机（2 颗子弹，中弹概率 2/8）……click！空枪，安然无恙。');
      expect(describeBulletPokerEvent({ event: 'shot', seat: 1, name: 'Bob', load: 8, result: 'bang' }))
        .toBe('Bob 扣动扳机（8 颗子弹，中弹概率 8/8）……BANG！实弹击中，出局！');
    });

    it('describes swaps and streets without revealing the swapped card', () => {
      expect(describeBulletPokerEvent({ event: 'swapped', seat: 1, name: 'Bob' }))
        .toBe('Bob 换了一张底牌。');
      expect(describeBulletPokerEvent({ event: 'street', round: 2, board: ['Kh', '7s', '2c'] }))
        .toBe('第 2 轮翻牌：Kh、7s、2c。');
    });

    it('describes showdown, hand_won and game_over', () => {
      const showdown = describeBulletPokerEvent({
        event: 'showdown',
        board: ['Kh', '7s', '2c', '9d', 'Qc'],
        winners: [{ seat: 2, name: 'Carol' }],
        hands: [
          { seat: 0, name: 'Alice', hole: ['Qs', 'Jd'], hand: '一对' },
          { seat: 2, name: 'Carol', hole: ['As', 'Ah'], hand: '一对' },
        ],
      });
      expect(showdown).toContain('摊牌！公共牌：Kh、7s、2c、9d、Qc');
      expect(showdown).toContain('Alice：一对（Qs、Jd）');
      expect(showdown).toContain('赢家：Carol');

      expect(describeBulletPokerEvent({ event: 'hand_won', winners: [{ seat: 0, name: 'Alice' }], reason: 'folds' }))
        .toBe('Alice 赢下这一手（其他人都弃了）。');
      expect(describeBulletPokerEvent({ event: 'game_over', winner: { seat: 2, name: 'Carol' } }))
        .toBe('游戏结束！胜者：Carol。');
      expect(describeBulletPokerEvent({ event: 'game_over', winner: null }))
        .toBe('游戏结束（中途散场）。');
    });

    it('returns undefined for unknown events', () => {
      expect(describeBulletPokerEvent({ event: 'something_new' })).toBeUndefined();
      expect(describeBulletPokerEvent(null)).toBeUndefined();
    });
  });

  describe('wakesBot and isGameEnd', () => {
    it('wakes on every public poker event', () => {
      for (const event of [
        { event: 'hand' }, { event: 'raise' }, { event: 'allin' }, { event: 'call' },
        { event: 'fold' }, { event: 'shot' }, { event: 'swapped' }, { event: 'street' },
        { event: 'showdown' }, { event: 'hand_won' }, { event: 'game_over' },
      ]) expect(wakesBotBulletPoker(event)).toBe(true);
      expect(wakesBotBulletPoker({ event: 'something_new' })).toBe(false);
      expect(wakesBotBulletPoker(null)).toBe(false);
    });

    it('detects game end on game_over', () => {
      expect(isGameEndBulletPoker({ event: 'game_over' })).toBe(true);
      expect(isGameEndBulletPoker({ event: 'hand' })).toBe(false);
    });
  });

  describe('scene notes stay blind', () => {
    const RULE = '动作由牌桌另行决定，聊天里你看不到自己的底牌和换牌候选：别报具体牌面，别预告下一步动作；嘴上虚张声势都行';
    const noCards = (note: string | undefined) => {
      expect(note).toBeDefined();
      for (const card of ['As', '7d', '2c', '9h', 'Jd']) expect(note).not.toContain(card);
    };

    it('round note carries the hand number and hand size, never the hole cards', () => {
      const note = createBulletPokerRoundNote({ hand_no: 3, round: 3, button: 1, hole: ['As', '7d'] });
      expect(note).toBe(`第 3 手 | 从座位 1 开始表态 | 底牌 2 张 | 公共牌 0 张 | ${RULE}`);
      noCards(note);

      const named = createBulletPokerRoundNote({
        hand_no: 3,
        round: 3,
        button: 1,
        hole: ['As', '7d'],
        order: [{ seat: 0, name: 'Alice', alive: true }, { seat: 1, name: 'Bob', alive: true }],
      });
      expect(named).toContain('从 Bob 开始表态');
      noCards(named);
    });

    it('decision note states only the public shape of the move', () => {
      const req = { hand_no: 1, round: 2, bet: 2, hole: ['As', '7d'], offer: { slot: 1, cards: ['2c', '9h', 'Jd'] } };
      expect(createBulletPokerDecisionNote(req, { turn_id: 9, action: 'raise' }))
        .toBe(`第 1 手 | 第 2 轮 | 押 2 颗 | 你这一手: 加注 | ${RULE}`);
      expect(createBulletPokerDecisionNote(req, { turn_id: 9, action: 'allin' })).toContain('你这一手: 全押');
      expect(createBulletPokerDecisionNote(req, { turn_id: 9, action: 'call' })).toContain('你这一手: 跟全押');
      expect(createBulletPokerDecisionNote(req, { turn_id: 9, action: 'fold' }))
        .toContain('你这一手: 弃牌开枪（装 2 颗）');
      expect(createBulletPokerDecisionNote(req, { turn_id: 9, action: 'swap', slot: 1 }))
        .toContain('你这一手: 换了一张牌');
      expect(createBulletPokerDecisionNote(req, { turn_id: 9, choice: 'pick:2' }))
        .toContain('你这一手: 换了一张牌');
      for (const action of [
        { turn_id: 9, action: 'raise' as const },
        { turn_id: 9, action: 'swap' as const, slot: 1 },
        { turn_id: 9, choice: 'pick:2' },
      ]) noCards(createBulletPokerDecisionNote(req, action));
    });
  });
});
