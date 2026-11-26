import { CONFIGURATION_SCHEMA, Configuration } from '@spinajs/configuration-common';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';

import type { Recording } from './contracts.js';
import type { ReplayWindow } from './history.js';

/** The hard ceiling of `maxChanges`, for the configuration and a caller's `ReplayRunOptions.maxChanges` alike. */
export const REPLAY_MAX_CHANGES_LIMIT = 500_000;

// A span in milliseconds: past it Node's timer fires after 1 ms (AbortSignal.timeout throws past 2^32 - 1), and a
// window this wide stays far inside the instants a Date holds.
const MAX_MS = 2_147_483_647;

export const REPLAY_DEFAULTS = { maxChanges: 50_000, maxKeys: 5_000, maxDepth: 8, maxCalls: 10_000, timeoutMs: 15_000, concurrency: 2, clockSkewMs: 1_000, commitLagMs: 5_000 } as const;

/**
 * The limits of one domain: `maxChanges` and `maxKeys` bound its history reads, `maxDepth` and `maxCalls` its
 * evaluator, `timeoutMs` its wall clock, `concurrency` its replays at once in a process, `clockSkewMs` and
 * `commitLagMs` its ambiguity window.
 */
export type ReplayLimits = { -readonly [K in keyof typeof REPLAY_DEFAULTS]: number };

interface IntegerSchema {
  readonly type: 'integer';
  readonly minimum: number;
  readonly maximum: number;
  readonly default?: number;
}

// Every key has a ceiling: the schema's integer type passes Infinity, which ReplayHistory refuses at the first replay.
const integer = (minimum: number, maximum: number, defaultValue?: number): IntegerSchema => ({ type: 'integer', minimum, maximum, ...(defaultValue === undefined ? {} : { default: defaultValue }) });

function limitSchemas(defaults?: ReplayLimits): Record<keyof ReplayLimits, IntegerSchema> {
  const safe = Number.MAX_SAFE_INTEGER;
  return {
    maxChanges: integer(1, REPLAY_MAX_CHANGES_LIMIT, defaults?.maxChanges),
    maxKeys: integer(1, safe, defaults?.maxKeys),
    maxDepth: integer(1, safe, defaults?.maxDepth),
    maxCalls: integer(1, safe, defaults?.maxCalls),
    timeoutMs: integer(1, MAX_MS, defaults?.timeoutMs),
    concurrency: integer(1, safe, defaults?.concurrency),
    // At least 1: the configuration coerces null and false to 0, and 0 would claim perfect clocks or instant commits.
    clockSkewMs: integer(1, MAX_MS, defaults?.clockSkewMs),
    commitLagMs: integer(1, MAX_MS, defaults?.commitLagMs),
  };
}

// propertyNames, not additionalProperties: false: the configuration's removeAdditional would drop a misspelt key silently.
const closed = (properties: Record<string, unknown>, extra: readonly string[] = []): Record<string, unknown> => ({ type: 'object', propertyNames: { enum: [...Object.keys(properties), ...extra] }, properties });

export const REPLAY_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/replay.configuration.schema.json',
  $configurationModule: 'replay',
  description: 'Replay limits (replay.*), overridden per domain (replay.domains.<domain>.*)',
  // No defaults under domains: there they would hide replay.*. The file sources tag every root section with __file__.
  ...closed({ ...limitSchemas(REPLAY_DEFAULTS), domains: { type: 'object', propertyNames: { pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' }, additionalProperties: closed(limitSchemas()) } }, ['__file__']),
};

// configuration-common only, so registerConfigurationSchemaAtImport() of @spinajs/configuration is out of reach. A
// Configuration resolved before this import (a CLI process) has not run the schema, which is why replayLimits() refuses
// what the schema would have refused.
DI.register(REPLAY_CONFIGURATION_SCHEMA).asValue(CONFIGURATION_SCHEMA.key);

/**
 * `replay.domains.<domain>.*` over `replay.*` over the defaults.
 *
 * @throws InvalidOperation for a key the section does not have, or a value outside its bounds
 */
export function replayLimits(domain?: string, container: IContainer = DI.RootContainer): ReplayLimits {
  const configuration = container.get(Configuration);
  if (!configuration) return { ...REPLAY_DEFAULTS };
  const root = laid(configuration, ['replay'], { ...REPLAY_DEFAULTS }, ['domains', '__file__']);
  return domain === undefined ? root : laid(configuration, ['replay', 'domains', domain], root);
}

const within = (v: unknown, bound: IntegerSchema): boolean => typeof v === 'number' && Number.isInteger(v) && v >= bound.minimum && v <= bound.maximum;

function laid(configuration: Configuration, path: readonly string[], base: ReplayLimits, beside: readonly string[] = []): ReplayLimits {
  const bounds = Object.entries(limitSchemas());
  const section = configuration.get<unknown>([...path]);
  const stray = typeof section === 'object' && section !== null ? Object.keys(section).find((key) => !beside.includes(key) && !bounds.some(([known]) => known === key)) : undefined;
  if (stray !== undefined) throw new InvalidOperation(`${[...path, stray].join('.')} is not a replay setting`);
  const out: ReplayLimits = { ...base };
  for (const [key, bound] of bounds) {
    const v = configuration.get<unknown>([...path, key]);
    if (v === undefined) continue;
    if (!within(v, bound)) throw new InvalidOperation(`${[...path, key].join('.')} must be an integer of at least ${bound.minimum} and at most ${bound.maximum}`);
    Object.assign(out, { [key]: v });
  }
  return out;
}

/** The computation read its state up to `durationMs` before T, and commit lag hides only changes before T. */
export function replayWindow(recording: Pick<Recording, 'durationMs'>, limits: Pick<ReplayLimits, 'clockSkewMs' | 'commitLagMs'>): ReplayWindow {
  const duration = Number.isFinite(recording.durationMs) && recording.durationMs > 0 ? recording.durationMs : 0;
  return { beforeMs: duration + limits.clockSkewMs + limits.commitLagMs, afterMs: limits.clockSkewMs };
}
