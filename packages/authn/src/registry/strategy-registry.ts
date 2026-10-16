import { AsyncService, PerChildInstance } from '@spinajs/di';
import { AutoinjectNamedServices, Config, InvalidConfiguration } from '@spinajs/configuration';
import { InvalidOperation, InvalidOption } from '@spinajs/exceptions';
import { _is_array_of, _is_string, _non_empty, _try_check_arg } from '@spinajs/util';

import { AuthenticationStrategy } from '../contracts/strategy.js';
import type { Credentials } from '../contracts/credentials.js';
import { kindOf, q } from '../support/format.js';
import { isCredentialSelector } from './selector.js';
import type { CredentialSelector } from './selector.js';

export interface StrategyEntry {
  readonly name: string;
  readonly service: string;
}

interface Checked {
  readonly strategy: AuthenticationStrategy;
  readonly kinds: readonly string[];
  readonly selector: boolean;
}

// Duck-typed: strategies built against another copy of the contracts (cjs/mjs, the kit) fail instanceof.
function check(e: StrategyEntry, s: unknown): Checked {
  const at = `authn.strategies entry ${q(e.name)} (service ${q(e.service)})`;
  const strategy = s as AuthenticationStrategy | null;
  if (strategy === null || typeof strategy !== 'object' || typeof strategy.verify !== 'function' || typeof strategy.throttleKeys !== 'function') {
    throw new InvalidOption(`${at}: the service is not an AuthenticationStrategy`);
  }
  // A missing flag would read as false: the per-request path, which never asks for MFA.
  if (typeof strategy.interactive !== 'boolean') {
    throw new InvalidOption(`${at}: the strategy's interactive must be a boolean, got ${kindOf(strategy.interactive)}`);
  }
  const [ok, kinds] = _try_check_arg(_is_array_of(_is_string(_non_empty())), _non_empty())(strategy.kinds, 'kinds');
  if (!ok) {
    throw new InvalidOption(`${at}: the strategy must declare at least one credential kind as a non-empty string`);
  }
  return { strategy, kinds: Object.freeze([...kinds]), selector: isCredentialSelector(strategy) };
}

// A refused configuration section fails the request (a 500 the HTTP layer logs); read as a decline it would only show
// as a quiet 401 for every credential of the kind. Matched by name too: the cjs and the mjs build each have the class.
const isInvalidConfiguration = (e: unknown): boolean => e instanceof InvalidConfiguration || (e instanceof Error && e.constructor.name === 'InvalidConfiguration');

function accepts(s: AuthenticationStrategy, c: Credentials): boolean {
  try {
    return (s as AuthenticationStrategy & CredentialSelector).accepts(c) === true;
  } catch (e) {
    if (isInvalidConfiguration(e)) throw e;
    return false;
  }
}

/**
 * The strategies of `authn.strategies`, in list order (A01). The list comes from the resolving container's Configuration, and
 * services are looked up by name among the AuthenticationStrategy types registered there or in its ancestors; registered but unlisted
 * strategies never run. Boot fails on an unknown service and an entry name that differs from the
 * strategy's own `name`. Strategies may share kinds: the service falls through on `unsupported_credentials` (D1). One
 * per container, so a child boot reads its own list.
 */
@PerChildInstance()
export class StrategyRegistry extends AsyncService {
  // Read only to name an entry's service in check()'s errors.
  @Config('authn.strategies')
  protected Entries: StrategyEntry[];

  // The whole lineage: a child may list a root strategy next to its own.
  @AutoinjectNamedServices('authn.strategies', AuthenticationStrategy, { lineage: true, keyBy: 'name' })
  protected Listed: Map<string, AuthenticationStrategy>;

  private checked: readonly Checked[] | undefined;
  private all: readonly AuthenticationStrategy[] | undefined;

  public async resolve(): Promise<void> {
    const checked: Checked[] = [];
    for (const [name, strategy] of this.Listed) {
      const service = this.Entries.find((e) => e.name === name)!.service;
      checked.push(check({ name, service }, strategy));
    }
    this.checked = Object.freeze(checked);
    this.all = Object.freeze(checked.map((l) => l.strategy));
    await super.resolve();
  }

  /** Listed strategies only, in list order. */
  public strategies(): readonly AuthenticationStrategy[] {
    this.state();
    return this.all!;
  }

  /** Listed strategies for `c.kind`, in list order, minus those whose optional `accepts(c)` declines (D1). @throws InvalidConfiguration thrown by an `accepts` */
  public candidates(c: Credentials): readonly AuthenticationStrategy[] {
    const listed = this.state();
    const kind = c !== null && typeof c === 'object' ? (c as { kind?: unknown }).kind : undefined;
    if (typeof kind !== 'string') return Object.freeze([]);
    return Object.freeze(listed.filter((l) => l.kinds.includes(kind) && (!l.selector || accepts(l.strategy, c))).map((l) => l.strategy));
  }

  private state(): readonly Checked[] {
    if (!this.checked) throw new InvalidOperation('StrategyRegistry is not resolved');
    return this.checked;
  }
}
