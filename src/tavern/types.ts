import * as v from 'valibot';

export const TavernConfigSchema = v.pipe(
  v.object({
    enabled: v.optional(v.boolean(), true),
    secret: v.optional(v.string(), ''),
    model: v.optional(v.string(), 'probe'),
    decisionTimeoutMs: v.optional(v.pipe(v.number(), v.minValue(1000), v.maxValue(14000)), 10000),
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
