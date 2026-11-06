import type { PrincipalRef, ResourceRef, ResourceType } from '@spinajs/authz';

import { isSubjectSet } from './keys.js';
import type { CompiledRewrite } from './namespace/compile.js';
import type { RebacWalk } from './expand.js';

/**
 * The subjects of one type that hold a relation or permission. `complete` is false when maxDepth cut the walk; a cycle
 * cuts nothing a union needs, since every holder on it is reached from where the cycle started.
 */
export interface SubjectList {
  readonly subjects: readonly PrincipalRef[];
  readonly complete: boolean;
}

/** Every subject of `subjectType` holding `name` on `object`, through subject sets, arrows and the set operations of the rewrites. */
export async function listSubjects(walk: RebacWalk, object: ResourceRef, name: string, subjectType: ResourceType): Promise<SubjectList> {
  const state = { complete: true };
  const ids = await holders(walk, object, name, subjectType, 0, state);
  return { subjects: [...ids].sort().map((id) => ({ type: subjectType, id })), complete: state.complete };
}

type State = { complete: boolean };

function holders(walk: RebacWalk, object: ResourceRef, name: string, subjectType: ResourceType, depth: number, state: State): Promise<Set<string>> {
  return walk.visit(
    object,
    name,
    depth,
    (cut) => {
      if (cut === 'depth') state.complete = false;
      return new Set<string>();
    },
    () => {
      const rewrite = walk.schema.permission(object.type, name);
      return rewrite ? ofRewrite(walk, object, rewrite, subjectType, depth, state) : ofRelation(walk, object, name, subjectType, depth, state);
    },
  );
}

async function ofRelation(walk: RebacWalk, object: ResourceRef, name: string, subjectType: ResourceType, depth: number, state: State): Promise<Set<string>> {
  const out = new Set<string>();
  const rel = walk.schema.relation(object.type, name);
  if (!rel) return out;
  for (const t of await walk.read(object, name)) {
    const s = t.subject;
    if (!isSubjectSet(s)) {
      if (s.type === subjectType && rel.direct.includes(s.type)) out.add(s.id);
      continue;
    }
    if (!rel.sets.some((x) => x.type === s.object.type && x.relation === s.relation)) continue;
    for (const id of await holders(walk, s.object, s.relation, subjectType, depth + 1, state)) out.add(id);
  }
  return out;
}

async function ofRewrite(walk: RebacWalk, object: ResourceRef, r: CompiledRewrite, subjectType: ResourceType, depth: number, state: State): Promise<Set<string>> {
  switch (r.kind) {
    case 'computed':
      return holders(walk, object, r.name, subjectType, depth, state);
    case 'ttu': {
      const out = new Set<string>();
      for (const o of await walk.targets(object, r.tupleset)) for (const id of await holders(walk, o, r.computed, subjectType, depth + 1, state)) out.add(id);
      return out;
    }
    case 'union': {
      const out = new Set<string>();
      for (const c of r.children) for (const id of await ofRewrite(walk, object, c, subjectType, depth, state)) out.add(id);
      return out;
    }
    case 'intersection': {
      let out: Set<string> | undefined;
      for (const c of r.children) {
        const ids = await ofRewrite(walk, object, c, subjectType, depth, state);
        out = out === undefined ? ids : new Set([...out].filter((id) => ids.has(id)));
      }
      return out ?? new Set<string>();
    }
    case 'exclusion': {
      const base = await ofRewrite(walk, object, r.base, subjectType, depth, state);
      const subtract = await ofRewrite(walk, object, r.subtract, subjectType, depth, state);
      return new Set([...base].filter((id) => !subtract.has(id)));
    }
  }
}
