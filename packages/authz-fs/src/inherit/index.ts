import { AuthorizationModel, FALSE, GLOBAL, TRUE, isPermission, resourceKey } from '@spinajs/authz';
import type { DecisionRequest, EvaluationContext, ModelCapabilities, ModelSummary, Permission, PermissionDef, PermissionRegistry, Principal, ResourceRef, ResourceType, Vote } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { fsAccessConfigs } from '../config/index.js';
import { parseFsRef } from '../refs/index.js';
import { resolveFsParents } from '../resolvers/index.js';

export const FS_INHERIT_MODEL = 'fs-inherit';

const TYPES: readonly ResourceType[] = Object.freeze(['file', 'dir']);

const CAPABILITIES: ModelCapabilities = Object.freeze({ effects: Object.freeze(['permit'] as const), residuals: Object.freeze([]), sync: 'never', fields: false, needsSubject: false, resourceTypes: TYPES });

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * `fs-inherit` (design §13): permits `fs:<op>` on a file or directory of a filesystem checked in this model's
 * domain when the principal holds `<parent type>:<action>` on one of the path's domain parents (FsPathResolver,
 * nearest first), where `authz.fs.<name>.inherit` maps `fs:<op>`, or a permission that implies it, to `<action>`.
 * A parent decision counts only when it is allowed with a TRUE residual: the parent row is not at hand to settle
 * a condition. It never denies; without a mapping, parents or a parent permit it abstains.
 */
export class FsInheritModel extends AuthorizationModel {
  readonly name = FS_INHERIT_MODEL;
  readonly capabilities = CAPABILITIES;
  private registry: PermissionRegistry | undefined;
  private maps: ReadonlyMap<string, Readonly<Record<Permission, string>>> = new Map();

  constructor(
    /** The domain whose filesystems this instance serves; not `ctx.domain`, since a child domain may boot it first. */
    readonly domain: string,
    /** Where the Configuration and the FsPathResolvers are resolved. */
    protected readonly container: IContainer = DI.RootContainer,
  ) {
    super();
  }

  init(ctx: { readonly permissions: PermissionRegistry }): void {
    this.registry = ctx.permissions;
    const maps = new Map<string, Readonly<Record<Permission, string>>>();
    for (const [name, config] of fsAccessConfigs(this.container)) {
      if (config.mode !== 'off' && config.domain === this.domain && config.inherit) maps.set(name, config.inherit);
    }
    this.maps = maps;
  }

  applies(permission: PermissionDef, type: ResourceType): boolean {
    if (!TYPES.includes(type)) return false;
    for (const map of this.maps.values()) if (this.actions(map, permission.name, this.registry).length > 0) return true;
    return false;
  }

  async evaluate(req: DecisionRequest, ctx: EvaluationContext): Promise<Vote> {
    const parsed = req.resource.id === undefined || req.resource.id === null ? undefined : parseFsRef(req.resource);
    const map = parsed && parsed.type !== 'fs' ? this.maps.get(parsed.fs) : undefined;
    const actions = map ? this.actions(map, req.permission, ctx.permissions) : [];
    if (!parsed || actions.length === 0) return abstain(this.name);

    const parents = await resolveFsParents(parsed.fs, parsed.path, this.container);
    const errors: string[] = [];
    for (const parent of parents) {
      for (const action of actions) {
        const permission = `${parent.type}:${action}`;
        const def = isPermission(permission) ? ctx.permissions.get(permission) : undefined;
        if (!def || !def.types.includes(parent.type)) {
          errors.push(`authz.fs.${parsed.fs}.inherit maps ${req.permission} to ${permission}, which is not a permission registered on type ${JSON.stringify(parent.type)}`);
          continue;
        }
        let allowed: boolean;
        let validUntil: Date | undefined;
        try {
          const decision = await ctx.check(delegated(req, permission, parent));
          allowed = decision.allowed && decision.residual.op === 'true';
          validUntil = decision.validUntil;
        } catch (e) {
          errors.push(`${permission} on ${resourceKey(parent)}: ${describe(e)}`);
          continue;
        }
        ctx.trace({ step: 'inherit', note: `${permission} on ${resourceKey(parent)}: ${allowed ? 'allowed' : 'not allowed unconditionally'}` });
        if (allowed) return { model: this.name, permitWhen: TRUE, denyWhen: FALSE, cacheable: true, ...(validUntil ? { validUntil } : {}) };
      }
    }
    // Fail closed (B04): a parent that could not be checked may be the one that permits, but its error must show.
    if (errors.length > 0) return { model: this.name, permitWhen: FALSE, denyWhen: FALSE, cacheable: false, error: errors.join('; ') };
    return abstain(this.name);
  }

  /**
   * Every permission the model may grant at `at`, conditional: it depends on the path's parents. So `covers` asks
   * the holder to hold each of them unconditionally (fail closed). At `$global` the filesystems of the domain, at a
   * file or directory those of its filesystem, elsewhere none.
   */
  async summarize(_principal: Principal, at: ResourceRef, ctx: EvaluationContext): Promise<ModelSummary> {
    let maps: Iterable<Readonly<Record<Permission, string>>> = [];
    if (at.type === GLOBAL.type) maps = this.maps.values();
    else if (TYPES.includes(at.type)) {
      const parsed = at.id === undefined || at.id === null ? undefined : parseFsRef(at);
      maps = parsed ? [this.maps.get(parsed.fs)].filter((m) => m !== undefined) : this.maps.values();
    }
    const names = new Set<Permission>();
    for (const map of maps) for (const key of Object.keys(map)) for (const name of implied(key, ctx.permissions)) names.add(name);
    const permissions = [...names]
      .filter((name) => {
        const def = ctx.permissions.get(name);
        return def !== undefined && (at.type === GLOBAL.type || def.types.includes(at.type));
      })
      .sort()
      .map((name) => ({ name, conditional: true }));
    return { model: this.name, permissions };
  }

  /** The actions `map` gives `permission`: its own entry first, then those of the permissions that imply it. */
  private actions(map: Readonly<Record<Permission, string>>, permission: Permission, registry: PermissionRegistry | undefined): readonly string[] {
    const out: string[] = [];
    for (const key of [permission, ...(registry && isPermission(permission) ? registry.impliedBy(permission) : [])]) {
      if (Object.hasOwn(map, key) && !out.includes(map[key])) out.push(map[key]);
    }
    return out;
  }
}

const abstain = (model: string): Vote => ({ model, permitWhen: FALSE, denyWhen: FALSE, cacheable: true });

/** The parent check as the principal the models run with, keeping the actor (ABAC `actorTypes`) and env; the parent row is not loaded. */
function delegated(req: DecisionRequest, permission: Permission, parent: ResourceRef): Omit<DecisionRequest, 'explain'> {
  return { principal: req.principal, permission, resource: parent, ...(req.actor ? { actor: req.actor } : {}), ...(req.env ? { env: req.env } : {}) };
}

/** `name` and every permission it implies, transitively. */
function implied(name: Permission, registry: PermissionRegistry): readonly Permission[] {
  const out = new Set<Permission>();
  const queue = [name];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (out.has(next)) continue;
    out.add(next);
    queue.push(...(registry.get(next)?.implies ?? []));
  }
  return [...out];
}
