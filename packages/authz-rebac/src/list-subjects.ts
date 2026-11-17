import type { PrincipalRef, ResourceRef, ResourceType } from '@spinajs/authz';

import type { TupleCaveat } from './contracts.js';
import { isSubjectSet } from './keys.js';
import { admitsTuple } from './namespace/compile.js';
import type { CompiledRewrite } from './namespace/compile.js';
import type { RebacWalk } from './expand.js';
import type { CaveatTruth } from './model/caveats.js';

/**
 * The subjects of one type that hold a relation or permission: `subjects` for certain, `conditional` only under a caveat
 * that could not be decided. `complete` is false when maxDepth cut the walk; a cycle cuts nothing a union needs, since
 * every holder on it is reached from where the cycle started.
 */
export interface SubjectList {
  readonly subjects: readonly PrincipalRef[];
  readonly conditional: readonly PrincipalRef[];
  readonly complete: boolean;
}

/** Holders for certain (`yes`) and under an undecided caveat (`maybe`); the two never overlap. */
interface Held {
  readonly yes: Set<string>;
  readonly maybe: Set<string>;
}

const EMPTY = (): Held => ({ yes: new Set(), maybe: new Set() });
const all = (h: Held): Set<string> => new Set([...h.yes, ...h.maybe]);
const minus = (a: Set<string>, b: Set<string>): Set<string> => new Set([...a].filter((x) => !b.has(x)));

function unite(a: Held, b: Held): Held {
  const yes = new Set([...a.yes, ...b.yes]);
  return { yes, maybe: minus(new Set([...a.maybe, ...b.maybe]), yes) };
}

function intersect(a: Held, b: Held): Held {
  const yes = new Set([...a.yes].filter((x) => b.yes.has(x)));
  const inB = all(b);
  return { yes, maybe: minus(new Set([...all(a)].filter((x) => inB.has(x))), yes) };
}

function subtract(base: Held, sub: Held): Held {
  const yes = minus(base.yes, all(sub));
  return { yes, maybe: minus(minus(all(base), sub.yes), yes) };
}

/** Behind a caveat: allow keeps `h`, deny drops it, unknown makes every holder conditional. */
function behind(truth: CaveatTruth, h: Held): Held {
  if (truth === 'allow') return h;
  if (truth === 'deny') return EMPTY();
  return { yes: new Set(), maybe: all(h) };
}

type Caveat = (c: TupleCaveat) => Promise<CaveatTruth>;

interface State {
  complete: boolean;
  readonly subjectType: ResourceType;
  readonly caveat: Caveat;
}

/** Every subject of `subjectType` holding `name` on `object`, through subject sets, arrows and the set operations of the rewrites; without `caveat` every caveat is unknown. */
export async function listSubjects(walk: RebacWalk, object: ResourceRef, name: string, subjectType: ResourceType, caveat: Caveat = () => Promise.resolve('unknown')): Promise<SubjectList> {
  const state: State = { complete: true, subjectType, caveat };
  const held = await holders(walk, object, name, 0, state);
  const refs = (ids: Set<string>): PrincipalRef[] => [...ids].sort().map((id) => ({ type: subjectType, id }));
  return { subjects: refs(held.yes), conditional: refs(held.maybe), complete: state.complete };
}

function holders(walk: RebacWalk, object: ResourceRef, name: string, depth: number, state: State): Promise<Held> {
  return walk.visit(
    object,
    name,
    depth,
    (cut) => {
      if (cut === 'depth') state.complete = false;
      return EMPTY();
    },
    () => {
      const rewrite = walk.schema.permission(object.type, name);
      return rewrite ? ofRewrite(walk, object, rewrite, depth, state) : ofRelation(walk, object, name, depth, state);
    },
  );
}

/** `held()` behind the tuple's caveat; `held` does not run when the caveat is false. */
async function guarded(caveat: TupleCaveat | undefined, state: State, held: () => Promise<Held>): Promise<Held> {
  const truth = caveat === undefined ? 'allow' : await state.caveat(caveat);
  return truth === 'deny' ? EMPTY() : behind(truth, await held());
}

async function ofRelation(walk: RebacWalk, object: ResourceRef, name: string, depth: number, state: State): Promise<Held> {
  let out = EMPTY();
  const rel = walk.schema.relation(object.type, name);
  if (!rel) return out;
  for (const t of await walk.read(object, name)) {
    if (!admitsTuple(rel, t)) continue;
    const s = t.subject;
    if (isSubjectSet(s)) out = unite(out, await guarded(t.caveat, state, () => holders(walk, s.object, s.relation, depth + 1, state)));
    else if (s.type === state.subjectType) out = unite(out, await guarded(t.caveat, state, () => Promise.resolve({ yes: new Set([s.id]), maybe: new Set<string>() })));
  }
  return out;
}

async function ofRewrite(walk: RebacWalk, object: ResourceRef, r: CompiledRewrite, depth: number, state: State): Promise<Held> {
  switch (r.kind) {
    case 'computed':
      return holders(walk, object, r.name, depth, state);
    case 'ttu': {
      let out = EMPTY();
      for (const { object: o, caveat } of await walk.targets(object, r.tupleset)) out = unite(out, await guarded(caveat, state, () => holders(walk, o, r.computed, depth + 1, state)));
      return out;
    }
    case 'union': {
      let out = EMPTY();
      for (const c of r.children) out = unite(out, await ofRewrite(walk, object, c, depth, state));
      return out;
    }
    case 'intersection': {
      let out: Held | undefined;
      for (const c of r.children) {
        const h = await ofRewrite(walk, object, c, depth, state);
        out = out === undefined ? h : intersect(out, h);
      }
      return out ?? EMPTY();
    }
    case 'exclusion':
      return subtract(await ofRewrite(walk, object, r.base, depth, state), await ofRewrite(walk, object, r.subtract, depth, state));
  }
}
