import { AsyncService, Container, Inject, PerChildInstance, isFactory } from '@spinajs/di';
import type { Class, Factory, IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidOperation, InvalidOption } from '@spinajs/exceptions';

import { AuthenticationStrategy } from '../contracts/strategy.js';
import type { Credentials } from '../contracts/credentials.js';
import { isCredentialSelector } from './selector.js';
import type { CredentialSelector } from './selector.js';

export interface StrategyEntry {
  readonly name: string;
  readonly service: string;
}

interface Listed {
  readonly strategy: AuthenticationStrategy;
  readonly kinds: readonly string[];
  readonly selector: boolean;
}

const q = (v: unknown): string => JSON.stringify(v) ?? String(v);

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

const kindOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

// Config files merge arrays by concat, so a file that repeats the package default lists an entry twice.
// Errors name indexes, names and services only: a malformed entry may carry options with secrets.
function readEntries(raw: unknown): StrategyEntry[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new InvalidOption(`authn.strategies must be a list of { name, service } entries, got ${kindOf(raw)}`);
  const services = new Map<string, string>();
  const entries: StrategyEntry[] = [];
  raw.forEach((item: unknown, i) => {
    const e = item as Partial<StrategyEntry> | null;
    if (e === null || typeof e !== 'object' || Array.isArray(e)) {
      throw new InvalidOption(`authn.strategies[${i}] must be a { name, service } object, got ${kindOf(item)}`);
    }
    const { name, service } = e;
    if (!nonEmpty(name) || !nonEmpty(service)) {
      const bad = Object.entries({ name, service }).filter(([, v]) => !nonEmpty(v));
      throw new InvalidOption(`authn.strategies[${i}]: ${bad.map(([k]) => k).join(' and ')} must be a non-empty string`);
    }
    const known = services.get(name);
    if (known === service) return;
    if (known !== undefined) {
      throw new InvalidOption(`authn.strategies: duplicate strategy name ${q(name)} with services ${q(known)} and ${q(service)}`);
    }
    services.set(name, service);
    entries.push({ name, service });
  });
  return entries;
}

// Duck-typed: strategies built against another copy of the contracts (cjs/mjs, the kit) fail instanceof.
function check(e: StrategyEntry, s: unknown): Listed {
  const at = `authn.strategies entry ${q(e.name)} (service ${q(e.service)})`;
  const strategy = s as AuthenticationStrategy | null;
  if (strategy === null || typeof strategy !== 'object' || typeof strategy.verify !== 'function' || typeof strategy.throttleKeys !== 'function') {
    throw new InvalidOption(`${at}: the service is not an AuthenticationStrategy`);
  }
  if (strategy.name !== e.name) {
    const own = typeof strategy.name === 'string' ? q(strategy.name) : `a ${kindOf(strategy.name)}`;
    throw new InvalidOption(`${at}: the strategy names itself ${own}; the entry name must match it`);
  }
  // A missing flag would read as false: the per-request path, which never asks for MFA.
  if (typeof strategy.interactive !== 'boolean') {
    throw new InvalidOption(`${at}: the strategy's interactive must be a boolean, got ${kindOf(strategy.interactive)}`);
  }
  const kinds: unknown = strategy.kinds;
  if (!Array.isArray(kinds) || kinds.length === 0 || !kinds.every(nonEmpty)) {
    throw new InvalidOption(`${at}: the strategy must declare at least one credential kind as a non-empty string`);
  }
  return { strategy, kinds: Object.freeze([...kinds]), selector: isCredentialSelector(strategy) };
}

function accepts(s: AuthenticationStrategy, c: Credentials): boolean {
  try {
    return (s as AuthenticationStrategy & CredentialSelector).accepts(c) === true;
  } catch {
    return false;
  }
}

/**
 * The strategies of `authn.strategies`, in list order (A01). The list comes from the resolving container's Configuration, and
 * services are looked up by name among the AuthenticationStrategy types registered there or in its ancestors; registered but unlisted
 * strategies never run. Boot fails on an unknown service, a duplicate name, and an entry name that differs from the
 * strategy's own `name`. Strategies may share kinds: the service falls through on `unsupported_credentials` (D1). One
 * per container, so a child boot reads its own list.
 */
@PerChildInstance()
@Inject(Container)
export class StrategyRegistry extends AsyncService {
  private listed: readonly Listed[] | undefined;
  private all: readonly AuthenticationStrategy[] | undefined;

  constructor(private readonly container: IContainer) {
    super();
  }

  public async resolve(): Promise<void> {
    if (this.listed) return;
    const configuration = (await this.container.resolve(Configuration)) as Configuration | null;
    if (configuration === null || typeof configuration !== 'object' || typeof configuration.get !== 'function') {
      throw new InvalidOperation('StrategyRegistry: the resolved Configuration has no get()');
    }
    const entries = readEntries(configuration.get('authn.strategies'));
    // The whole lineage, nearest registration first: a child may list a root strategy next to its own.
    const registered = [...(this.container.getRegisteredTypesChain(AuthenticationStrategy) ?? [])].reverse();
    const listed: Listed[] = [];
    for (const e of entries) {
      const type = registered.find((t) => t.name === e.service);
      if (!type) {
        throw new InvalidOption(`authn.strategies entry ${q(e.name)}: no AuthenticationStrategy is registered as service ${q(e.service)}`);
      }
      const strategy: unknown = isFactory(type) ? await (type as Factory<unknown>)(this.container) : await this.container.resolve(type as Class<unknown>);
      listed.push(check(e, strategy));
    }
    this.listed = Object.freeze(listed);
    this.all = Object.freeze(listed.map((l) => l.strategy));
    await super.resolve();
  }

  /** Listed strategies only, in list order. */
  public strategies(): readonly AuthenticationStrategy[] {
    this.state();
    return this.all!;
  }

  /** Listed strategies for `c.kind`, in list order, minus those whose optional `accepts(c)` declines (D1). */
  public candidates(c: Credentials): readonly AuthenticationStrategy[] {
    const listed = this.state();
    const kind = c !== null && typeof c === 'object' ? (c as { kind?: unknown }).kind : undefined;
    if (typeof kind !== 'string') return Object.freeze([]);
    return Object.freeze(listed.filter((l) => l.kinds.includes(kind) && (!l.selector || accepts(l.strategy, c))).map((l) => l.strategy));
  }

  private state(): readonly Listed[] {
    if (!this.listed) throw new InvalidOperation('StrategyRegistry is not resolved');
    return this.listed;
  }
}
