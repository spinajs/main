import { AuthzConfigError } from '@spinajs/authz';
import { DI } from '@spinajs/di';

import { PlanTermCompiler } from '../plan/index.js';

const nameOf = (c: unknown): string => (c !== null && typeof c === 'object' ? (c.constructor as { name?: string }).name ?? '<anonymous>' : String(c));

/** The registered PlanTermCompilers by op (DI root); two for one op is a configuration error. */
export function planTermCompilers(): ReadonlyMap<string, PlanTermCompiler> {
  const list = ((DI.resolve(Array.ofType(PlanTermCompiler)) as unknown as PlanTermCompiler[] | undefined) ?? []).filter((c) => c instanceof PlanTermCompiler);
  const out = new Map<string, PlanTermCompiler>();
  for (const c of list) {
    if (typeof c.op !== 'string' || c.op === '') throw new AuthzConfigError(`authz-orm: ${nameOf(c)} has no op`);
    const prev = out.get(c.op);
    if (prev !== undefined && prev !== c) throw new AuthzConfigError(`authz-orm: two PlanTermCompilers for op ${JSON.stringify(c.op)} (${nameOf(prev)}, ${nameOf(c)})`);
    out.set(c.op, c);
  }
  return out;
}
