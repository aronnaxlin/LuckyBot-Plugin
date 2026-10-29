import * as v from 'valibot';

import type { GameDecideDeps, GameLegacyReply, GameModule, GameReply } from '../types';
import { gameChoiceIds, isChoiceReply, parseJsonResponse, randomChoiceId } from '../types';

export type LiarsBarMode = 'classic' | 'devil' | 'chaos';

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

export interface LiarsBarAim {
  kind?: string;
  targets?: Array<number | { seat: number; name?: string }>;
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
  mode?: string;
  max_play?: number;
  devil_card?: string | null;
  hand: LiarsBarCard[];
  can_challenge: boolean;
  must_challenge: boolean;
  last_play: LiarsBarLastPlay | null;
  pile: number;
  players: LiarsBarPlayer[];
  log?: string[];
  chat?: { name: string; text: string }[];
  ask?: string;
  prompt?: string;
  rules?: string;
  choices?: { id: string; say: string }[];
  aim?: LiarsBarAim;
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
  mode: v.optional(v.string()),
  max_play: v.optional(v.number()),
  devil_card: v.optional(v.nullable(v.string())),
  log: v.optional(v.array(v.string())),
  chat: v.optional(v.array(v.objectWithRest({ name: v.string(), text: v.string() }, v.unknown()))),
  ask: v.optional(v.string()),
  prompt: v.optional(v.string()),
  rules: v.optional(v.string()),
  choices: v.optional(v.array(v.objectWithRest({ id: v.string(), say: v.string() }, v.unknown()))),
  aim: v.optional(v.objectWithRest({
    kind: v.optional(v.string()),
    targets: v.optional(v.array(v.union([
      v.number(),
      v.objectWithRest({ seat: v.number(), name: v.optional(v.string()) }, v.unknown()),
    ]))),
  }, v.unknown())),
  deadline_ms: v.optional(v.number()),
}, v.unknown());

export const isLiarsBarDecideRequest = (req: unknown): req is LiarsBarDecideRequest => {
  const parsed = v.safeParse(LiarsBarDecideRequestSchema, req);
  return parsed.success;
};

const isDevilMarkedCard = (card: string): boolean => /^(?:Q|K|A)_devil$/.test(card);

const DEFAULT_LIARS_BAR_RULES = '你在飞书群里玩《骗子酒馆》的出牌模式。牌堆 Q、K、A 各 6 张，Joker 2 张（万能，算作目标牌）。每小局随机定一张目标牌，每人 5 张。轮到你时二选一：扣着出 1–3 张并声称“都是目标牌”（可以撒谎），或者质疑上一家。质疑翻开上一家刚出的牌：有一张既不是目标牌也不是 Joker，就是他撒谎，他开枪；全是真的，质疑的人开枪。中弹出局，活到最后的人赢。';

export const liarsBarMode = (req: LiarsBarDecideRequest): LiarsBarMode => {
  if (req.mode === 'devil' || req.mode === 'chaos') return req.mode;
  return 'classic';
};

export const liarsBarMaxPlay = (req: LiarsBarDecideRequest): number => {
  if (typeof req.max_play === 'number' && Number.isInteger(req.max_play) && req.max_play >= 1) {
    return req.max_play;
  }
  return liarsBarMode(req) === 'chaos' ? 1 : 3;
};

export const liarsBarAimTargets = (req: LiarsBarDecideRequest): number[] => {
  const targets = req.aim?.targets;
  if (!Array.isArray(targets)) return [];
  const seats: number[] = [];
  for (const target of targets) {
    const seat = typeof target === 'number'
      ? target
      : target && typeof target === 'object' && typeof (target as Record<string, unknown>).seat === 'number'
        ? ((target as Record<string, unknown>).seat as number)
        : undefined;
    if (seat !== undefined && !seats.includes(seat)) seats.push(seat);
  }
  return seats;
};

const shotsFiredOf = (req: LiarsBarDecideRequest, seat: number): number =>
  req.players.find(p => p.seat === seat)?.shots_fired ?? 0;

