import * as v from 'valibot';

export const TavernInvitationConfigSchema = v.object({
  decide: v.optional(v.union([v.literal('ask'), v.literal('always')]), 'always'),
  // The dealer waits 30 s, but the core `ask` capability caps its own wait at
  // 14 s, so a larger value here would be silently clipped.
  timeoutMs: v.optional(v.pipe(v.number(), v.minValue(1000), v.maxValue(14000)), 8000),
  onTimeout: v.optional(v.union([v.literal('accept'), v.literal('decline')]), 'accept'),
});

export type TavernInvitationConfig = v.InferOutput<typeof TavernInvitationConfigSchema>;

export const TavernGameConfigSchema = v.object({
  enabled: v.optional(v.boolean(), true),
  // Optional whitelist of modes (e.g. liars_bar: classic / devil / chaos).
  // Absent means every mode is accepted.
  modes: v.optional(v.array(v.pipe(v.string(), v.nonEmpty()))),
});

export type TavernGameConfig = v.InferOutput<typeof TavernGameConfigSchema>;

export const TavernConfigSchema = v.pipe(
  v.object({
    enabled: v.optional(v.boolean(), true),
    secret: v.optional(v.string(), ''),
    model: v.optional(v.string(), 'probe'),
    askModel: v.optional(v.string()),
    // The dealer's per-request deadline_ms (minus a 3 s margin) still caps the
    // budget; this only bounds our own share. Moves get ~58 s, aim requests
    // ~28 s, so our default is well inside both.
    decisionTimeoutMs: v.optional(v.pipe(v.number(), v.minValue(1000), v.maxValue(58000)), 40000),
    invitation: v.optional(TavernInvitationConfigSchema),
    basePath: v.optional(v.string(), ''),
    tableName: v.optional(v.string(), 'LuckyBot'),
    games: v.optional(v.record(v.string(), TavernGameConfigSchema), {}),
  }),
  v.check(
    conf => conf.enabled === false || (typeof conf.secret === 'string' && conf.secret.trim().length > 0),
    'tavern.secret is required when tavern plugin is enabled',
  ),
);

export type TavernConfig = v.InferOutput<typeof TavernConfigSchema>;
