import { AuthzConfigError, PlanTermSql } from '@spinajs/authz';

const nameOf = (c: unknown): string => (c !== null && typeof c === 'object' ? (c.constructor as { name?: string }).name ?? '<anonymous>' : String(c));

/** The PlanTermSql compilers by op; two for one op is a configuration error. */
export function planTermCompilers(registered: readonly PlanTermSql[]): ReadonlyMap<string, PlanTermSql> {
  const list = registered.filter((c) => c instanceof PlanTermSql);
  const out = new Map<string, PlanTermSql>();
  for (const c of list) {
    if (typeof c.op !== 'string' || c.op === '') throw new AuthzConfigError(`authz-orm: ${nameOf(c)} has no op`);
    const prev = out.get(c.op);
    if (prev !== undefined && prev !== c) throw new AuthzConfigError(`authz-orm: two PlanTermSql compilers for op ${JSON.stringify(c.op)} (${nameOf(prev)}, ${nameOf(c)})`);
    out.set(c.op, c);
  }
  return out;
}
