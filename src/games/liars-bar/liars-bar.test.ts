import { describe, expect, it, vi } from 'vitest';

import {
  buildLiarsBarPrompt,
  createLiarsBarDecisionNote,
  createLiarsBarRoundNote,
  describeLiarsBarEvent,
  describeLiarsBarState,
  fallbackLiarsBar,
  isGameEndLiarsBar,
  liarsBarModule,
  parseLiarsBarResponse,
  pickLiarsBarAimTarget,
  validateLiarsBarAction,
  wakesBotLiarsBar,
  type LiarsBarDecideRequest,
} from './liars-bar';
import type { PluginLogger } from '../../sdk/types';

const logger = {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  withFields: vi.fn(),
  withError: vi.fn(),
} as unknown as PluginLogger;

const makeRequest = (overrides: Partial<LiarsBarDecideRequest> = {}): LiarsBarDecideRequest => ({
  protocol: 1,
  seq: 10,
  game: 'liars_bar',
  match_id: 'm_example_123',
  chat_id: 'oc_example',
  turn_id: 42,
  you: { seat: 2, name: 'Carol' },
  round: 3,
  target: 'K',
  hand: [
    { slot: 1, card: 'Q' },
    { slot: 2, card: 'K' },
    { slot: 3, card: 'JOKER' },
    { slot: 4, card: 'A' },
    { slot: 5, card: 'K' },
  ],
  can_challenge: true,
  must_challenge: false,
  last_play: { seat: 1, name: 'Bob', count: 2 },
  pile: 3,
  players: [
    { seat: 0, name: 'Alice', alive: true, cards_left: 4, shots_fired: 1, is_bot: false },
    { seat: 1, name: 'Bob', alive: true, cards_left: 2, shots_fired: 4, is_bot: true },
    { seat: 2, name: 'Carol', alive: true, cards_left: 3, shots_fired: 2, is_bot: true },
    { seat: 3, name: 'Dave', alive: false, cards_left: 0, shots_fired: 3, is_bot: false },
  ],
  log: ['第 3 小局开始，目标牌 K'],
  chat: [{ name: 'Alice', text: 'Carol 手里肯定没 K' }],
  deadline_ms: 58000,
  ...overrides,
});

