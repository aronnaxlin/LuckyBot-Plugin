import * as v from 'valibot';

import type { GameDecideDeps, GameLegacyReply, GameModule, GameReply } from '../types';
import { gameChoiceIds, isChoiceReply, parseJsonResponse, randomChoiceId } from '../types';

export interface BulletPokerOptions {
  raise: boolean;
  fold: boolean;
  swap: boolean;
  allin: boolean;
  call: boolean;
  pick: boolean;
  responding: boolean;
}

export interface BulletPokerPlayer {
  seat: number;
  name: string;
  alive: boolean;
  folded: boolean;
  allin: boolean;
  bet: number;
  acted: boolean;
  swapped: boolean;
  folds_left: number;
  is_bot: boolean;
}

export interface BulletPokerSeat {
  seat: number;
  name: string;
}

export interface BulletPokerOffer {
  slot: number;
  cards: string[];
}

export interface BulletPokerDecisionRequest {
  protocol?: number;
  seq?: number;
  game: 'bullet_poker';
  match_id?: string;
  chat_id: string;
  turn_id: number;
  you: { seat: number; name: string };
  hand_no: number;
  round: number;
  board: string[];
  hole: string[];
  bet: number;
  folds_left: number;
  swapped: boolean;
  options: BulletPokerOptions;
  offer: BulletPokerOffer | null;
  allin_by: BulletPokerSeat | null;
  button?: number;
  players: BulletPokerPlayer[];
  log?: string[];
  chat?: { name: string; text: string }[];
  ask?: string;
  prompt?: string;
  rules?: string;
  choices?: { id: string; say: string }[];
  deadline_ms?: number;
}

export interface BulletPokerRoundStart {
  protocol?: number;
  seq?: number;
  game: 'bullet_poker';
  match_id?: string;
  chat_id?: string;
  turn_id?: number;
  you?: { seat: number; name: string };
  round: number;
  hand_no: number;
  hole: string[];
  button: number;
  order: { seat: number; name: string; alive: boolean }[];
}

const BulletPokerOptionsSchema = v.objectWithRest({
  raise: v.boolean(),
  fold: v.boolean(),
  swap: v.boolean(),
  allin: v.boolean(),
  call: v.boolean(),
  pick: v.boolean(),
  responding: v.boolean(),
}, v.unknown());

const BulletPokerPlayerSchema = v.objectWithRest({
  seat: v.number(),
  name: v.string(),
  alive: v.boolean(),
  folded: v.boolean(),
  allin: v.boolean(),
  bet: v.number(),
  acted: v.boolean(),
  swapped: v.boolean(),
  folds_left: v.number(),
  is_bot: v.optional(v.boolean(), false),
}, v.unknown());

const BulletPokerOfferSchema = v.nullable(v.objectWithRest({
  slot: v.number(),
  cards: v.array(v.string()),
}, v.unknown()));

export const BulletPokerDecisionRequestSchema = v.objectWithRest({
  game: v.literal('bullet_poker'),
  turn_id: v.number(),
  hand_no: v.number(),
  round: v.number(),
  board: v.array(v.string()),
  hole: v.array(v.string()),
  bet: v.number(),
  folds_left: v.number(),
  swapped: v.boolean(),
  options: BulletPokerOptionsSchema,
  offer: v.optional(BulletPokerOfferSchema, null),
  allin_by: v.optional(v.nullable(v.objectWithRest({ seat: v.number(), name: v.string() }, v.unknown())), null),
  button: v.optional(v.number()),
  players: v.array(BulletPokerPlayerSchema),
  log: v.optional(v.array(v.string())),
  chat: v.optional(v.array(v.objectWithRest({ name: v.string(), text: v.string() }, v.unknown()))),
  ask: v.optional(v.string()),
  prompt: v.optional(v.string()),
  rules: v.optional(v.string()),
  choices: v.optional(v.array(v.objectWithRest({ id: v.string(), say: v.string() }, v.unknown()))),
  deadline_ms: v.optional(v.number()),
}, v.unknown());

export const isBulletPokerDecideRequest = (req: unknown): req is BulletPokerDecisionRequest => {
  const parsed = v.safeParse(BulletPokerDecisionRequestSchema, req);
  return parsed.success;
};

