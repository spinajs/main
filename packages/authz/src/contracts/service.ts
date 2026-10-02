import { AsyncService } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import type { Ceiling, Principal, PrincipalRef, ResourceRef, ResourceType } from './principal.js';
import type { Permission } from './permission.js';
import type { ResourceFilter } from './filter.js';
import type { Decision, DecisionRequest, FieldSet, Trace } from './decision.js';
import type { AuthorizationModel, ModelSummary } from './model.js';

// The @PerChildInstance() implementation is the host's.
export abstract class AuthzService extends AsyncService {
  abstract readonly domain: string; // 'root' or a child domain name
  abstract current(): Principal; // ALS principal, else UNATTENDED
  abstract runAs<T>(principal: Principal, reason: string, fn: () => Promise<T>): Promise<T>;
  abstract check(req: CheckInput): Promise<Decision>;
  abstract can(principal: Principal, permission: Permission, resource?: ResourceRef | object, subject?: unknown): Promise<boolean>;
  abstract assert(principal: Principal, permission: Permission, resource?: ResourceRef | object, subject?: unknown): Promise<Decision>; // throws AccessDenied
  abstract checkMany(principal: Principal, permissions: readonly Permission[], resource?: ResourceRef | object): Promise<ReadonlyMap<Permission, Decision>>;
  abstract filter(principal: Principal, permission: Permission, type: ResourceType): Promise<ResourceFilter>;
  abstract filterNow(principal: Principal, permission: Permission, type: ResourceType): ResourceFilter | undefined; // undefined => a model needs IO
  abstract explain(req: CheckInput): Promise<Decision>; // trace on, all models evaluated
  abstract summary(principal: Principal, at?: ResourceRef): Promise<AccessSummary>;
  /** Holder's combined permission set at `at` (all models, incl. ABAC) strictly contains target's; impersonation rule (B26). */
  abstract covers(holder: Principal, target: Principal, at?: ResourceRef): Promise<boolean>;
  abstract preload(principal: Principal): Promise<void>;
  abstract invalidate(tags: readonly string[]): void;
  abstract models(): readonly AuthorizationModel[];
}

export type CheckInput = Omit<DecisionRequest, 'resource'> & { readonly resource?: ResourceRef | object };

// Root singleton; the implementation is the host's.
export abstract class AuthzDomains {
  abstract create(name: string, parent?: string): IContainer; // child of 'root' by default
  abstract container(name: string): IContainer;
  abstract service(name: string): AuthzService;
  abstract names(): readonly string[];
}

export interface AccessSummary {
  readonly principal: PrincipalRef;
  readonly ceiling?: Ceiling;
  readonly models: readonly ModelSummary[];
  readonly permissions: ReadonlyArray<{ name: Permission; conditional: boolean; fields?: FieldSet }>; // GLOBAL, combined
}

export abstract class DecisionCache {
  abstract get(key: string): Decision | undefined;
  abstract set(key: string, d: Decision, tags: readonly string[], ttlMs: number): void;
  abstract invalidate(tags: readonly string[]): void;
}

export interface AuthzChange {
  readonly domain?: string;
  readonly tags: readonly string[];
  readonly actor?: PrincipalRef;
  readonly at: Date;
}

export abstract class ChangeBus {
  abstract publish(change: AuthzChange): Promise<void>;
  abstract subscribe(fn: (c: AuthzChange) => void): () => void;
}

export abstract class DecisionAudit {
  // 'admin': one entry per AuthzAdmin command
  abstract record(e: { kind: 'deny' | 'runAs' | 'unscoped' | 'explain' | 'system' | 'admin'; principal: PrincipalRef; permission?: Permission; resource?: ResourceRef; reason?: string; trace?: Trace; command?: unknown }): void | Promise<void>;
}