export const pickLiarsBarAimTarget = (req: LiarsBarDecideRequest): number | undefined => {
  const targets = liarsBarAimTargets(req).filter(seat => seat !== req.you.seat);
  const pool = targets.length > 0 ? targets : liarsBarAimTargets(req);
  if (pool.length === 0) return undefined;
  const alive = new Set(req.players.filter(p => p.alive).map(p => p.seat));
  const living = pool.filter(seat => alive.size === 0 || alive.has(seat));
  const candidates = living.length > 0 ? living : pool;
  return [...candidates].sort((a, b) => shotsFiredOf(req, b) - shotsFiredOf(req, a) || a - b)[0];
};

export const validateLiarsBarAction = (
  req: LiarsBarDecideRequest,
  reply: unknown,
): reply is GameLegacyReply => {
  if (!reply || typeof reply !== 'object') return false;
  const action = reply as Record<string, unknown>;

  if (req.ask === 'aim') {
    return typeof action.target === 'number'
      && Number.isInteger(action.target)
      && liarsBarAimTargets(req).includes(action.target);
  }

  if (action.action === 'challenge') {
    return req.can_challenge === true;
  }

  if (action.action === 'play') {
    if (req.must_challenge) return false;
    const maxPlay = liarsBarMaxPlay(req);
    if (!Array.isArray(action.slots) || action.slots.length < 1 || action.slots.length > maxPlay) return false;

    const cardsBySlot = new Map(req.hand.map(h => [h.slot, h.card]));
    const seenSlots = new Set<number>();
    let playsDevil = false;
    for (const slot of action.slots) {
      if (typeof slot !== 'number' || !Number.isInteger(slot)) return false;
      if (seenSlots.has(slot)) return false;
      seenSlots.add(slot);
      if (!cardsBySlot.has(slot)) return false;
      const card = cardsBySlot.get(slot) ?? '';
      if (card === req.devil_card || isDevilMarkedCard(card)) playsDevil = true;
    }
    // 恶魔牌只能单出，不论 max_play 是多少。
    if (playsDevil && action.slots.length !== 1) return false;
    return true;
  }

  return false;
};

export const fallbackLiarsBar = (req: LiarsBarDecideRequest): GameLegacyReply => {
  const turnId = typeof req?.turn_id === 'number' ? req.turn_id : 0;

  if (req?.ask === 'aim') {
    const target = pickLiarsBarAimTarget(req);
    if (target !== undefined) return { turn_id: turnId, target };
  }

  if (req?.must_challenge) {
    return { turn_id: turnId, action: 'challenge' };
  }

  const hand = Array.isArray(req?.hand) ? req.hand : [];
  const maxPlay = liarsBarMaxPlay(req);
  const honest = hand
    .filter(h => h && (h.card === req?.target || h.card === 'JOKER'))
    .slice(0, maxPlay)
    .map(h => h.slot);

  if (honest.length > 0) {
    return { turn_id: turnId, action: 'play', slots: honest };
  }

  if (req?.can_challenge && req.last_play?.count !== undefined && req.last_play.count >= maxPlay) {
    return { turn_id: turnId, action: 'challenge' };
  }

  const devil = hand.find(h => h.card === req.devil_card)
    ?? hand.find(h => isDevilMarkedCard(h.card));
  if (devil) {
    return { turn_id: turnId, action: 'play', slots: [devil.slot] };
  }

  if (hand[0]) {
    return { turn_id: turnId, action: 'play', slots: [hand[0].slot] };
  }

  return { turn_id: turnId, action: 'challenge' };
};

const playChoiceSlots = (id: string): number[] | undefined => {
  if (!id.startsWith('play:')) return undefined;
  return id.slice('play:'.length).split(',')
    .map(part => Number.parseInt(part, 10))
    .filter(value => !Number.isNaN(value));
};

// The dealer lists the same set of cards only once (ChoiceFields.choices), so
// the heuristic's exact slots may be missing while an equivalent play exists:
// match on the card faces when the slots differ.
const findPlayChoiceId = (
  ids: readonly string[],
  slots: readonly number[],
  hand: readonly LiarsBarCard[],
): string | undefined => {
  const sortedKey = (values: readonly (number | string)[]): string => [...values].map(String).sort().join(',');
  const wanted = sortedKey(slots);
  const exact = ids.find(id => {
    const parts = playChoiceSlots(id);
    return parts?.length === slots.length && sortedKey(parts) === wanted;
  });
  if (exact) return exact;

  const cardOf = new Map(hand.map(h => [h.slot, h.card]));
  const wantedCards = sortedKey(slots.map(slot => cardOf.get(slot) ?? '?'));
  return ids.find(id => {
    const parts = playChoiceSlots(id);
    return parts?.length === slots.length
      && parts.every(slot => cardOf.has(slot))
      && sortedKey(parts.map(slot => cardOf.get(slot) ?? '?')) === wantedCards;
  });
};

