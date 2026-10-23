import type { PluginLogger } from '../sdk/types';

export type GameAction =
  | { action: 'play'; slots: number[]; turn_id?: number; [key: string]: unknown }
  | { action: 'challenge'; turn_id?: number; [key: string]: unknown }
  | { action: string; turn_id?: number; [key: string]: unknown };

export interface GameDecideDeps {
  callModel: (prompt: string, options?: { system?: string; timeoutSec?: number }) => Promise<string>;
  log: PluginLogger;
  remainingMs: number;
}

export interface GameModule {
  id: string;
  decide(req: unknown, deps: GameDecideDeps): Promise<GameAction>;
  fallback(req: unknown): GameAction;
  validate(req: unknown, action: unknown): action is GameAction;
  describeEvent(event: unknown): string | undefined;
  wakesBot(event: unknown): boolean;
  isGameEnd(event: unknown): boolean;
  createRoundNote?(req: unknown): string | undefined;
  createDecisionNote?(req: unknown, action: GameAction): string | undefined;
}
