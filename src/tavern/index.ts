import { liarsBarModule } from '../games/liars-bar';
import type { GameModule } from '../games/types';
import { CURRENT_SDK_VERSION, definePlugin } from '../sdk';
import { createTavernProtocolHandler } from './protocol';
import { TavernConfigSchema, type TavernConfig } from './types';

export const GAME_MODULES: readonly GameModule[] = [
  liarsBarModule,
];

export const tavernPlugin = definePlugin<TavernConfig>({
  id: 'tavern',
  sdkVersion: CURRENT_SDK_VERSION,
  configSchema: TavernConfigSchema,
  contributes: {
    scenes: [
      {
        id: 'table',
        hint: 'You are currently participating in a mini-game table in this group. Keep table talk short, in character, and stay in persona.',
      },
    ],
    promptHints: (_chatId: string) => [
      {
        placement: 'system',
        text: '**Mini-games:** `<plugin-event plugin="tavern">` lines in context are public announcements from game tables in this group. You do not see your private cards or private game state in the chatlog. You may bluff, joke, or react in character, but never claim specific private cards as fact or invent unannounced table events. Keep table talk short (≤3 sentences), speak only when you have something natural to say rather than reacting to every single event, and stay in persona.',
      },
    ],
  },
  setup(ctx) {
    const handler = createTavernProtocolHandler(ctx.config, ctx, GAME_MODULES);
    const prefix = ctx.config.basePath ? ctx.config.basePath.replace(/\/$/, '') : '';

    // 1. Invitations: POST {prefix}/v1/games/:game/invitations
    ctx.capabilities.http.route({
      method: 'POST',
      path: `${prefix}/v1/games/:game/invitations`,
      handler: async req => {
        const game = req.params?.game ?? '';
        return await handler.handleInvitation(req, game);
      },
    });

    // 2. Round Start: PUT {prefix}/v1/games/:game/matches/:match_id/rounds/:round
    ctx.capabilities.http.route({
      method: 'PUT',
      path: `${prefix}/v1/games/:game/matches/:match_id/rounds/:round`,
      handler: async req => {
        const game = req.params?.game ?? '';
        const matchId = req.params?.match_id ?? '';
        const round = req.params?.round ?? '1';
        return await handler.handleRoundStart(req, game, matchId, round);
      },
    });

    // 3. Decisions: POST {prefix}/v1/games/:game/matches/:match_id/turns/:turn_id/decision
    ctx.capabilities.http.route({
      method: 'POST',
      path: `${prefix}/v1/games/:game/matches/:match_id/turns/:turn_id/decision`,
      handler: async req => {
        const game = req.params?.game ?? '';
        const matchId = req.params?.match_id ?? '';
        const turnId = req.params?.turn_id ?? '0';
        return await handler.handleDecision(req, game, matchId, turnId);
      },
    });

    // 4. Events: POST {prefix}/v1/games/:game/matches/:match_id/events
    ctx.capabilities.http.route({
      method: 'POST',
      path: `${prefix}/v1/games/:game/matches/:match_id/events`,
      handler: async req => {
        const game = req.params?.game ?? '';
        const matchId = req.params?.match_id ?? '';
        return await handler.handleEvent(req, game, matchId);
      },
    });
  },
});
