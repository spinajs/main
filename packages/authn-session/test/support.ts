import { DI } from '@spinajs/di';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import type { DateTime } from 'luxon';
import { SessionExpirationProvider, SessionProvider } from '../src/contracts.js';
import type { ISession } from '../src/contracts.js';
import { AbsoluteExpiration, MemorySessionStore, SlidingCappedExpiration, SlidingExpiration } from '../src/index.js';
import shipped from '../src/config/session.js';

let overrides: Record<string, unknown> = {};
let registered = false;

/** Config for authn-session tests: the shipped config plus per-test overrides, with a silent logger. */
export class SessionTestConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    // Tests run from the package folder, where the configuration loader finds no package configs; start from ours.
    merge(this.Config as Record<string, unknown>, structuredClone(shipped));
    merge(this.Config as Record<string, unknown>, {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
    });
    merge(this.Config as Record<string, unknown>, structuredClone(overrides));
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function merge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(source)) {
    if (isPlain(v) && isPlain(target[k])) {
      merge(target[k] as Record<string, unknown>, v);
    } else {
      target[k] = v;
    }
  }
}

/** Types this package's tests resolve; uncached between cases instead of a blanket DI.clearCache(). */
export const OWNED_TYPES = [Configuration, SessionProvider, MemorySessionStore, SessionExpirationProvider, AbsoluteExpiration, SlidingExpiration, SlidingCappedExpiration];

export function uncacheOwned(extra: unknown[] = []): void {
  for (const t of [...OWNED_TYPES, SessionTestConfiguration, ...extra]) {
    DI.uncache(t as never);
  }
}

/** Registers the test configuration with the given overrides and resolves it fresh. */
export async function withSessionConfig(config: Record<string, unknown>, extra: unknown[] = []): Promise<void> {
  overrides = config;
  uncacheOwned(extra);
  if (!registered) {
    DI.register(SessionTestConfiguration).as(Configuration);
    registered = true;
  }
  await DI.resolve(Configuration);
}

/** Writes a 2.x-shaped row into the memory store: raw uuid key, no Subject or State, identity in Data. */
export function plantLegacyRow(store: MemorySessionStore, row: { rawId: string; user?: string; authorized: boolean; impersonator?: string; creation: DateTime; expiration?: DateTime; extra?: [string, unknown][] }): void {
  const data = new Map<string, unknown>([['Logged', true], ...(row.extra ?? [])]);
  if (row.user !== undefined) data.set('User', row.user);
  data.set('Authorized', row.authorized);
  if (row.impersonator) data.set('Impersonator', row.impersonator);
  const rows = (store as unknown as { Sessions: Map<string, ISession> }).Sessions;
  rows.set(row.rawId, { SessionId: row.rawId, Creation: row.creation, Expiration: row.expiration, Data: data } as unknown as ISession);
}