const DEFAULT_BULLET_POKER_RULES = '你在飞书群里玩《子弹德州》：德州扑克的牌型，下注下的是子弹。每人 2 张底牌、8 格左轮。每一手开始每人先押 1 颗，轮到你时可以加注、弃牌（把押的子弹装进枪开一枪）、换一张底牌，翻出 3 张公共牌后还能全押；有人全押时只能跟或弃。摊牌时输家把押的子弹全装进枪开枪，中弹出局。';

export const bulletPokerRank = (card: string): string => card.charAt(0).toUpperCase();

export const isBulletPokerPair = (hole: readonly string[]): boolean =>
  hole.length >= 2 && bulletPokerRank(hole[0] ?? '') === bulletPokerRank(hole[1] ?? '');

const roundLabel = (round: number): string => {
  if (round === 1) return '翻牌前';
  if (round === 2) return '翻出 3 张公共牌后';
  if (round === 3) return '翻出第 4 张后';
  return '摊牌';
};

export const bulletPokerAvailableOptions = (req: BulletPokerDecisionRequest): string[] => {
  const options = req.options;
  const available: string[] = [];
  if (options.raise) available.push('加注（raise）');
  if (options.call) available.push('跟全押（call）');
  if (options.allin) available.push('全押（allin）');
  if (options.swap) available.push('换一张底牌（swap + slot 1/2）');
  if (options.fold) available.push('弃牌开枪（fold）');
  if (options.pick) available.push('从换牌候选里挑一张（pick + choice 1–3）');
  if (options.responding) available.push('正在回应全押：只能跟（call）或弃（fold）');
  return available;
};

type BulletPokerFallback =
  | { kind: 'pick'; choice: number }
  | { kind: 'swap'; slot: number }
  | { kind: 'raise' | 'fold' | 'allin' | 'call' };

const pickOfferChoice = (req: BulletPokerDecisionRequest): number => {
  const count = Math.min(3, Math.max(1, req.offer?.cards.length ?? 3));
  return 1 + Math.floor(Math.random() * count);
};

export const chooseBulletPokerFallback = (req: BulletPokerDecisionRequest): BulletPokerFallback => {
  if (req.options.pick && req.offer) return { kind: 'pick', choice: pickOfferChoice(req) };
  if (req.options.responding) {
    const wantsCall = isBulletPokerPair(req.hole) || req.folds_left === 0;
    if (wantsCall && req.options.call) return { kind: 'call' };
    if (req.options.fold) return { kind: 'fold' };
    if (req.options.call) return { kind: 'call' };
  }
  if (req.options.raise) return { kind: 'raise' };
  if (req.options.allin) return { kind: 'allin' };
  if (req.options.call) return { kind: 'call' };
  if (req.options.fold) return { kind: 'fold' };
  if (req.options.swap) return { kind: 'swap', slot: 1 };
  return { kind: 'raise' };
};

const findChoiceIdForFallback = (ids: readonly string[], fallback: BulletPokerFallback): string | undefined => {
  if (fallback.kind === 'pick') {
    const preferred = ids.find(id => id === `pick:${fallback.choice}`);
    if (preferred) return preferred;
    const pickIds = ids.filter(id => id.startsWith('pick:'));
    return pickIds[Math.floor(Math.random() * pickIds.length)];
  }
  if (fallback.kind === 'swap') {
    const preferred = ids.find(id => id === `swap:${fallback.slot}`);
    if (preferred) return preferred;
    return ids.find(id => id.startsWith('swap:'));
  }
  return ids.find(id => id === fallback.kind);
};

export const validateBulletPokerAction = (
  req: BulletPokerDecisionRequest,
  reply: unknown,
): reply is GameLegacyReply => {
  if (!reply || typeof reply !== 'object') return false;
  const action = reply as Record<string, unknown>;
  const options = req.options;

  if (action.action === 'raise') return options.raise === true;
  if (action.action === 'fold') return options.fold === true;
  if (action.action === 'allin') return options.allin === true;
  if (action.action === 'call') return options.call === true;
  if (action.action === 'swap') {
    return options.swap === true && (action.slot === 1 || action.slot === 2);
  }
  if (action.action === 'pick') {
    return options.pick === true
      && typeof action.choice === 'number'
      && Number.isInteger(action.choice)
      && action.choice >= 1
      && action.choice <= 3;
  }
  return false;
};

