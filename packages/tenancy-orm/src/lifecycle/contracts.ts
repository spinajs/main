import type { TenantPlacement, TenantRecord } from '@spinajs/tenancy';

export interface TenantProvisionInput {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  /** Refused until schema mode is provisioned (`v4-tl-02b-provision-schema`). */
  readonly placement?: TenantPlacement;
  readonly settings?: Record<string, unknown>;
  /** Host names the tenant answers to; lower-cased, each refused when another tenant lists it. */
  readonly domains?: readonly string[];
}

export interface MigrationReport {
  readonly tenant: string;
  /** `skipped`: the tenant has no placement; its tables are the shared ones `migrate-up` migrates. */
  readonly status: 'migrated' | 'current' | 'skipped';
  readonly schema?: string;
  /** Class names, in the order they ran. */
  readonly executed: readonly string[];
}

export interface ExportedModel {
  readonly model: string;
  readonly file: string;
  readonly rows: number;
}

export interface ExportedPart {
  readonly part: string;
  readonly items: number;
}

export interface ExportReport {
  readonly tenant: string;
  readonly target: { readonly fs: string; readonly path: string };
  readonly models: readonly ExportedModel[];
  readonly parts: readonly ExportedPart[];
  readonly at: string;
}

/** The lifecycle of a tenant: every operation refuses to run inside a tenant scope and enters the tenant itself. */
export abstract class TenantLifecycle {
  public abstract provision(input: TenantProvisionInput): Promise<TenantRecord>;
  public abstract suspend(id: string, reason: string): Promise<void>;
  public abstract resume(id: string): Promise<void>;
  public abstract migrate(id: string): Promise<MigrationReport>;
  public abstract export(id: string, target: { fs: string; path: string }): Promise<ExportReport>;
  public abstract delete(id: string, options: { reason: string; keepExport?: boolean }): Promise<void>;
}

/** The data a new tenant starts with; every registered seeder runs once while the tenant is provisioned. */
export abstract class TenantSeeder {
  /** Recorded as the step `seed:<name>`: a seeder that finished is not run again when provisioning resumes. */
  public abstract readonly name: string;
  /** Lower runs first; equal orders run by name. */
  public readonly order: number = 0;
  /** Runs inside `runInTenant(tenant.id)`, the tenant still `provisioning`. */
  public abstract seed(tenant: TenantRecord): Promise<void>;
}
