import type { PluginLogger } from '../sdk/types';

export interface GameChoice {
  id: string;
  say: string;
}

export interface GameDecideDeps {
  callModel: (prompt: string, options?: { system?: string; timeoutSec?: number }) => Promise<string>;
  log: PluginLogger;
  remainingMs: number;
}

export interface GameChoiceReply {
  turn_id: number;
  choice: string;
}

export interface GameActionReply {
  turn_id: number;
  action: string;
  [key: string]: unknown;
}

export interface GameAimReply {
  turn_id: number;
  target: number;
}

export type GameLegacyReply = GameActionReply | GameAimReply;
export type GameReply = GameChoiceReply | GameLegacyReply;

export interface GameModule {
  id: string;
  displayName: string;
  /** Private state summary for the generic `choices` decision prompt. */
  describeState(req: unknown): string | undefined;
  /** Must return an id present in `req.choices`; the protocol handler falls back to a random id. */
  fallbackChoice(req: unknown): string;
  /** Legacy per-game action path, used only when a request has no usable `choices` array. */
  decideAction(req: unknown, deps: GameDecideDeps): Promise<GameLegacyReply>;
  fallback(req: unknown): GameLegacyReply;
  validate(req: unknown, reply: unknown): reply is GameLegacyReply;
  describeEvent(event: unknown): string | undefined;
  wakesBot(event: unknown): boolean;
  isGameEnd(event: unknown): boolean;
  createRoundNote?(req: unknown): string | undefined;
  createDecisionNote?(req: unknown, reply: GameReply): string | undefined;
}

export const isChoiceReply = (reply: GameReply): reply is GameChoiceReply =>
  'choice' in reply && typeof reply.choice === 'string';

export const gameChoiceIds = (req: unknown): string[] => {
  if (!req || typeof req !== 'object') return [];
  const choices = (req as Record<string, unknown>).choices;
  if (!Array.isArray(choices)) return [];
  const ids: string[] = [];
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue;
    const id = (choice as Record<string, unknown>).id;
    if (typeof id === 'string' && id.length > 0 && !ids.includes(id)) ids.push(id);
  }
  return ids;
};

export const randomChoiceId = (ids: readonly string[]): string =>
  ids[Math.floor(Math.random() * ids.length)] ?? '';

/** Strips markdown fences and leading/trailing prose around the first JSON object. */
export const parseJsonResponse = (raw: string): unknown => {
  let cleaned = raw.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence?.[1]) cleaned = fence[1].trim();
  const json = cleaned.match(/\{[\s\S]*\}/);
  if (json?.[0]) cleaned = json[0];
  return JSON.parse(cleaned);
};

/**
 * Parses a model answer for the generic choice path. Only ids present in
 * `ids` are accepted; a bare id is tolerated as a fallback for models that
 * ignore the JSON instruction.
 */
export const parseChoiceResponse = (raw: string, ids: readonly string[]): string | undefined => {
  let cleaned = raw.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence?.[1]) cleaned = fence[1].trim();
  const json = cleaned.match(/\{[\s\S]*\}/);
  if (json?.[0]) {
    try {
      const parsed = JSON.parse(json[0]);
      if (parsed && typeof parsed === 'object') {
        const choice = (parsed as Record<string, unknown>).choice;
        if (typeof choice === 'string' && ids.includes(choice)) return choice;
      }
    } catch {
      // Fall through to the bare-id check below.
    }
  }
  return ids.find(id => id === cleaned || id === raw.trim());
};