export const fallbackBulletPoker = (req: BulletPokerDecisionRequest): GameLegacyReply => {
  const turnId = typeof req?.turn_id === 'number' ? req.turn_id : 0;
  const fallback = chooseBulletPokerFallback(req);
  if (fallback.kind === 'pick') return { turn_id: turnId, action: 'pick', choice: fallback.choice };
  if (fallback.kind === 'swap') return { turn_id: turnId, action: 'swap', slot: fallback.slot };
  return { turn_id: turnId, action: fallback.kind };
};

export const describeBulletPokerState = (req: BulletPokerDecisionRequest): string => {
  const lines: string[] = [
    `第 ${req.hand_no} 手 | 第 ${req.round} 轮表态（${roundLabel(req.round)}）| 已押 ${req.bet} 颗 | 这局还能弃 ${req.folds_left} 次 | 这手换过牌: ${req.swapped}`,
    `你的底牌: ${req.hole.join('、') || '无'} | 公共牌: ${req.board.join('、') || '无'}`,
  ];

  const available = bulletPokerAvailableOptions(req);
  lines.push(`能做的动作: ${available.join('；') || '无'}`);

  if (req.offer) {
    lines.push(`换牌候选（只有你看得到）: 换第 ${req.offer.slot} 张底牌，候选 ${req.offer.cards.join('、')}`);
  }
  if (req.allin_by) lines.push(`这一手全押的人: ${req.allin_by.name}（座位 ${req.allin_by.seat}）`);
  if (typeof req.button === 'number') lines.push(`这一手的起始座位: ${req.button}`);

  if (req.players.length > 0) {
    lines.push('玩家:');
    for (const player of req.players) {
      lines.push(`- ${player.name}（座位 ${player.seat}）: ${player.alive ? '存活' : '出局'}${player.folded ? '，已弃' : ''}${player.allin ? '，全押' : ''}，押 ${player.bet} 颗，这局还能弃 ${player.folds_left} 次${player.is_bot ? '（机器人）' : ''}`);
    }
  }

  if (req.log && req.log.length > 0) lines.push(`最近播报:\n${req.log.slice(-10).join('\n')}`);
  if (req.chat && req.chat.length > 0) {
    lines.push(`群里最近的发言:\n${req.chat.slice(-10).map(c => `${c.name}: ${c.text}`).join('\n')}`);
  }

  return lines.join('\n');
};

export const buildBulletPokerPrompt = (req: BulletPokerDecisionRequest): string => {
  const rules = req.rules?.trim() ?? DEFAULT_BULLET_POKER_RULES;
  return `${rules}

当前局面（只有你看得到）：
${describeBulletPokerState(req)}

请选一个动作，只回 JSON：{"action": "raise"}、{"action": "fold"}、{"action": "allin"}、{"action": "call"}、{"action": "swap", "slot": 1} 或 {"action": "pick", "choice": 2}。不要输出 markdown 或解释。`;
};

export const parseBulletPokerResponse = (raw: string): unknown => parseJsonResponse(raw);

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

