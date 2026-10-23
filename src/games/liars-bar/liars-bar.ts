import * as v from 'valibot';

import type { GameAction, GameDecideDeps, GameModule } from '../types';

export interface LiarsBarCard {
  slot: number;
  card: string;
}

export interface LiarsBarPlayer {
  seat: number;
  name: string;
  alive: boolean;
  cards_left: number;
  shots_fired: number;
  is_bot: boolean;
}

export interface LiarsBarLastPlay {
  seat: number;
  name: string;
  count: number;
}

export interface LiarsBarDecideRequest {
  protocol?: number;
  seq?: number;
  game: 'liars_bar';
  match_id?: string;
  game_id?: string;
  chat_id: string;
  turn_id: number;
  you: { seat: number; name: string };
  round: number;
  target: string;
  hand: LiarsBarCard[];
  can_challenge: boolean;
  must_challenge: boolean;
  last_play: LiarsBarLastPlay | null;
  pile: number;
  players: LiarsBarPlayer[];
  log?: string[];
  chat?: { name: string; text: string }[];
  deadline_ms?: number;
}

const LiarsBarCardSchema = v.objectWithRest({
  slot: v.number(),
  card: v.string(),
}, v.unknown());

const LiarsBarPlayerSchema = v.objectWithRest({
  seat: v.number(),
  name: v.string(),
  alive: v.boolean(),
  cards_left: v.number(),
  shots_fired: v.number(),
  is_bot: v.optional(v.boolean(), false),
}, v.unknown());

export const LiarsBarDecideRequestSchema = v.objectWithRest({
  game: v.literal('liars_bar'),
  turn_id: v.number(),
  round: v.union([v.number(), v.string()]),
  target: v.string(),
  hand: v.array(LiarsBarCardSchema),
  can_challenge: v.optional(v.boolean(), false),
  must_challenge: v.optional(v.boolean(), false),
  last_play: v.optional(v.nullable(v.objectWithRest({
    seat: v.number(),
    name: v.string(),
    count: v.number(),
  }, v.unknown())), null),
  pile: v.optional(v.number(), 0),
  players: v.optional(v.array(LiarsBarPlayerSchema), []),
  log: v.optional(v.array(v.string())),
  chat: v.optional(v.array(v.objectWithRest({ name: v.string(), text: v.string() }, v.unknown()))),
  deadline_ms: v.optional(v.number()),
}, v.unknown());

export const isLiarsBarDecideRequest = (req: unknown): req is LiarsBarDecideRequest => {
  const parsed = v.safeParse(LiarsBarDecideRequestSchema, req);
  return parsed.success;
};

export const validateLiarsBarAction = (
  req: LiarsBarDecideRequest,
  action: unknown,
): action is GameAction => {
  if (!action || typeof action !== 'object') return false;
  const a = action as Record<string, unknown>;

  if (a.action === 'challenge') {
    return req.can_challenge === true;
  }

  if (a.action === 'play') {
    if (req.must_challenge) return false;
    if (!Array.isArray(a.slots) || a.slots.length < 1 || a.slots.length > 3) return false;

    const handSlots = new Set(req.hand.map(h => h.slot));
    const seenSlots = new Set<number>();
    for (const slot of a.slots) {
      if (typeof slot !== 'number' || !Number.isInteger(slot)) return false;
      if (seenSlots.has(slot)) return false;
      seenSlots.add(slot);
      if (!handSlots.has(slot)) return false;
    }
    return true;
  }

  return false;
};

export const fallbackLiarsBar = (req: LiarsBarDecideRequest): GameAction => {
  const turnId = typeof req?.turn_id === 'number' ? req.turn_id : 0;
  if (req?.must_challenge) {
    return { turn_id: turnId, action: 'challenge' };
  }

  const hand = Array.isArray(req?.hand) ? req.hand : [];
  const honest = hand
    .filter(h => h && (h.card === req?.target || h.card === 'JOKER'))
    .map(h => h.slot);

  if (req?.can_challenge && req.last_play?.count === 3 && honest.length === 0) {
    return { turn_id: turnId, action: 'challenge' };
  }

  const slots = honest.length > 0 ? honest.slice(0, 2) : (hand[0]?.slot !== undefined ? [hand[0].slot] : [1]);
  return { turn_id: turnId, action: 'play', slots };
};

