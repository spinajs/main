import type { Principal } from '@spinajs/principal';

export interface TenantRef {
  readonly id: string;
}

export type TenantScope = { readonly kind: 'tenant'; readonly tenant: TenantRef } | { readonly kind: 'all'; readonly reason: string };

/** The key in the shared request store (`DI.resolve(AsyncLocalStorage)`); absent means no scope. */
export interface ITenantAsyncStorage {
  Tenant?: TenantScope;
}

export const TENANT_STATES = ['provisioning', 'active', 'suspended', 'deleting', 'deleted'] as const;

export type TenantState = (typeof TENANT_STATES)[number];

export type TenantPlacement = { kind: 'schema'; schema: string };

export interface TenantRecord extends TenantRef {
  readonly slug: string;
  readonly name: string;
  readonly state: TenantState;
  readonly domains: readonly string[];
  readonly placement?: TenantPlacement;
  readonly settings: Readonly<Record<string, unknown>>;
}

/** What a resolver proposes: a tenant id, or a slug or a domain for the registry to look up. */
export type TenantProposal = string | { readonly slug: string } | { readonly domain: string };

export abstract class TenantRegistry {
  /** False for a registry that already answers from memory: `tenantRegistry()` then caches nothing of it. */
  public get cacheable(): boolean {
    return true;
  }

  public abstract get(id: string): Promise<TenantRecord | undefined>;

  public abstract find(by: { slug?: string; domain?: string }): Promise<TenantRecord | undefined>;

  public abstract list(filter?: { states?: TenantState[] }): AsyncIterable<TenantRecord>;
}

export abstract class TenantResolver {
  /** False for a source the client sets on its own (a header): honoured only for an authenticated principal. */
  public abstract readonly trusted: boolean;

  public abstract resolve(source: unknown): TenantProposal | undefined;
}

export abstract class TenantAccess {
  public abstract canEnter(principal: Principal, tenant: TenantRecord): Promise<boolean>;
}

export interface TenantRunFailure {
  readonly tenant: string;
  readonly error: unknown;
}

export interface TenantRunReport {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: readonly TenantRunFailure[];
}
