import { engineLog } from '@spinajs/authz';
import type { Assignment, AssignmentSubject, HostLog, ModelInitContext, Principal, ResourceRef, ResourceType } from '@spinajs/authz';

import { SubjectResolver } from '../../contracts.js';
import { expiryTime, subjectKey } from '../assignments.js';
import { assignmentProblem } from '../roles.js';
import type { RoleGraph } from '../roles.js';

/** What a `group` principal speaks for: the holders of `role` at `{ type: scopeType, id: <group id> }`. */
export interface GroupPrincipalConfig {
  readonly role: string;
  readonly scopeType: ResourceType;
}

export const DEFAULT_GROUP_PRINCIPAL: GroupPrincipalConfig = Object.freeze({ role: 'group.member', scopeType: 'group' });

/** The id of a wildcard subject: `{ type: 'user', id: '*' }` stands for every principal of type `user`. */
export const WILDCARD_ID = '*';

export type SetSubject = Extract<AssignmentSubject, { set: unknown }>;

/** One assignment that makes the principal a member of a set. */
export interface SetMembership {
  /** The role of that assignment (a subjectSet role or a role whose closure holds one). */
  readonly role: string;
  readonly assignment: string;
  readonly expiresAt?: Date;
}

/** The sets a principal is a member of through its own assignments, by subjectKey. */
export type SetMemberships = ReadonlyMap<string, { readonly subject: SetSubject; readonly via: readonly SetMembership[] }>;

/** A resolver that can also name the sets its principal's assignments make it a member of. */
export interface SetResolver extends SubjectResolver {
  memberships(rows: readonly Assignment[], roles: RoleGraph, now: Date): SetMemberships;
}

export const isSetResolver = (r: SubjectResolver | undefined): r is SetResolver => typeof (r as Partial<SetResolver> | undefined)?.memberships === 'function';

/**
 * The model's default SubjectResolver (design §6.1.3, §4.2): the principal, its companions, for a
 * group principal its member set, and the wildcard of each of their types. The sets the principal
 * holds through its assignments need those assignments, so the model's SetsExtension adds them after
 * the first read, through `memberships`.
 */
export class RbacSubjectResolver extends SubjectResolver implements SetResolver {
  private readonly group: GroupPrincipalConfig | null;

  constructor(opts: { readonly groupPrincipal?: GroupPrincipalConfig | null } = {}) {
    super();
    this.group = opts.groupPrincipal === undefined ? DEFAULT_GROUP_PRINCIPAL : opts.groupPrincipal;
  }

  subjects(p: Principal): readonly AssignmentSubject[] {
    const out = new Map<string, AssignmentSubject>();
    const add = (s: AssignmentSubject) => out.set(subjectKey(s), s);
    const everyone = [p, ...(p.companions ?? [])];
    for (const who of everyone) {
      // `{ type, id: '*' }` is the wildcard subject: a principal named '*' is reached through it alone.
      if (who.id !== WILDCARD_ID) add({ type: who.type, id: who.id });
      if (this.group && who.type === 'group') add({ set: { role: this.group.role, scope: { type: this.group.scopeType, id: who.id } } });
    }
    for (const who of everyone) add({ type: who.type, id: WILDCARD_ID });
    return [...out.values()];
  }

  /**
   * `{ set: { role: R, scope: S } }` for each live assignment at S, made to a principal (never to a
   * set: sets are one level deep), whose role is R or holds R in its closure (a higher role of R's
   * ladder, or a role extending R), for every `subjectSet` role R. Rows the role definition refuses
   * make no member. Sorted by subjectKey.
   */
  memberships(rows: readonly Assignment[], roles: RoleGraph, now: Date): SetMemberships {
    const out = new Map<string, { subject: SetSubject; via: SetMembership[] }>();
    for (const row of rows) {
      if ('set' in row.subject) continue;
      const expires = expiryTime(row);
      if (expires !== undefined && !(expires > now.getTime())) continue;
      if (assignmentProblem(roles, row.role, row.scope)) continue;
      for (const r of roles.get(row.role)!.closure) {
        if (roles.get(r)!.def.subjectSet !== true) continue;
        const subject: SetSubject = { set: { role: r, scope: copyRef(row.scope) } };
        const key = subjectKey(subject);
        const entry = out.get(key) ?? { subject, via: [] };
        entry.via.push({ role: row.role, assignment: row.id, ...(expires !== undefined ? { expiresAt: new Date(expires) } : {}) });
        out.set(key, entry);
      }
    }
    return new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
}

/** `authz.rbac.groupPrincipal`: `null` turns the mapping off; an absent value, or a key left out of it, keeps its default. */
export function groupPrincipalConfig(ctx: ModelInitContext, log: Pick<HostLog, 'warn'> = engineLog('authz-rbac')): GroupPrincipalConfig | null {
  const value = ctx.config<Partial<GroupPrincipalConfig> | null | undefined>('groupPrincipal', undefined);
  // An unvalidated configuration still gets here: a non-object (false, '', a string) turns the mapping off, never on with the defaults.
  if (value !== undefined && (typeof value !== 'object' || Array.isArray(value))) {
    log.warn(`authz.rbac.groupPrincipal is ${JSON.stringify(value)}, not an object or null: group principals speak for no member set`);
    return null;
  }
  return value === null ? null : Object.freeze({ ...DEFAULT_GROUP_PRINCIPAL, ...value });
}

const copyRef = (ref: ResourceRef): ResourceRef => (ref.id == null ? { type: ref.type } : { type: ref.type, id: ref.id });
