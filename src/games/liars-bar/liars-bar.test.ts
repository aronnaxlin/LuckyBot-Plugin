import { describe, expect, it, vi } from 'vitest';

import {
  buildLiarsBarPrompt,
  createLiarsBarDecisionNote,
  createLiarsBarRoundNote,
  describeLiarsBarEvent,
  fallbackLiarsBar,
  isGameEndLiarsBar,
  liarsBarModule,
  parseLiarsBarResponse,
  validateLiarsBarAction,
  wakesBotLiarsBar,
  type LiarsBarDecideRequest,
} from './liars-bar';

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
    { seat: 1, name: 'Bob', alive: true, cards_left: 2, shots_fired: 0, is_bot: true },
    { seat: 2, name: 'Carol', alive: true, cards_left: 3, shots_fired: 2, is_bot: true },
  ],
  log: ['Round 3 started, target card K'],
  chat: [{ name: 'Alice', text: 'Carol definitely does not have a K' }],
  deadline_ms: 15000,
  ...overrides,
});

describe("Liar's Bar module (de-identified)", () => {
  describe('validateLiarsBarAction', () => {
    it('accepts valid play actions with distinct current slots', () => {
      const req = makeRequest();
      expect(validateLiarsBarAction(req, { action: 'play', slots: [2] })).toBe(true);
      expect(validateLiarsBarAction(req, { action: 'play', slots: [2, 3] })).toBe(true);
      expect(validateLiarsBarAction(req, { action: 'play', slots: [1, 2, 5] })).toBe(true);
    });

    it('rejects play with slots not in hand', () => {
      const req = makeRequest({ hand: [{ slot: 1, card: 'K' }] });
      expect(validateLiarsBarAction(req, { action: 'play', slots: [2] })).toBe(false);
      expect(validateLiarsBarAction(req, { action: 'play', slots: [1, 2] })).toBe(false);
    });

    it('rejects play with duplicate slots', () => {
      const req = makeRequest();
      expect(validateLiarsBarAction(req, { action: 'play', slots: [2, 2] })).toBe(false);
    });

    it('rejects play with 0 or more than 3 slots', () => {
      const req = makeRequest();
      expect(validateLiarsBarAction(req, { action: 'play', slots: [] })).toBe(false);
      expect(validateLiarsBarAction(req, { action: 'play', slots: [1, 2, 3, 4] })).toBe(false);
    });

    it('rejects play when must_challenge is true', () => {
      const req = makeRequest({ must_challenge: true });
      expect(validateLiarsBarAction(req, { action: 'play', slots: [2] })).toBe(false);
    });

    it('validates challenge action based on can_challenge', () => {
      const allowedReq = makeRequest({ can_challenge: true });
      expect(validateLiarsBarAction(allowedReq, { action: 'challenge' })).toBe(true);

      const forbiddenReq = makeRequest({ can_challenge: false });
      expect(validateLiarsBarAction(forbiddenReq, { action: 'challenge' })).toBe(false);
    });

    it('rejects unknown or malformed actions', () => {
      const req = makeRequest();
      expect(validateLiarsBarAction(req, null)).toBe(false);
      expect(validateLiarsBarAction(req, {})).toBe(false);
      expect(validateLiarsBarAction(req, { action: 'pass' })).toBe(false);
      expect(validateLiarsBarAction(req, { action: 'play', slots: '1' })).toBe(false);
    });
  });

  describe('fallbackLiarsBar', () => {
    it('is deterministic for the same input', () => {
      const req = makeRequest();
      const first = fallbackLiarsBar(req);
      const second = fallbackLiarsBar(req);
      expect(first).toEqual(second);
    });

    it('forces challenge when must_challenge is true', () => {
      const req = makeRequest({ must_challenge: true });
      expect(fallbackLiarsBar(req)).toEqual({ turn_id: 42, action: 'challenge' });
    });

    it('challenges when last play claimed 3 cards and holding no honest cards', () => {
      const req = makeRequest({
        target: 'K',
        hand: [{ slot: 1, card: 'Q' }, { slot: 4, card: 'A' }],
        last_play: { seat: 1, name: 'Bob', count: 3 },
        can_challenge: true,
      });
      expect(fallbackLiarsBar(req)).toEqual({ turn_id: 42, action: 'challenge' });
    });

    it('plays honest cards first when available', () => {
      const req = makeRequest({
        target: 'K',
        hand: [{ slot: 1, card: 'Q' }, { slot: 2, card: 'K' }, { slot: 3, card: 'JOKER' }],
        last_play: { seat: 1, name: 'Bob', count: 3 },
      });
      expect(fallbackLiarsBar(req)).toEqual({ turn_id: 42, action: 'play', slots: [2, 3] });
    });

    it('plays the first card when no honest cards are available and not challenging', () => {
      const req = makeRequest({
        target: 'K',
        hand: [{ slot: 1, card: 'Q' }, { slot: 4, card: 'A' }],
        last_play: { seat: 1, name: 'Bob', count: 1 },
      });
      expect(fallbackLiarsBar(req)).toEqual({ turn_id: 42, action: 'play', slots: [1] });
    });
  });

  describe('buildLiarsBarPrompt', () => {
    it('formats target, hand slots, and player odds into the prompt without real names', () => {
      const req = makeRequest();
      const prompt = buildLiarsBarPrompt(req);
      expect(prompt).toContain('Target card for round 3: K');
      expect(prompt).toContain('Slot 1: Q, Slot 2: K, Slot 3: JOKER, Slot 4: A, Slot 5: K');
      expect(prompt).toContain('next shot lethal probability: 1/5');
      expect(prompt).toContain('Alice (Seat 0)');
      expect(prompt).toContain('Bob (Seat 1)');
      // Assert prompt contains only the names declared in the request fixture
      const fixtureNames = new Set(req.players.map(p => p.name).concat(req.you.name));
      const extractedNames = [...prompt.matchAll(/- ([A-Za-z]+) \(Seat/g)].map(m => m[1]);
      for (const name of extractedNames) {
        expect(fixtureNames.has(name!)).toBe(true);
      }
    });
  });

  describe('parseLiarsBarResponse', () => {
    it('parses raw JSON strings', () => {
      expect(parseLiarsBarResponse('{"action": "challenge"}')).toEqual({ action: 'challenge' });
      expect(parseLiarsBarResponse('{"action": "play", "slots": [1, 2]}')).toEqual({ action: 'play', slots: [1, 2] });
    });

    it('extracts JSON from markdown code fences', () => {
      const raw = '```json\n{"action": "play", "slots": [3]}\n```';
      expect(parseLiarsBarResponse(raw)).toEqual({ action: 'play', slots: [3] });
    });
  });

  describe('decide via liarsBarModule', () => {
    it('invokes callModel and returns validated action', async () => {
      const req = makeRequest();
      const callModel = vi.fn(async () => '{"action": "play", "slots": [2, 3]}');
      const action = await liarsBarModule.decide(req, {
        callModel,
        log: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withFields: vi.fn(), withError: vi.fn() } as any,
        remainingMs: 8000,
      });

      expect(callModel).toHaveBeenCalledOnce();
      expect(action).toEqual({ turn_id: 42, action: 'play', slots: [2, 3] });
    });

    it('throws if model output fails validation', async () => {
      const req = makeRequest();
      const callModel = vi.fn(async () => '{"action": "play", "slots": [99]}');
      await expect(
        liarsBarModule.decide(req, {
          callModel,
          log: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withFields: vi.fn(), withError: vi.fn() } as any,
          remainingMs: 8000,
        }),
      ).rejects.toThrow('Model decision is invalid');
    });
  });

  describe('describeLiarsBarEvent', () => {
    it('describes play events', () => {
      const text = describeLiarsBarEvent({
        event: 'play',
        name: 'Carol',
        count: 2,
        cards_left: 1,
      });
      expect(text).toBe('Carol 出了 2 张牌，还剩 1 张牌。');
    });

    it('marks bot own play event with claim in Chinese', () => {
      const ownPlay = describeLiarsBarEvent({
        event: 'play',
        seat: 2,
        name: 'Carol',
        you: { seat: 2, name: 'Carol' },
        count: 2,
        target: 'K',
      });
      expect(ownPlay).toBe('你出了 2 张（声称都是 K）。');

      const ownPlayWithCardsLeft = describeLiarsBarEvent({
        event: 'play',
        seat: 2,
        name: 'Carol',
        you: { seat: 2, name: 'Carol' },
        count: 2,
        cards_left: 1,
        target: 'K',
      });
      expect(ownPlayWithCardsLeft).toBe('你出了 2 张（声称都是 K），还剩 1 张牌。');
    });

    it('describes challenge events (lied)', () => {
      const text = describeLiarsBarEvent({
        event: 'challenge',
        challenger: { seat: 0, name: 'Alice' },
        accused: { seat: 2, name: 'Carol' },
        revealed: ['JOKER', 'A'],
        lied: true,
        shooter: { seat: 2, name: 'Carol' },
      });
      expect(text).toBe('Alice 质疑了 Carol！翻牌：[JOKER, A]。Carol 撒谎属实，Carol 需接受惩罚开枪。');
    });

    it('describes shot events with public odds after click', () => {
      expect(describeLiarsBarEvent({ event: 'shot', name: 'Carol', nth: 3, result: 'click' }))
        .toBe('Carol 扣动扳机（第 3 枪）……click！空枪，安然无恙。下一枪中弹概率 1/3。');
      expect(describeLiarsBarEvent({ event: 'shot', name: 'Carol', nth: 4, result: 'bang' }))
        .toBe('Carol 扣动扳机（第 4 枪）……BANG！实弹击中，不幸出局！');
    });

    it('describes game_over events', () => {
      expect(describeLiarsBarEvent({ event: 'game_over', winner: { seat: 1, name: 'Bob' } }))
        .toBe('游戏结束！胜者：Bob。');
      expect(describeLiarsBarEvent({ event: 'game_over', winner: null }))
        .toBe('游戏结束（中途散场）。');
    });
  });

  describe('wakesBot and isGameEnd', () => {
    it('wakes on every public table event and nothing else', () => {
      for (const event of [
        { event: 'play', seat: 0, you: { seat: 2, name: 'Carol' }, count: 1 },
        { event: 'play', seat: 2, you: { seat: 2, name: 'Carol' }, count: 2 },
        { event: 'challenge' },
        { event: 'shot', result: 'click' },
        { event: 'shot', result: 'misfire' },
        { event: 'shot', result: 'bang' },
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

  describe('createLiarsBarRoundNote and createLiarsBarDecisionNote', () => {
    const RULE = '出牌由牌桌另行决定，聊天里你不知道自己是什么牌：别报具体牌面，别预告下一手出几张；嘴上咬定是真牌、虚张声势都行';
    const hand = [
      { slot: 1, card: 'QUEEN_X' },
      { slot: 2, card: 'KING_X' },
      { slot: 3, card: 'JOKER_X' },
    ];
    const noCardFaces = (note: string | undefined) => {
      expect(note).toBeDefined();
      for (const face of ['QUEEN_X', 'KING_X', 'JOKER_X', '真牌）', '诈唬']) expect(note).not.toContain(face);
    };

    it('round note carries round, target and hand size, never card faces', () => {
      const note = createLiarsBarRoundNote({ round: 3, target: 'K', hand });
      expect(note).toBe(`轮次: 3 | 目标牌: K | 手里 3 张 | ${RULE}`);
      noCardFaces(note);
    });

    it('play note says what the table saw, not which cards or whether it was honest', () => {
      const note = createLiarsBarDecisionNote({ round: 3, target: 'K', hand }, { action: 'play', slots: [1, 3] });
      expect(note).toBe(`轮次: 3 | 目标牌: K | 手里 1 张 | 你这一手: 出 2 张，对外声称都是 K | ${RULE}`);
      noCardFaces(note);
    });

    it('challenge note keeps the hand size and hides the cards', () => {
      const note = createLiarsBarDecisionNote({ round: 3, target: 'K', hand }, { action: 'challenge' });
      expect(note).toBe(`轮次: 3 | 目标牌: K | 手里 3 张 | 你这一手: 质疑上家 | ${RULE}`);
      noCardFaces(note);
    });
  });
});