export const describeBulletPokerEvent = (event: unknown): string | undefined => {
  if (!event || typeof event !== 'object') return undefined;
  const e = event as Record<string, unknown>;
  const eventType = e.event;
  const youSeat = typeof e.you === 'object' && e.you !== null
    ? (e.you as { seat?: number }).seat
    : undefined;
  const name = typeof e.name === 'string' ? e.name : undefined;
  const isYou = youSeat !== undefined && e.seat === youSeat;
  const who = isYou ? '你' : (name ?? 'Someone');

  if (eventType === 'hand') {
    return `第 ${Number(e.hand_no ?? 1)} 手开始，从座位 ${Number(e.button ?? 0)} 开始表态。`;
  }

  if (eventType === 'raise') {
    return `${who} 加注，押到 ${Number(e.bet ?? 0)} 颗。`;
  }

  if (eventType === 'allin') {
    return `${who} 全押了！`;
  }

  if (eventType === 'call') {
    return `${who} 跟了全押。`;
  }

  if (eventType === 'fold') {
    return `${who} 弃牌，把 ${Number(e.load ?? 0)} 颗子弹装进枪。`;
  }

  if (eventType === 'shot') {
    const load = Number(e.load ?? 1);
    const result = String(e.result ?? '');
    const odds = Number.isInteger(load) && load > 0 && load <= 8 ? `中弹概率 ${load}/8` : '';
    const outcome = result === 'click'
      ? 'click！空枪，安然无恙。'
      : result === 'bang'
        ? 'BANG！实弹击中，出局！'
        : result === 'misfire'
          ? '咔！哑火，侥幸逃过。'
          : `${result}。`;
    return `${who} 扣动扳机（${load} 颗子弹，${odds}）……${outcome}`;
  }

  if (eventType === 'swapped') {
    return `${who} 换了一张底牌。`;
  }

  if (eventType === 'street') {
    const board = Array.isArray(e.board) ? e.board.filter((card): card is string => typeof card === 'string') : [];
    return `第 ${Number(e.round ?? 2)} 轮翻牌：${board.join('、') || '无公共牌'}。`;
  }

  if (eventType === 'showdown') {
    const board = Array.isArray(e.board) ? e.board.filter((card): card is string => typeof card === 'string') : [];
    const shown: string[] = [];
    if (Array.isArray(e.hands)) {
      for (const hand of e.hands) {
        if (!hand || typeof hand !== 'object') continue;
        const h = hand as Record<string, unknown>;
        const hole = Array.isArray(h.hole) ? h.hole.filter((card): card is string => typeof card === 'string') : [];
        shown.push(`${seatName({ seat: h.seat, name: h.name })}：${String(h.hand ?? '未知牌型')}（${hole.join('、')}）`);
      }
    }
    const winners = seatNames(e.winners);
    return `摊牌！公共牌：${board.join('、') || '无'}。${shown.join('；')}。赢家：${winners.join('、') || '无'}。`;
  }

  if (eventType === 'hand_won') {
    const winners = seatNames(e.winners);
    const reason = e.reason === 'allin' ? '全押没人跟' : '其他人都弃了';
    return `${winners.join('、') || '有人'} 赢下这一手（${reason}）。`;
  }

  if (eventType === 'game_over') {
    const winner = e.winner as Record<string, unknown> | null | undefined;
    if (winner && typeof winner === 'object') {
      const winnerIsYou = youSeat !== undefined && winner.seat === youSeat;
      return `游戏结束！胜者：${winnerIsYou ? '你' : String(winner.name ?? 'Someone')}。`;
    }
    return '游戏结束（中途散场）。';
  }

  return undefined;
};

const WAKING_EVENTS: ReadonlySet<string> = new Set([
  'hand',
  'raise',
  'allin',
  'call',
  'fold',
  'shot',
  'swapped',
  'street',
  'showdown',
  'hand_won',
  'game_over',
]);

export const wakesBotBulletPoker = (event: unknown): boolean => {
  if (!event || typeof event !== 'object') return false;
  const eventType = (event as Record<string, unknown>).event;
  return typeof eventType === 'string' && WAKING_EVENTS.has(eventType);
};

export const isGameEndBulletPoker = (event: unknown): boolean => {
  if (!event || typeof event !== 'object') return false;
  return (event as Record<string, unknown>).event === 'game_over';
};

// The table talker never sees hole cards or the swap offer. It only gets the
// public shape of the decision, for the same reason as Liar's Bar: a talker
// that knows its cards says them aloud and pre-announces moves.
const TALKER_RULE = '动作由牌桌另行决定，聊天里你看不到自己的底牌和换牌候选：别报具体牌面，别预告下一步动作；嘴上虚张声势都行';

const holeCount = (hole: unknown): number => (Array.isArray(hole) ? hole.length : 0);

export const createBulletPokerRoundNote = (req: unknown): string | undefined => {
  if (!req || typeof req !== 'object') return undefined;
  const r = req as Record<string, unknown>;
  const handNo = r.hand_no ?? r.round ?? 1;
  const button = typeof r.button === 'number' ? r.button : 0;
  const order = Array.isArray(r.order) ? r.order : [];
  const buttonName = order
    .map(seat => seat && typeof seat === 'object' ? seat as Record<string, unknown> : undefined)
    .find(seat => seat?.seat === button)?.name;
  const startText = typeof buttonName === 'string' && buttonName.length > 0
    ? `从 ${buttonName} 开始表态`
    : `从座位 ${button} 开始表态`;
  return `第 ${handNo} 手 | ${startText} | 底牌 ${holeCount(r.hole)} 张 | 公共牌 0 张 | ${TALKER_RULE}`;
};