const findChoiceIdForLegacy = (
  ids: readonly string[],
  reply: GameLegacyReply,
  hand: readonly LiarsBarCard[],
): string | undefined => {
  if ('target' in reply) return ids.find(id => id === `aim:${reply.target}`);
  if (reply.action === 'challenge') return ids.find(id => id === 'challenge');
  if (reply.action === 'play' && Array.isArray(reply.slots)) {
    const slots = reply.slots.filter((slot): slot is number => typeof slot === 'number');
    return findPlayChoiceId(ids, slots, hand);
  }
  return undefined;
};

export const describeLiarsBarState = (req: LiarsBarDecideRequest): string => {
  const mode = liarsBarMode(req);
  const maxPlay = liarsBarMaxPlay(req);
  const lines: string[] = [
    `模式: ${mode} | 小局: ${req.round} | 目标牌: ${req.target} | 一次最多出 ${maxPlay} 张`,
    `你的手牌: ${req.hand.map(h => `${h.slot} 号位=${h.card}`).join('，') || '无'}`,
  ];

  if (req.devil_card) lines.push(`本小局的恶魔牌: ${req.devil_card}（只能单出）`);
  lines.push(`可质疑: ${req.can_challenge} | 必须质疑: ${req.must_challenge} | 本小局声称出的目标牌总数: ${req.pile}`);
  lines.push(req.last_play
    ? `上一手: ${req.last_play.name}（座位 ${req.last_play.seat}）声称出了 ${req.last_play.count} 张`
    : '上一手: 无（本小局第一手）');

  if (req.ask === 'aim') {
    lines.push(`现在要选人开枪（${req.aim?.kind ?? 'aim'}），能打的人: 座位 ${liarsBarAimTargets(req).join('、') || '无'}`);
  }

  if (req.players.length > 0) {
    lines.push('玩家:');
    for (const player of req.players) {
      const odds = player.alive ? `1/${Math.max(1, 6 - player.shots_fired)}` : '-';
      lines.push(`- ${player.name}（座位 ${player.seat}）: ${player.alive ? '存活' : '出局'}，剩 ${player.cards_left} 张牌，已空枪 ${player.shots_fired} 次，下一枪中弹概率 ${odds}${player.is_bot ? '（机器人）' : ''}`);
    }
  }

  if (req.log && req.log.length > 0) lines.push(`最近播报:\n${req.log.slice(-10).join('\n')}`);
  if (req.chat && req.chat.length > 0) {
    lines.push(`群里最近的发言:\n${req.chat.slice(-10).map(c => `${c.name}: ${c.text}`).join('\n')}`);
  }

  return lines.join('\n');
};

export const buildLiarsBarPrompt = (req: LiarsBarDecideRequest): string => {
  const rules = req.rules?.trim() ?? DEFAULT_LIARS_BAR_RULES;
  const instruction = req.ask === 'aim'
    ? '请选一个能开枪的目标，只回 JSON：{"target": <座位号>}'
    : '请选一个动作，只回 JSON：{"action": "play", "slots": [<位置号>, ...]} 或 {"action": "challenge"}。不要输出 markdown 或解释。';

  return `${rules}

当前局面（只有你看得到）：
${describeLiarsBarState(req)}

${instruction}`;
};

export const parseLiarsBarResponse = (raw: string): unknown => parseJsonResponse(raw);

const seatName = (value: unknown, fallback = '某人'): string => {
  if (value && typeof value === 'object') {
    const name = (value as Record<string, unknown>).name;
    if (typeof name === 'string' && name.length > 0) return name;
    const seat = (value as Record<string, unknown>).seat;
    if (typeof seat === 'number') return `座位 ${seat}`;
  }
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number') return `座位 ${value}`;
  return fallback;
};

const seatNames = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.map(item => seatName(item)).filter(name => name.length > 0);
};

