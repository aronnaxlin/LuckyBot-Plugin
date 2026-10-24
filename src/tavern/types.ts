import * as v from 'valibot';

export const TavernInvitationConfigSchema = v.object({
  decide: v.optional(v.union([v.literal('ask'), v.literal('always')]), 'always'),
  timeoutMs: v.optional(v.pipe(v.number(), v.minValue(1000), v.maxValue(14000)), 8000),
  onTimeout: v.optional(v.union([v.literal('accept'), v.literal('decline')]), 'accept'),
});

export type TavernInvitationConfig = v.InferOutput<typeof TavernInvitationConfigSchema>;

export const TavernConfigSchema = v.pipe(
  v.object({
    enabled: v.optional(v.boolean(), true),
    secret: v.optional(v.string(), ''),
    model: v.optional(v.string(), 'probe'),
    askModel: v.optional(v.string()),
    // The dealer's per-request deadline_ms (minus a 2 s margin) still caps the
    // budget; this only bounds our own share. Raised from 14000 when the dealer
    // moved bot decisions from 15 s to 30 s.
    decisionTimeoutMs: v.optional(v.pipe(v.number(), v.minValue(1000), v.maxValue(60000)), 10000),
    invitation: v.optional(TavernInvitationConfigSchema),
    basePath: v.optional(v.string(), ''),
    tableName: v.optional(v.string(), 'LuckyBot'),
    games: v.optional(v.record(v.string(), v.object({
      enabled: v.optional(v.boolean(), true),
    })), {}),
  }),
  v.check(
    conf => conf.enabled === false || (typeof conf.secret === 'string' && conf.secret.trim().length > 0),
    'tavern.secret is required when tavern plugin is enabled',
  ),
);

export type TavernConfig = v.InferOutput<typeof TavernConfigSchema>;
