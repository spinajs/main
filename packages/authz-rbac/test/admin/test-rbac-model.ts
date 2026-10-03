import { AuthorizationModel, FALSE, TRUE, compilePermissionGlob, or, principalKey, resourceKey } from '@spinajs/authz';
import type { DecisionRequest, EvaluationContext, ModelCapabilities, PermissionDef, ResourceFilter, ResourceRef, ResourceType, Vote } from '@spinajs/authz';

import type { Assignment, AssignmentStore, AssignmentSubject, GrantDef, LadderDef, RoleDef } from '../../src/index.js';

/** One role a principal holds at a resource, with the tags it carries and the scope type of the row it comes from. */
interface Held {
  readonly role: string;
  readonly tags: ReadonlySet<string>;
  readonly rowType: ResourceType;
}

export interface TestRbacModelOptions {
  readonly name?: string;
  readonly roles: readonly RoleDef[];
  readonly ladders: readonly LadderDef[];
  readonly assignments: AssignmentStore & { version?(): Promise<string> };
}

const sameRef = (a: ResourceRef, b: ResourceRef): boolean => resourceKey(a) === resourceKey(b);
const subjectKey = (s: AssignmentSubject): string => ('set' in s ? `set:${s.set.role}@${resourceKey(s.set.scope)}` : principalKey(s));

/**
 * Stands in for L1's RbacModel in the AuthzAdmin behaviour runs: reads the live rows of the domain's
 * assignment store at every request, so whatever AuthzAdmin commits is decided on at once. Covers
 * scoped assignments (an ancestor's row applies below it), ladders with cumulative grants and implies,
 * `extends`, implied roles at self-and-descendants or descendants, `requiresTag`, `grantedAt`, ladder
 * `resourceTypes`, `Vote.roles` per ladder (D-F5-8), subject sets one level deep and expiry. Not
 * covered: rules, links resolved from tokens, `on`, fields, summaries.
 */
export class TestRbacModel extends AuthorizationModel {
  readonly name: string;
  readonly capabilities: ModelCapabilities = { effects: ['permit'], residuals: ['true', 'false', 'and', 'or', 'relation'], sync: 'never', fields: false, needsSubject: false };

  private readonly roles: ReadonlyMap<string, RoleDef>;
  private readonly ladders: ReadonlyMap<string, LadderDef>;
  private readonly store: TestRbacModelOptions['assignments'];
  private observed = '';
  private bumps = 0;

  constructor(opts: TestRbacModelOptions) {
    super();
    // Such a grant would permit everywhere here; a world that needs one waits for L1's RbacModel.
    for (const r of opts.roles) for (const g of r.grants) if (g.on !== undefined || g.fields !== undefined) throw new Error(`TestRbacModel: role ${r.name} has a grant with ${g.on !== undefined ? 'on' : 'fields'}, which this model does not evaluate`);
    this.name = opts.name ?? 'rbac';
    this.roles = new Map(opts.roles.map((r) => [r.name, r]));
    this.ladders = new Map(opts.ladders.map((l) => [l.name, l]));
    this.store = opts.assignments;
  }

  init(): void {}

  applies(permission: PermissionDef): boolean {
    return [...this.roles.values()].some((r) => r.grants.some((g) => compilePermissionGlob(g.permission)(permission.name)));
  }

  version(): string {
    return `${this.observed}/${this.bumps}`;
  }

  invalidate(): void {
    this.bumps++;
  }