export const buildLiarsBarPrompt = (req: LiarsBarDecideRequest): string => {
  const handDesc = req.hand.map(h => `Slot ${h.slot}: ${h.card}`).join(', ');
  const playersDesc = (req.players ?? []).map(p => {
    const odds = p.alive ? `1/${6 - p.shots_fired}` : 'eliminated';
    return `- ${p.name} (Seat ${p.seat}): ${p.alive ? 'alive' : 'eliminated'}, ${p.cards_left} cards left, ${p.shots_fired} shots survived, next shot lethal probability: ${odds}${p.is_bot ? ' (bot)' : ''}`;
  }).join('\n');

  const logDesc = req.log && req.log.length > 0 ? req.log.slice(-10).join('\n') : 'None';
  const chatDesc = req.chat && req.chat.length > 0
    ? req.chat.slice(-10).map(c => `${c.name}: ${c.text}`).join('\n')
    : 'None';

  const lastPlayDesc = req.last_play
    ? `${req.last_play.name} (Seat ${req.last_play.seat}) claimed to play ${req.last_play.count} ${req.target} card(s)`
    : 'None (first play of the round)';

  return `You are playing Liar's Bar (Liar's Deck mode).
Rules:
- Cards in deck: Q, K, A (6 each), Joker (2, wildcards).
- Target card for round ${req.round}: ${req.target}. Any card played face-down is claimed to be ${req.target}.
- On your turn, choose one action:
  1. "play": choose 1 to 3 card slots from your hand ([${req.hand.map(h => h.slot).join(', ')}]) to play face-down as ${req.target}.
  2. "challenge": challenge the previous player's claim. Only valid when can_challenge is true. If they lied, they shoot themselves; otherwise you shoot yourself.
- If must_challenge is true, you MUST challenge.
- If can_challenge is false, you CANNOT challenge.

Current Table State:
- Round: ${req.round}
- Target: ${req.target}
- Your Hand: ${handDesc}
- Can Challenge: ${req.can_challenge}
- Must Challenge: ${req.must_challenge}
- Last Play: ${lastPlayDesc}
- Claimed Target Cards in Pile: ${req.pile}

Players:
${playersDesc || 'None'}

Recent Table Broadcast:
${logDesc}

Recent Chat in Group:
${chatDesc}

Requirements:
- If must_challenge is true, you must choose challenge.
- If can_challenge is false, you cannot choose challenge.
- If playing, choose 1 to 3 distinct valid slot numbers from your hand.
- You can play honest cards (${req.target} or Joker) or bluff (play cards other than ${req.target}).

Output format:
Respond ONLY with a JSON object:
{"action": "play", "slots": [slot1, ...]}
or
{"action": "challenge"}
Do not output markdown code blocks or explanations.`;
};

export const parseLiarsBarResponse = (raw: string): unknown => {
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch?.[1]) {
    cleaned = fenceMatch[1].trim();
  }
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch?.[0]) {
    cleaned = jsonMatch[0];
  }
  return JSON.parse(cleaned);
};

export const describeLiarsBarEvent = (event: unknown): string | undefined => {
  if (!event || typeof event !== 'object') return undefined;
  const e = event as Record<string, unknown>;
  const eventType = e.event;

  const youSeat = typeof e.you === 'object' && e.you !== null
    ? (e.you as { seat?: number }).seat
    : undefined;

  if (eventType === 'play') {
    const isYou = youSeat !== undefined && e.seat === youSeat;
    const name = String(e.name ?? 'Someone');
    const count = Number(e.count ?? 0);
    const cardsLeft = Number(e.cards_left ?? 0);
    const target = e.target ? String(e.target) : undefined;
    const claim = target ? `（声称都是 ${target}）` : '';

    if (isYou) {
      const cardsLeftText = e.cards_left !== undefined ? `，还剩 ${cardsLeft} 张牌` : '';
      return `你出了 ${count} 张${claim}${cardsLeftText}。`;
    }

    return `${name} 出了 ${count} 张牌${claim}，还剩 ${cardsLeft} 张牌。`;
  }

  if (eventType === 'challenge') {
    const challenger = (e.challenger as Record<string, unknown> | undefined)?.name ?? 'Someone';
    const accused = (e.accused as Record<string, unknown> | undefined)?.name ?? 'Someone';
    const revealed = Array.isArray(e.revealed) ? e.revealed.join(', ') : '';
    const lied = e.lied === true;
    const shooter = (e.shooter as Record<string, unknown> | undefined)?.name ?? (lied ? accused : challenger);
    const liedDesc = lied ? `${accused} 撒谎属实` : `${accused} 没有撒谎`;
    return `${challenger} 质疑了 ${accused}！翻牌：[${revealed}]。${liedDesc}，${shooter} 需接受惩罚开枪。`;
  }

  if (eventType === 'shot') {
    const isYou = youSeat !== undefined && e.seat === youSeat;
    const name = isYou ? '你' : String(e.name ?? 'Someone');
    const nth = Number(e.nth ?? e.shots_fired ?? 1);
    const result = String(e.result ?? '');

    if (result === 'click') {
      const shotsFired = Number(e.shots_fired ?? e.nth ?? 1);
      const odds = Number.isInteger(shotsFired) && shotsFired >= 0 && shotsFired < 6
        ? `下一枪中弹概率 1/${6 - shotsFired}。`
        : '';
      return `${name} 扣动扳机（第 ${nth} 枪）……click！空枪，安然无恙。${odds}`.trim();
    }
    if (result === 'bang') {
      return `${name} 扣动扳机（第 ${nth} 枪）……BANG！实弹击中，不幸出局！`;
    }
    if (result === 'misfire') {
      return `${name} 扣动扳机（第 ${nth} 枪）……咔！哑火！幸免于难，重新装弹。`;
    }
    return `${name} 扣动扳机（第 ${nth} 枪）……${result}。`;
  }

  if (eventType === 'game_over') {
    const winner = (e.winner as Record<string, unknown> | null | undefined);
    if (winner && typeof winner === 'object') {
      const isYou = youSeat !== undefined && winner.seat === youSeat;
      const winnerName = isYou ? '你' : String(winner.name ?? 'Someone');
      return `游戏结束！胜者：${winnerName}。`;
    }
    return '游戏结束（中途散场）。';
  }

  return undefined;
};

