import { bulletPokerModule } from '../games/bullet-poker';
import { liarsBarModule } from '../games/liars-bar';
import type { GameModule } from '../games/types';
import { CURRENT_SDK_VERSION, definePlugin } from '../sdk';
import { createTavernProtocolHandler } from './protocol';
import { TavernConfigSchema, type TavernConfig } from './types';

export const GAME_MODULES: readonly GameModule[] = [
  liarsBarModule,
  bulletPokerModule,
];

const TABLE_HINT = 'You are seated at a mini-game table in this group (Liar\'s Bar or Bullet Poker). Your moves are decided separately and arrive as `<plugin-event>` lines; you cannot play, challenge, bet or swap by speaking. Talk only about what the table has already seen: plays, challenges, shots, cards shown at showdown, people. Never name your own cards or hole cards, and never announce a move before it appears. Never use 入座/上桌/加入 in table chat: during sign-up the dealer seats any bot whose message contains those words, so saying them would sign you up again. Never post `!` dealer commands. Keep it to one or two short lines (at most three sentences), at most two rounds of banter with another bot, skip events you have nothing to add to, and stay in persona.';

const PROMPT_HINT = '**Mini-games:** `<plugin-event plugin="tavern">` lines in context are public announcements from game tables in this group (Liar\'s Bar, Bullet Poker). Your moves are decided separately and announced in those lines; speaking does not play. You never see or name your own cards or hole cards, and you never announce a move before it appears; do not invent unannounced table events either. You may bluff and react in character, but keep table talk short (≤3 sentences), at most two rounds of banter with another bot, and skip events you have nothing natural to add to. Never post dealer commands starting with `!` (such as `!加入` or `!开始`); seats are offered by the dealer, and you do not sign up yourself. During sign-up the dealer seats a bot whose message contains 入座/上桌/加入 (without 不/别), so never use those words in table chat.';

export const tavernPlugin = definePlugin<TavernConfig>({
  id: 'tavern',
  sdkVersion: CURRENT_SDK_VERSION,
  configSchema: TavernConfigSchema,
  contributes: {
    scenes: [
      {
        id: 'table',
        hint: TABLE_HINT,
      },
    ],
    promptHints: (_chatId: string) => [
      {
        placement: 'system',
        text: PROMPT_HINT,
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
