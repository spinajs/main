import { Configuration, registerConfigurationSchemaAtImport } from '@spinajs/configuration';
import { DI } from '@spinajs/di';

/** The hard ceiling of `maxChanges`, for the configuration and a caller's `ReplayOptions.maxChanges` alike. */
export const REPLAY_MAX_CHANGES_LIMIT = 500_000;

export const REPLAY_DEFAULTS = { maxChanges: 50_000, maxKeys: 5_000, maxDepth: 8, maxCalls: 10_000, timeoutMs: 15_000, concurrency: 2, clockSkewMs: 1_000, commitLagMs: 5_000 } as const;

export type ReplayConfig = { -readonly [K in keyof typeof REPLAY_DEFAULTS]: number };

const integer = (minimum: number, defaultValue: number, maximum?: number) => ({ type: 'integer', minimum, ...(maximum === undefined ? {} : { maximum }), default: defaultValue });

export const REPLAY_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-replay.configuration.schema.json',
  $configurationModule: 'authz.replay',
  description: 'Decision replay limits (authz.replay.*)',
  type: 'object',
  properties: {
    // Changes after the decision one replay scans.
    maxChanges: integer(1, REPLAY_DEFAULTS.maxChanges, REPLAY_MAX_CHANGES_LIMIT),
    // Keys one replay resolves.
    maxKeys: integer(1, REPLAY_DEFAULTS.maxKeys),
    maxDepth: integer(1, REPLAY_DEFAULTS.maxDepth),
    maxCalls: integer(1, REPLAY_DEFAULTS.maxCalls),
    timeoutMs: integer(1, REPLAY_DEFAULTS.timeoutMs),
    // Replays running at once in a process; one more is refused with ReplayBusy.
    concurrency: integer(1, REPLAY_DEFAULTS.concurrency),
    // The ambiguity window: clock skew between nodes on both sides of the decision, commit lag before it.
    clockSkewMs: integer(0, REPLAY_DEFAULTS.clockSkewMs),
    commitLagMs: integer(0, REPLAY_DEFAULTS.commitLagMs),
  },
  additionalProperties: false,
};

registerConfigurationSchemaAtImport(REPLAY_CONFIGURATION_SCHEMA);

/** `authz.replay.*`, each key the schema default when the configuration has none. */
export function replayConfig(): ReplayConfig {
  const cfg = DI.get(Configuration) as Configuration | undefined;
  const out: ReplayConfig = { ...REPLAY_DEFAULTS };
  for (const key of Object.keys(REPLAY_DEFAULTS)) {
    const v = cfg?.get<unknown>(['authz', 'replay', key]);
    if (typeof v === 'number' && Number.isInteger(v)) Object.assign(out, { [key]: v });
  }
  return out;
}