// Every public table event wakes the bot (owner choice: an active table
// talker). Whether it actually speaks is left to the probe and the table
// scene's brake; events that arrive while a turn runs are batched into the
// next wake-up, so this does not queue one turn per event.
const WAKING_EVENTS: ReadonlySet<string> = new Set(['play', 'challenge', 'shot', 'game_over']);

export const wakesBotLiarsBar = (event: unknown): boolean => {
  if (!event || typeof event !== 'object') return false;
  const eventType = (event as Record<string, unknown>).event;
  return typeof eventType === 'string' && WAKING_EVENTS.has(eventType);
};

export const isGameEndLiarsBar = (event: unknown): boolean => {
  if (!event || typeof event !== 'object') return false;
  return (event as Record<string, unknown>).event === 'game_over';
};

const formatHandCards = (hand: unknown): string => {
  if (!Array.isArray(hand)) return '';
  return hand
    .map(h => (typeof h === 'object' && h !== null && 'card' in h ? String((h as { card: unknown }).card) : String(h)))
    .join(', ');
};

export const createLiarsBarRoundNote = (req: unknown): string | undefined => {
  if (!req || typeof req !== 'object') return undefined;
  const r = req as Record<string, unknown>;
  const round = r.round ?? 1;
  const target = r.target ?? '未知';
  const handStr = formatHandCards(r.hand);
  return `轮次: ${round} | 目标牌: ${target} | 当前手牌: [${handStr}]`;
};

export const createLiarsBarDecisionNote = (req: unknown, action: GameAction): string | undefined => {
  if (!req || typeof req !== 'object') return undefined;
  const r = req as Record<string, unknown>;
  const round = r.round ?? 1;
  const target = String(r.target ?? '未知');
  const rawHand = Array.isArray(r.hand) ? (r.hand as Array<{ slot?: number; card?: string }>) : [];

  if (action.action === 'challenge') {
    const handStr = formatHandCards(rawHand);
    return `轮次: ${round} | 目标牌: ${target} | 当前手牌: [${handStr}] | 上一手: 质疑`;
  }

  if (action.action === 'play') {
    const playedSlots = new Set(Array.isArray(action.slots) ? action.slots : []);
    const playedCards = rawHand.filter(h => h?.slot !== undefined && playedSlots.has(h.slot));
    const remainingCards = rawHand.filter(h => h?.slot !== undefined && !playedSlots.has(h.slot));

    const isHonest = playedCards.length > 0 && playedCards.every(h => h.card === target || h.card === 'JOKER');
    const honestyStr = isHonest ? '真牌' : '诈唬';
    const playedStr = formatHandCards(playedCards);
    const remainingStr = formatHandCards(remainingCards);

    return `轮次: ${round} | 目标牌: ${target} | 当前手牌: [${remainingStr}] | 上一手: 出牌 [${playedStr}]（${honestyStr}）`;
  }

  return undefined;
};

export const liarsBarModule: GameModule = {
  id: 'liars_bar',

  async decide(req: unknown, deps: GameDecideDeps): Promise<GameAction> {
    if (!isLiarsBarDecideRequest(req)) {
      throw new Error('Invalid LiarsBar decide request shape');
    }
    const prompt = buildLiarsBarPrompt(req);
    const timeoutSec = Math.max(1, Math.floor(deps.remainingMs / 1000));
    const raw = await deps.callModel(prompt, { timeoutSec });
    const parsed = parseLiarsBarResponse(raw);
    if (!validateLiarsBarAction(req, parsed)) {
      throw new Error(`Model decision is invalid for current table state: ${JSON.stringify(parsed)}`);
    }
    return { turn_id: req.turn_id, ...parsed };
  },

  fallback(req: unknown): GameAction {
    if (!isLiarsBarDecideRequest(req)) {
      const turnId = (req as Record<string, unknown>)?.turn_id;
      return {
        turn_id: typeof turnId === 'number' ? turnId : 0,
        action: 'challenge',
      };
    }
    return fallbackLiarsBar(req);
  },

  validate(req: unknown, action: unknown): action is GameAction {
    if (!isLiarsBarDecideRequest(req)) return false;
    return validateLiarsBarAction(req, action);
  },

  describeEvent(event: unknown): string | undefined {
    return describeLiarsBarEvent(event);
  },

  wakesBot(event: unknown): boolean {
    return wakesBotLiarsBar(event);
  },

  isGameEnd(event: unknown): boolean {
    return isGameEndLiarsBar(event);
  },

  createRoundNote(req: unknown): string | undefined {
    return createLiarsBarRoundNote(req);
  },

  createDecisionNote(req: unknown, action: GameAction): string | undefined {
    return createLiarsBarDecisionNote(req, action);
  },
};
