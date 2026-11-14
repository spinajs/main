import { AuthzConfigError } from '@spinajs/authz';
import { DI } from '@spinajs/di';

import { RlsPlanSource } from '../plan/index.js';

/** The registered RlsPlanSources by model name (DI root); two for one model is a configuration error. */
export function rlsPlanSources(): ReadonlyMap<string, RlsPlanSource> {
  const list = ((DI.resolve(Array.ofType(RlsPlanSource)) as unknown as RlsPlanSource[] | undefined) ?? []).filter((s) => s instanceof RlsPlanSource);
  const out = new Map<string, RlsPlanSource>();
  for (const s of list) {
    const prev = out.get(s.model);
    if (prev !== undefined && prev !== s) throw new AuthzConfigError(`authz-orm: two RlsPlanSources for model ${JSON.stringify(s.model)} (${prev.constructor.name}, ${s.constructor.name})`);
    out.set(s.model, s);
  }
  return out;
}
