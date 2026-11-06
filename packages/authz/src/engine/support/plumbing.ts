import { AuthzConfigError } from '../../contracts/errors.js';
import type { RequestScope, Run, Engine } from '../types.js';
import { validDate } from '../vote.js';
import { bornOf, epoch } from '../cache/generation.js';
import { newNested, scopeMap } from './misc.js';

export function newRun(engine: Engine, sync: boolean, scope: RequestScope | undefined): Run {
  return topRun(engine, sync, scopeMap(scope), now(engine), 0);
}

/** A run that starts a call tree; epoch() first, so a fresh scope is born with the generation after a version change. */
export function topRun(engine: Engine, sync: boolean, scope: Map<string, unknown>, instant: Date, depth: number): Run {
  const versions = epoch(engine);
  return { sync, scope, instant, depth, delegationBudget: engine.config.maxDelegation, versions, generation: bornOf(engine, scope), nested: newNested(), bypass: false };
}

export function now(engine: Engine): Date {
  const now = validDate(engine.clock());
  if (!now) throw new AuthzConfigError(`${engine.where}: the clock returned an invalid date`);
  return now;
}

export function logAt(engine: Engine, level: 'error' | 'warn' | 'debug', fields: Record<string, unknown>, template: string): void {
  try {
    engine.log[level]({ domain: engine.domain, ...fields }, template);
  } catch {
    // a broken logger must not change a decision
  }
}