const publicMoveFromChoice = (choice: string): string | undefined => {
  if (choice === 'raise' || choice.startsWith('raise')) return '加注';
  if (choice === 'fold' || choice.startsWith('fold')) return '弃牌';
  if (choice === 'allin' || choice.startsWith('allin')) return '全押';
  if (choice === 'call' || choice.startsWith('call')) return '跟全押';
  if (choice.startsWith('swap') || choice.startsWith('pick')) return '换了一张牌';
  return undefined;
};

export const createBulletPokerDecisionNote = (req: unknown, reply: GameReply): string | undefined => {
  if (!req || typeof req !== 'object') return undefined;
  const r = req as Record<string, unknown>;

  let move: string | undefined;
  if (isChoiceReply(reply)) {
    move = publicMoveFromChoice(reply.choice);
  } else if ('action' in reply && (reply.action === 'pick' || reply.action === 'swap')) {
    move = '换了一张牌';
  } else if ('action' in reply && reply.action === 'raise') {
    move = '加注';
  } else if ('action' in reply && reply.action === 'fold') {
    const load = typeof r.bet === 'number' ? `（装 ${r.bet} 颗）` : '';
    move = `弃牌开枪${load}`;
  } else if ('action' in reply && reply.action === 'allin') {
    move = '全押';
  } else if ('action' in reply && reply.action === 'call') {
    move = '跟全押';
  }

  if (!move) return undefined;
  return `第 ${Number(r.hand_no ?? 1)} 手 | 第 ${Number(r.round ?? 1)} 轮 | 押 ${Number(r.bet ?? 0)} 颗 | 你这一手: ${move} | ${TALKER_RULE}`;
};

export const bulletPokerModule: GameModule = {
  id: 'bullet_poker',
  displayName: '子弹德州',

  describeState(req: unknown): string | undefined {
    if (!isBulletPokerDecideRequest(req)) return undefined;
    return describeBulletPokerState(req);
  },

  fallbackChoice(req: unknown): string {
    const ids = gameChoiceIds(req);
    if (ids.length === 0) return '';
    if (!isBulletPokerDecideRequest(req)) return randomChoiceId(ids);
    const preferred = findChoiceIdForFallback(ids, chooseBulletPokerFallback(req));
    return preferred ?? randomChoiceId(ids);
  },

  async decideAction(req: unknown, deps: GameDecideDeps): Promise<GameLegacyReply> {
    if (!isBulletPokerDecideRequest(req)) {
      throw new Error('Invalid BulletPoker decide request shape');
    }
    const timeoutSec = Math.max(1, Math.floor(deps.remainingMs / 1000));
    const raw = await deps.callModel(buildBulletPokerPrompt(req), { timeoutSec });
    const parsed = parseBulletPokerResponse(raw);
    if (!validateBulletPokerAction(req, parsed)) {
      throw new Error(`Model decision is invalid for current table state: ${JSON.stringify(parsed)}`);
    }
    return { ...(parsed as Record<string, unknown>), turn_id: req.turn_id } as GameLegacyReply;
  },

  fallback(req: unknown): GameLegacyReply {
    if (!isBulletPokerDecideRequest(req)) {
      const turnId = (req as Record<string, unknown>)?.turn_id;
      return { turn_id: typeof turnId === 'number' ? turnId : 0, action: 'raise' };
    }
    return fallbackBulletPoker(req);
  },

  validate(req: unknown, reply: unknown): reply is GameLegacyReply {
    if (!isBulletPokerDecideRequest(req)) return false;
    return validateBulletPokerAction(req, reply);
  },

  describeEvent(event: unknown): string | undefined {
    return describeBulletPokerEvent(event);
  },

  wakesBot(event: unknown): boolean {
    return wakesBotBulletPoker(event);
  },

  isGameEnd(event: unknown): boolean {
    return isGameEndBulletPoker(event);
  },

  createRoundNote(req: unknown): string | undefined {
    return createBulletPokerRoundNote(req);
  },

  createDecisionNote(req: unknown, reply: GameReply): string | undefined {
    return createBulletPokerDecisionNote(req, reply);
  },
};