const revealedCardName = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.card === 'string') return record.card;
    if (typeof record.name === 'string') return record.name;
    if (typeof record.slot === 'number') return `${record.slot} 号位`;
  }
  return undefined;
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
    const challenger = seatName(e.challenger);
    const accused = seatName(e.accused);
    const revealed = Array.isArray(e.revealed)
      ? e.revealed.map(revealedCardName).filter((card): card is string => Boolean(card))
      : [];
    const revealedText = revealed.join('、');
    const special = typeof e.special === 'string' ? e.special : undefined;
    const shooters = seatNames(e.shooters);

    if (special === 'devil') {
      return `${challenger} 质疑了 ${accused}，翻出恶魔牌 [${revealedText}]！${accused} 不用开枪，${shooters.join('、') || '其他还有牌的人'} 各开一枪。`;
    }
    if (special === 'lie') {
      return `${challenger} 质疑了 ${accused}，翻牌 [${revealedText}]。${accused} 撒谎，${shooters.join('、') || challenger} 拿枪打人。`;
    }
    if (special === 'master') {
      return `${challenger} 质疑了 ${accused}，翻出主宰牌 [${revealedText}]。${accused} 拿枪打人。`;
    }
    if (special === 'chaos') {
      return `${challenger} 质疑了 ${accused}，翻出混沌牌 [${revealedText}]。${shooters.join('、') || '所有活着的人'} 同时选人开枪。`;
    }

    const lied = e.lied === true;
    const shooter = e.shooter && typeof e.shooter === 'object'
      ? seatName(e.shooter)
      : (lied ? accused : challenger);
    const liedDesc = lied ? `${accused} 撒谎属实` : `${accused} 没有撒谎`;
    return `${challenger} 质疑了 ${accused}！翻牌：[${revealedText}]。${liedDesc}，${shooter} 需接受惩罚开枪。`;
  }

  if (eventType === 'shot') {
    const result = String(e.result ?? '');
    const nth = Number(e.nth ?? e.shots_fired ?? 1);
    const by = e.by && typeof e.by === 'object' ? e.by : undefined;
    const targetName = String(e.name ?? 'Someone');

    const gunText = result === 'click'
      ? (() => {
          const shotsFired = Number(e.shots_fired ?? nth ?? 1);
          const odds = Number.isInteger(shotsFired) && shotsFired >= 0 && shotsFired < 6
            ? `下一枪中弹概率 1/${6 - shotsFired}。`
            : '';
          return `click！空枪，安然无恙。${odds}`.trim();
        })()
      : result === 'bang'
        ? 'BANG！实弹击中，不幸出局！'
        : result === 'misfire'
          ? '咔！哑火！幸免于难，重新装弹。'
          : `${result}。`;

    if (by) {
      const byIsYou = youSeat !== undefined && (by as Record<string, unknown>).seat === youSeat;
      const byName = byIsYou ? '你' : seatName(by);
      const victimName = youSeat !== undefined && e.seat === youSeat ? '你' : targetName;
      return `${byName} 朝 ${victimName} 扣动扳机（第 ${nth} 枪）……${gunText}`;
    }

    const isYou = youSeat !== undefined && e.seat === youSeat;
    const name = isYou ? '你' : targetName;
    return `${name} 扣动扳机（第 ${nth} 枪）……${gunText}`;
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

// The table talker (primary) never sees card faces or whether its own play
// was honest. In two live games (2026-10-24) it read both from the note and
// said them aloud ("两张 Q，都是真的", "我手上只剩一张 A"), and the humans
// played against that. A prompt rule did not stop it, so the note carries
// only what the bot already showed the table. Plays are decided separately by
// the decision path; the note also says so, because the talker kept
// announcing moves ("跟两张") that the decision then contradicted.
const TALKER_RULE = '出牌和选人开枪都由牌桌另行决定，聊天里你不知道自己是什么牌：别报具体牌面，别预告下一手出几张；嘴上咬定是真牌、虚张声势都行';

const handCount = (hand: unknown): number => (Array.isArray(hand) ? hand.length : 0);

const roundOf = (req: Record<string, unknown>): unknown => req.round ?? 1;

export const createLiarsBarRoundNote = (req: unknown): string | undefined => {
  if (!req || typeof req !== 'object') return undefined;
  const r = req as Record<string, unknown>;
  const mode = typeof r.mode === 'string' ? r.mode : 'classic';
  const maxPlay = typeof r.max_play === 'number' && Number.isInteger(r.max_play) && r.max_play >= 1
    ? r.max_play
    : mode === 'chaos' ? 1 : 3;
  return `轮次: ${roundOf(r)} | 模式: ${mode} | 目标牌: ${r.target ?? '未知'} | 一次最多出 ${maxPlay} 张 | 手里 ${handCount(r.hand)} 张 | ${TALKER_RULE}`;
};

const nameForSeat = (req: Record<string, unknown>, seat: number): string => {
  const players = Array.isArray(req.players) ? req.players : [];
  for (const player of players) {
    if (player && typeof player === 'object' && (player as Record<string, unknown>).seat === seat) {
      const name = (player as Record<string, unknown>).name;
      if (typeof name === 'string' && name.length > 0) return name;
    }
  }
  return `座位 ${seat}`;
};

const publicMoveFromChoice = (req: Record<string, unknown>, choice: string): { desc: string; played: number } | undefined => {
  const target = String(req.target ?? '目标牌');
  if (choice === 'challenge') return { desc: '质疑上家', played: 0 };
  if (choice.startsWith('play:')) {
    const played = choice.slice('play:'.length).split(',').filter(part => part.length > 0).length;
    return { desc: `出 ${played} 张，对外声称都是 ${target}`, played };
  }
  if (choice.startsWith('aim:')) {
    const seat = Number.parseInt(choice.slice('aim:'.length), 10);
    return { desc: `选了 ${nameForSeat(req, seat)} 开枪`, played: 0 };
  }
  return undefined;
};

export const createLiarsBarDecisionNote = (req: unknown, reply: GameReply): string | undefined => {
  if (!req || typeof req !== 'object') return undefined;
  const r = req as Record<string, unknown>;
  const held = handCount(r.hand);

  let move: { desc: string; played: number } | undefined;
  if (isChoiceReply(reply)) {
    move = publicMoveFromChoice(r, reply.choice);
  } else if ('target' in reply && typeof reply.target === 'number') {
    move = { desc: `选了 ${nameForSeat(r, reply.target)} 开枪`, played: 0 };
  } else if ('action' in reply && reply.action === 'challenge') {
    move = { desc: '质疑上家', played: 0 };
  } else if ('action' in reply && reply.action === 'play') {
    const played = Array.isArray(reply.slots) ? reply.slots.length : 0;
    move = { desc: `出 ${played} 张，对外声称都是 ${String(r.target ?? '目标牌')}`, played };
  }

  if (!move) return undefined;
  return `轮次: ${roundOf(r)} | 目标牌: ${String(r.target ?? '未知')} | 手里 ${Math.max(0, held - move.played)} 张 | 你这一手: ${move.desc} | ${TALKER_RULE}`;
};

export const liarsBarModule: GameModule = {
  id: 'liars_bar',
  displayName: '骗子酒馆',

  describeState(req: unknown): string | undefined {
    if (!isLiarsBarDecideRequest(req)) return undefined;
    return describeLiarsBarState(req);
  },

  fallbackChoice(req: unknown): string {
    const ids = gameChoiceIds(req);
    if (ids.length === 0) return '';
    if (!isLiarsBarDecideRequest(req)) return randomChoiceId(ids);
    const preferred = findChoiceIdForLegacy(ids, fallbackLiarsBar(req), req.hand);
    return preferred ?? randomChoiceId(ids);
  },

  async decideAction(req: unknown, deps: GameDecideDeps): Promise<GameLegacyReply> {
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
    return { ...(parsed as Record<string, unknown>), turn_id: req.turn_id } as GameLegacyReply;
  },

  fallback(req: unknown): GameLegacyReply {
    if (!isLiarsBarDecideRequest(req)) {
      const turnId = (req as Record<string, unknown>)?.turn_id;
      return {
        turn_id: typeof turnId === 'number' ? turnId : 0,
        action: 'challenge',
      };
    }
    return fallbackLiarsBar(req);
  },

  validate(req: unknown, reply: unknown): reply is GameLegacyReply {
    if (!isLiarsBarDecideRequest(req)) return false;
    return validateLiarsBarAction(req, reply);
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

  createDecisionNote(req: unknown, reply: GameReply): string | undefined {
    return createLiarsBarDecisionNote(req, reply);
  },
};