  async evaluate(req: DecisionRequest, ctx: EvaluationContext): Promise<Vote> {
    this.observed = (await this.store.version?.()) ?? '';
    const chain = await ctx.ancestors(req.resource);
    if (chain === null) return { model: this.name, permitWhen: FALSE, denyWhen: FALSE, reason: { code: 'unknown_resource', model: this.name }, cacheable: true };

    const rows = await this.rowsOf(req, ctx.now);
    const held: Held[] = [];
    let validUntil: Date | undefined;
    for (const row of rows) {
      if (!chain.some((c) => sameRef(c, row.scope))) continue;
      if (row.expiresAt && (!validUntil || row.expiresAt < validUntil)) validUntil = row.expiresAt;
      const below = !sameRef(row.scope, req.resource);
      this.expand(row.role, new Set(row.tags ?? []), row.scope.type, below, held, new Set());
    }

    const type = req.resource.type;
    const permits: ResourceFilter[] = [];
    const ranks = new Map<string, number>();
    for (const h of held) {
      const def = this.roles.get(h.role);
      if (!def) continue;
      const ladder = this.ladderOf(def);
      if (ladder && !this.ladderAppliesAt(ladder, type)) continue;
      if (ladder) ranks.set(ladder.name, Math.max(ranks.get(ladder.name) ?? -1, ladder.roles.indexOf(def.name)));
      for (const g of def.grants) if (this.grantApplies(g, req.permission, h)) permits.push(g.relation === undefined ? TRUE : or(...[g.relation].flat().map((relation) => ({ op: 'relation' as const, relation }))));
    }

    const roles = Object.fromEntries([...ranks].map(([ladder, rank]) => [ladder, this.ladders.get(ladder)!.roles[rank]]));
    const permitWhen = permits.length === 0 ? FALSE : or(...permits);
    return {
      model: this.name,
      permitWhen,
      denyWhen: FALSE,
      roles,
      ...(permitWhen === FALSE ? { reason: { code: 'no_access', model: this.name } } : {}),
      ...(validUntil ? { validUntil } : {}),
      cacheable: true,
    };
  }

  /** The principal's and its companions' live rows, plus the rows of the subject sets those rows make them members of. */
  private async rowsOf(req: DecisionRequest, at: Date): Promise<readonly Assignment[]> {
    const direct = [req.principal, ...(req.principal.companions ?? [])].map((p) => ({ type: p.type, id: p.id }));
    const own = await this.store.forSubjects(direct, at);
    const sets = new Map<string, AssignmentSubject>();
    for (const row of own) {
      if (!this.roles.get(row.role)?.subjectSet) continue;
      const s: AssignmentSubject = { set: { role: row.role, scope: row.scope } };
      sets.set(subjectKey(s), s);
    }
    if (sets.size === 0) return own;
    return [...own, ...(await this.store.forSubjects([...sets.values()], at))];
  }

  /** Adds `role`, its `extends`, the lower roles of its ladder and the roles they imply to `held`. */
  private expand(role: string, tags: ReadonlySet<string>, rowType: ResourceType, below: boolean, held: Held[], seen: Set<string>): void {
    const key = `${role}\u0001${[...tags].sort().join(',')}`;
    if (seen.has(key)) return;
    seen.add(key);
    const def = this.roles.get(role);
    if (!def) return;
    held.push({ role, tags, rowType });
    const ladder = this.ladderOf(def);
    if (ladder) for (const lower of ladder.roles.slice(0, ladder.roles.indexOf(role))) this.expand(lower, tags, rowType, below, held, seen);
    for (const e of def.extends) this.expand(e, tags, rowType, below, held, seen);
    for (const i of def.implies ?? []) {
      if (i.at === 'descendants' && !below) continue;
      this.expand(i.role, new Set([...tags, ...(i.tags ?? [])]), rowType, below, held, seen);
    }
  }

  private grantApplies(g: GrantDef, permission: string, h: Held): boolean {
    if (!compilePermissionGlob(g.permission)(permission)) return false;
    if (g.requiresTag !== undefined && !h.tags.has(g.requiresTag)) return false;
    if (g.grantedAt !== undefined && !g.grantedAt.includes(h.rowType)) return false;
    return true;
  }

  private ladderOf(def: RoleDef): LadderDef | undefined {
    if (def.ladder !== undefined) return this.ladders.get(def.ladder);
    return [...this.ladders.values()].find((l) => l.roles.includes(def.name));
  }

  private ladderAppliesAt(ladder: LadderDef, type: ResourceType): boolean {
    return ladder.resourceTypes === undefined || ladder.resourceTypes.includes(type);
  }
}
