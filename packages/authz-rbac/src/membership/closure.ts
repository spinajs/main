import { AuthzAdminFailure, AuthzConfigError } from '@spinajs/authz';

/** One live assignment that makes `memberKey` a direct member of `setKey`. */
export interface MembershipEdge {
  readonly memberKey: string;
  readonly setKey: string;
  /** null: never expires. */
  readonly expiresAt: Date | null;
}

/** One row of `authz_subject_membership`. */
export interface MembershipRow {
  readonly memberKey: string;
  readonly setKey: string;
  /** 1 = direct member; the shortest path otherwise. */
  readonly depth: number;
  readonly expiresAt: Date | null;
}

/** The live edges leaving each of `memberKeys`. */
export type EdgeSource = (memberKeys: readonly string[]) => Promise<readonly MembershipEdge[]>;

export const DEFAULT_MAX_SET_DEPTH = 8;

/** `authz.rbac.maxSetDepth`; the schema is the gate, this holds for values that never went through it. */
export function readMaxSetDepth(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_SET_DEPTH;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new AuthzConfigError(`authz.rbac.maxSetDepth must be an integer >= 1, got ${JSON.stringify(value)}`);
  return value;
}

const NEVER = Number.POSITIVE_INFINITY;

/** One entry per set, expiring at the latest of its rows (no `expiresAt` when one never expires); sorted by set key. */
export function latestPerSet(rows: readonly Pick<MembershipRow, 'setKey' | 'expiresAt'>[]): { setKey: string; expiresAt?: Date }[] {
  const latest = new Map<string, number>();
  for (const r of rows) {
    const until = r.expiresAt === null ? NEVER : r.expiresAt.getTime();
    if (until > (latest.get(r.setKey) ?? Number.NEGATIVE_INFINITY)) latest.set(r.setKey, until);
  }
  return [...latest]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([setKey, until]) => (until === NEVER ? { setKey } : { setKey, expiresAt: new Date(until) }));
}

/**
 * The closure rows of each member: every set it reaches over the edges, at its shortest depth, expiring at the
 * latest over all paths of the earliest edge expiry on the path. The edges of all members are read level by
 * level together, so k members cost at most maxDepth + 1 reads, not k times that. Edges are cached per node.
 * @throws AuthzAdminFailure `set_cycle` when a member (a set) reaches itself; `set_too_deep` when a set lies
 *   more than `maxDepth` levels above a member
 */
export async function computeClosures(memberKeys: readonly string[], edgesFrom: EdgeSource, maxDepth: number): Promise<Map<string, MembershipRow[]>> {
  const members = [...new Set(memberKeys)];
  const adjacency = new Map<string, MembershipEdge[]>();
  const load = async (keys: readonly string[]): Promise<void> => {
    const missing = [...new Set(keys)].filter((k) => !adjacency.has(k));
    if (missing.length === 0) return;
    for (const k of missing) adjacency.set(k, []);
    for (const e of await edgesFrom(missing)) adjacency.get(e.memberKey)?.push(e);
  };

  const depths = new Map<string, Map<string, number>>(members.map((m) => [m, new Map()]));
  let frontiers = new Map<string, string[]>(members.map((m) => [m, [m]]));
  for (let level = 1; frontiers.size > 0; level++) {
    await load([...frontiers.values()].flat());
    const next = new Map<string, string[]>();
    for (const [member, frontier] of frontiers) {
      const seen = depths.get(member)!;
      const found: string[] = [];
      for (const node of frontier) {
        for (const e of adjacency.get(node)!) {
          if (e.setKey === member) throw new AuthzAdminFailure('set_cycle', `${member} would be a member of itself through ${node}`);
          if (seen.has(e.setKey)) continue;
          if (level > maxDepth) throw new AuthzAdminFailure('set_too_deep', `${e.setKey} would lie ${level} levels above ${member}; authz.rbac.maxSetDepth is ${maxDepth}`);
          seen.set(e.setKey, level);
          found.push(e.setKey);
        }
      }
      if (found.length > 0) next.set(member, found);
    }
    frontiers = next;
  }

  const out = new Map<string, MembershipRow[]>();
  for (const member of members) {
    // Max-min relaxation: a value only grows, and only to one of finitely many expiries, so it ends.
    const best = new Map<string, number>([[member, NEVER]]);
    const queue = [member];
    while (queue.length > 0) {
      const node = queue.shift()!;
      const reach = best.get(node)!;
      for (const e of adjacency.get(node) ?? []) {
        const via = Math.min(reach, e.expiresAt === null ? NEVER : e.expiresAt.getTime());
        if (via > (best.get(e.setKey) ?? Number.NEGATIVE_INFINITY)) {
          best.set(e.setKey, via);
          queue.push(e.setKey);
        }
      }
    }
    const rows = [...depths.get(member)!]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([setKey, depth]): MembershipRow => {
        const until = best.get(setKey)!;
        return { memberKey: member, setKey, depth, expiresAt: until === NEVER ? null : new Date(until) };
      });
    out.set(member, rows);
  }
  return out;
}