describe("Liar's Bar module", () => {
  describe('validateLiarsBarAction', () => {
    it('accepts valid play actions with distinct current slots', () => {
      const req = makeRequest();
      expect(validateLiarsBarAction(req, { turn_id: 42, action: 'play', slots: [2] })).toBe(true);
      expect(validateLiarsBarAction(req, { turn_id: 42, action: 'play', slots: [2, 3] })).toBe(true);
      expect(validateLiarsBarAction(req, { turn_id: 42, action: 'play', slots: [1, 2, 5] })).toBe(true);
    });

    it('rejects play with slots not in hand, duplicates, or too many cards', () => {
      const req = makeRequest({ hand: [{ slot: 1, card: 'K' }] });
      expect(validateLiarsBarAction(req, { turn_id: 42, action: 'play', slots: [2] })).toBe(false);
      expect(validateLiarsBarAction(makeRequest(), { turn_id: 42, action: 'play', slots: [2, 2] })).toBe(false);
      expect(validateLiarsBarAction(makeRequest(), { turn_id: 42, action: 'play', slots: [] })).toBe(false);
      expect(validateLiarsBarAction(makeRequest(), { turn_id: 42, action: 'play', slots: [1, 2, 3, 4] })).toBe(false);
    });

    it('respects max_play for chaos mode (one card per play)', () => {
      const req = makeRequest({ mode: 'chaos', max_play: 1 });
      expect(validateLiarsBarAction(req, { turn_id: 42, action: 'play', slots: [2] })).toBe(true);
      expect(validateLiarsBarAction(req, { turn_id: 42, action: 'play', slots: [2, 3] })).toBe(false);
    });

    it('treats chaos as max_play 1 even when max_play is absent', () => {
      const req = makeRequest({ mode: 'chaos' });
      expect(validateLiarsBarAction(req, { turn_id: 42, action: 'play', slots: [2] })).toBe(true);
      expect(validateLiarsBarAction(req, { turn_id: 42, action: 'play', slots: [2, 3] })).toBe(false);
    });

    it('rejects play when must_challenge is true', () => {
      const req = makeRequest({ must_challenge: true });
      expect(validateLiarsBarAction(req, { turn_id: 42, action: 'play', slots: [2] })).toBe(false);
    });

    it('validates challenge action based on can_challenge', () => {
      expect(validateLiarsBarAction(makeRequest({ can_challenge: true }), { turn_id: 42, action: 'challenge' })).toBe(true);
      expect(validateLiarsBarAction(makeRequest({ can_challenge: false }), { turn_id: 42, action: 'challenge' })).toBe(false);
    });

    it('only allows a marked devil card to be played alone', () => {
      const devil = makeRequest({
        mode: 'devil',
        devil_card: 'K_devil',
        hand: [{ slot: 1, card: 'K_devil' }, { slot: 2, card: 'K' }, { slot: 3, card: 'Q_devil' }],
      });
      expect(validateLiarsBarAction(devil, { turn_id: 42, action: 'play', slots: [1] })).toBe(true);
      expect(validateLiarsBarAction(devil, { turn_id: 42, action: 'play', slots: [1, 2] })).toBe(false);
      // Any marked demon card is only played alone; the rule is conservative here.
      expect(validateLiarsBarAction(devil, { turn_id: 42, action: 'play', slots: [3, 2] })).toBe(false);
    });

    it('validates a legacy aim target against the aim request', () => {
      const req = makeRequest({
        ask: 'aim',
        aim: { kind: 'lie', targets: [0, 1, { seat: 3 }] },
        choices: [{ id: 'aim:0', say: '打 Alice' }, { id: 'aim:1', say: '打 Bob' }],
      });
      expect(validateLiarsBarAction(req, { turn_id: 42, target: 1 })).toBe(true);
      expect(validateLiarsBarAction(req, { turn_id: 42, target: 2 })).toBe(false);
    });

    it('rejects unknown or malformed actions', () => {
      const req = makeRequest();
      expect(validateLiarsBarAction(req, null)).toBe(false);
      expect(validateLiarsBarAction(req, {})).toBe(false);
      expect(validateLiarsBarAction(req, { turn_id: 42, action: 'pass' })).toBe(false);
      expect(validateLiarsBarAction(req, { turn_id: 42, action: 'play', slots: '1' })).toBe(false);
    });
  });

  describe('fallbackLiarsBar', () => {
    it('forces challenge when must_challenge is true', () => {
      expect(fallbackLiarsBar(makeRequest({ must_challenge: true })))
        .toEqual({ turn_id: 42, action: 'challenge' });
    });

    it('prefers honest cards up to max_play', () => {
      const req = makeRequest({
        target: 'K',
        max_play: 2,
        hand: [{ slot: 1, card: 'A' }, { slot: 2, card: 'K' }, { slot: 3, card: 'JOKER' }, { slot: 4, card: 'K' }],
      });
      expect(fallbackLiarsBar(req)).toEqual({ turn_id: 42, action: 'play', slots: [2, 3] });
    });

    it('challenges a maximum-sized claim when holding no honest cards', () => {
      const req = makeRequest({
        target: 'K',
        hand: [{ slot: 1, card: 'Q' }, { slot: 4, card: 'A' }],
        last_play: { seat: 1, name: 'Bob', count: 3 },
        can_challenge: true,
      });
      expect(fallbackLiarsBar(req)).toEqual({ turn_id: 42, action: 'challenge' });
    });

    it('plays the active devil card alone when there is no honest card', () => {
      const req = makeRequest({
        mode: 'devil',
        devil_card: 'K_devil',
        target: 'K',
        can_challenge: false,
        hand: [{ slot: 1, card: 'Q' }, { slot: 2, card: 'K_devil' }],
      });
      expect(fallbackLiarsBar(req)).toEqual({ turn_id: 42, action: 'play', slots: [2] });
    });

    it('aims at a living non-self target with the most shots fired', () => {
      const req = makeRequest({
        ask: 'aim',
        aim: { kind: 'chaos', targets: [0, 1, 2] },
      });
      // Bob (seat 1) has 4 shots fired, Alice 1, self is excluded.
      expect(pickLiarsBarAimTarget(req)).toBe(1);
      expect(fallbackLiarsBar(req)).toEqual({ turn_id: 42, target: 1 });
    });
  });

  describe('choices fallback', () => {
    const choices = [
      { id: 'play:2', say: '出 K' },
      { id: 'play:2,3', say: '出 K、Joker' },
      { id: 'challenge', say: '质疑' },
    ];

    it('maps the heuristic to the matching choice id', () => {
      expect(liarsBarModule.fallbackChoice(makeRequest({ must_challenge: true, choices }))).toBe('challenge');
      expect(liarsBarModule.fallbackChoice(makeRequest({
        choices,
        hand: [{ slot: 2, card: 'K' }, { slot: 3, card: 'JOKER' }],
      }))).toBe('play:2,3');
    });

    it('matches an equivalent play by card faces when the dealer listed other slots', () => {
      // The heuristic wants slots 1,3 (two K); the dealer listed that card set as play:3,5.
      expect(liarsBarModule.fallbackChoice(makeRequest({
        target: 'K',
        max_play: 2,
        hand: [{ slot: 1, card: 'K' }, { slot: 3, card: 'K' }, { slot: 5, card: 'K' }, { slot: 2, card: 'A' }],
        choices: [
          { id: 'play:3', say: '出 K' },
          { id: 'play:3,5', say: '出 K、K' },
          { id: 'play:2', say: '出 A' },
          { id: 'challenge', say: '质疑' },
        ],
      }))).toBe('play:3,5');
    });

    it('returns the aim choice when asked to shoot', () => {
      const req = makeRequest({
        ask: 'aim',
        aim: { kind: 'chaos', targets: [0, 1] },
        choices: [
          { id: 'aim:0', say: '打 Alice' },
          { id: 'aim:1', say: '打 Bob' },
        ],
      });
      expect(liarsBarModule.fallbackChoice(req)).toBe('aim:1');
    });

    it('falls back to a random valid id for an unknown shape', () => {
      const ids = new Set(['challenge', 'play:1']);
      const id = liarsBarModule.fallbackChoice({ choices: [{ id: 'challenge', say: '' }, { id: 'play:1', say: '' }] });
      expect(ids.has(id)).toBe(true);
    });
  });

  describe('prompts', () => {
    it('prefers the request rules over the built-in classic text', () => {
      const req = makeRequest({ rules: 'CUSTOM RULES FOR THIS TABLE', mode: 'devil', devil_card: 'K_devil' });
      const prompt = buildLiarsBarPrompt(req);
      expect(prompt).toContain('CUSTOM RULES FOR THIS TABLE');
      expect(prompt).not.toContain('牌堆 Q、K、A 各 6 张');
      expect(prompt).toContain('2 号位=K');
      expect(prompt).toContain('本小局的恶魔牌: K_devil');
      expect(prompt).toContain('{"action": "play"');
    });

    it('describes the aim request and asks for a target', () => {
      const req = makeRequest({ ask: 'aim', aim: { kind: 'chaos', targets: [0, 1] } });
      const prompt = buildLiarsBarPrompt(req);
      expect(prompt).toContain('现在要选人开枪（chaos）');
      expect(prompt).toContain('{"target": <座位号>}');
    });

    it('describes private state including hand faces and odds', () => {
      const state = describeLiarsBarState(makeRequest());
      expect(state).toContain('模式: classic');
      expect(state).toContain('1 号位=Q');
      expect(state).toContain('Bob（座位 1）');
      expect(state).toContain('下一枪中弹概率 1/2');
    });
  });

  describe('parseLiarsBarResponse', () => {
    it('parses raw JSON strings and markdown fences', () => {
      expect(parseLiarsBarResponse('{"action": "challenge"}')).toEqual({ action: 'challenge' });
      expect(parseLiarsBarResponse('```json\n{"action": "play", "slots": [3]}\n```')).toEqual({ action: 'play', slots: [3] });
    });
  });

  describe('decideAction', () => {
    it('invokes callModel and returns the validated legacy action', async () => {
      const callModel = vi.fn(async () => '{"action": "play", "slots": [2, 3]}');
      const action = await liarsBarModule.decideAction(makeRequest(), { callModel, log: logger, remainingMs: 8000 });
      expect(callModel).toHaveBeenCalledOnce();
      expect(action).toEqual({ turn_id: 42, action: 'play', slots: [2, 3] });
    });

    it('throws when the model output fails validation', async () => {
      const callModel = vi.fn(async () => '{"action": "play", "slots": [99]}');
      await expect(
        liarsBarModule.decideAction(makeRequest(), { callModel, log: logger, remainingMs: 8000 }),
      ).rejects.toThrow('Model decision is invalid');
    });
  });

  describe('describeLiarsBarEvent', () => {
    it('describes play events and marks the bot own play', () => {
      expect(describeLiarsBarEvent({ event: 'play', name: 'Carol', count: 2, cards_left: 1 }))
        .toBe('Carol 出了 2 张牌，还剩 1 张牌。');
      expect(describeLiarsBarEvent({
        event: 'play',
        seat: 2,
        name: 'Carol',
        you: { seat: 2, name: 'Carol' },
        count: 2,
        target: 'K',
      })).toBe('你出了 2 张（声称都是 K）。');
    });

    it('describes classic challenge events', () => {
      expect(describeLiarsBarEvent({
        event: 'challenge',
        challenger: { seat: 0, name: 'Alice' },
        accused: { seat: 2, name: 'Carol' },
        revealed: ['JOKER', 'A'],
        lied: true,
        shooter: { seat: 2, name: 'Carol' },
      })).toBe('Alice 质疑了 Carol！翻牌：[JOKER、A]。Carol 撒谎属实，Carol 需接受惩罚开枪。');
    });

    it('describes a demon-card challenge with combined shooters and no single shooter', () => {
      const text = describeLiarsBarEvent({
        event: 'challenge',
        challenger: { seat: 0, name: 'Alice' },
        accused: { seat: 2, name: 'Carol' },
        revealed: ['K_devil'],
        lied: true,
        shooter: null,
        special: 'devil',
        shooters: [{ seat: 0, name: 'Alice' }, { seat: 3, name: 'Dave' }],
      });
      expect(text).toContain('翻出恶魔牌 [K_devil]');
      expect(text).toContain('Carol 不用开枪');
      expect(text).toContain('Alice、Dave 各开一枪');
    });

    it('handles revealed cards delivered as objects', () => {
      const text = describeLiarsBarEvent({
        event: 'challenge',
        challenger: { seat: 0, name: 'Alice' },
        accused: { seat: 2, name: 'Carol' },
        revealed: [{ slot: 1, card: 'CHAOS' }, { card: 'MASTER' }],
        lied: false,
        shooter: { seat: 0, name: 'Alice' },
        special: 'master',
      });
      expect(text).toContain('CHAOS、MASTER');
      expect(text).toContain('Carol 拿枪打人');
      expect(text).not.toContain('[object Object]');
    });

    it('describes shots, including shots fired at someone else', () => {
      expect(describeLiarsBarEvent({ event: 'shot', name: 'Carol', nth: 3, result: 'click' }))
        .toBe('Carol 扣动扳机（第 3 枪）……click！空枪，安然无恙。下一枪中弹概率 1/3。');
      expect(describeLiarsBarEvent({ event: 'shot', name: 'Carol', nth: 4, result: 'bang' }))
        .toBe('Carol 扣动扳机（第 4 枪）……BANG！实弹击中，不幸出局！');

      const aimedShot = describeLiarsBarEvent({
        event: 'shot',
        seat: 2,
        name: 'Carol',
        result: 'bang',
        shots_fired: 2,
        nth: 3,
        by: { seat: 0, name: 'Alice' },
      });
      expect(aimedShot).toBe('Alice 朝 Carol 扣动扳机（第 3 枪）……BANG！实弹击中，不幸出局！');
    });

    it('describes game_over with a winner or a draw', () => {
      expect(describeLiarsBarEvent({ event: 'game_over', winner: { seat: 1, name: 'Bob' } }))
        .toBe('游戏结束！胜者：Bob。');
      expect(describeLiarsBarEvent({ event: 'game_over', winner: null }))
        .toBe('游戏结束（中途散场）。');
    });

    it('returns undefined for unknown events', () => {
      expect(describeLiarsBarEvent({ event: 'something_new' })).toBeUndefined();
      expect(describeLiarsBarEvent(null)).toBeUndefined();
    });
  });

  describe('wakesBot and isGameEnd', () => {
    it('wakes on every public table event and nothing else', () => {
      for (const event of [
        { event: 'play', seat: 0, you: { seat: 2, name: 'Carol' }, count: 1 },
        { event: 'challenge' },
        { event: 'shot', result: 'click' },
        { event: 'game_over' },
      ]) expect(wakesBotLiarsBar(event)).toBe(true);
      expect(wakesBotLiarsBar({ event: 'something_new' })).toBe(false);
      expect(wakesBotLiarsBar(null)).toBe(false);
    });

    it('detects game end on game_over', () => {
      expect(isGameEndLiarsBar({ event: 'game_over' })).toBe(true);
      expect(isGameEndLiarsBar({ event: 'play' })).toBe(false);
    });
  });

  describe('scene notes stay blind', () => {
    const RULE = '出牌和选人开枪都由牌桌另行决定，聊天里你不知道自己是什么牌：别报具体牌面，别预告下一手出几张；嘴上咬定是真牌、虚张声势都行';
    const hand = [
      { slot: 1, card: 'Q_devil' },
      { slot: 2, card: 'CHAOS' },
      { slot: 3, card: 'MASTER' },
    ];
    const noCardFaces = (note: string | undefined) => {
      expect(note).toBeDefined();
      for (const face of ['Q_devil', 'CHAOS', 'MASTER', 'K_devil']) expect(note).not.toContain(face);
    };

    it('round note carries round, mode, target and hand size, never card faces', () => {
      const note = createLiarsBarRoundNote({ round: 3, mode: 'devil', max_play: 3, target: 'K', hand });
      expect(note).toBe(`轮次: 3 | 模式: devil | 目标牌: K | 一次最多出 3 张 | 手里 3 张 | ${RULE}`);
      noCardFaces(note);
    });

    it('decision note states only the public shape of a legacy play', () => {
      const note = createLiarsBarDecisionNote(
        { round: 3, target: 'K', hand },
        { turn_id: 42, action: 'play', slots: [2, 3] },
      );
      expect(note).toBe(`轮次: 3 | 目标牌: K | 手里 1 张 | 你这一手: 出 2 张，对外声称都是 K | ${RULE}`);
      noCardFaces(note);
    });

    it('decision note states the challenge and the chosen aim target', () => {
      expect(createLiarsBarDecisionNote(
        { round: 3, target: 'K', hand, players: makeRequest().players },
        { turn_id: 42, action: 'challenge' },
      )).toBe(`轮次: 3 | 目标牌: K | 手里 3 张 | 你这一手: 质疑上家 | ${RULE}`);

      expect(createLiarsBarDecisionNote(
        { round: 3, target: 'K', hand, players: makeRequest().players },
        { turn_id: 42, choice: 'aim:1' },
      )).toContain('你这一手: 选了 Bob 开枪');
    });

    it('decision note parses a play choice id without reading the hand', () => {
      expect(createLiarsBarDecisionNote(
        { round: 3, target: 'K', hand },
        { turn_id: 42, choice: 'play:1,3' },
      )).toContain('你这一手: 出 2 张，对外声称都是 K');
    });
  });
});
