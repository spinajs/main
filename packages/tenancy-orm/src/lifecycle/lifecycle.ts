import { DI, Injectable } from '@spinajs/di';
import { InvalidArgument, InvalidOperation, NotSupported, ResourceDuplicated } from '@spinajs/exceptions';
import { isTenantId, tenantRef } from '@spinajs/tenancy';
import type { TenantPlacement, TenantRecord } from '@spinajs/tenancy';
import { DateTime } from 'luxon';

import { TenantModel } from '../models/TenantModel.js';
import { toTenantRecord } from '../records.js';
import { TenantStateService } from '../states.js';
import { announce, inTenant, messageOf, refuseTenantScope } from './announce.js';
import { TenantLifecycle, TenantSeeder } from './contracts.js';
import type { ExportReport, MigrationReport, TenantProvisionInput } from './contracts.js';
import { assertDomainsFree, normalizeDomains } from './domains.js';
import { LIFECYCLE_LEASE_MS, claimLifecycle } from './lease.js';
import type { LifecycleLease } from './lease.js';
import { requireRow, writeLifecycle } from './record.js';
import type { LifecycleOperation, LifecycleOperationKind, TenantLifecycleState } from './state.js';

const NAME_MAX = 128;

const iso = (ms: number): string => new Date(ms).toISOString();

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** What `provision()` writes, checked and normalized. */
export interface ProvisionPlan {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly domains: readonly string[];
  readonly settings: Record<string, unknown>;
  readonly placement: TenantPlacement | undefined;
}

/** The steps of one operation: a step that finished is skipped when the operation runs again. */
export interface LifecycleSteps {
  step(name: string, fn: () => Promise<void>): Promise<void>;
  /** Writes `patch` into the lifecycle record while the operation holds the tenant. */
  record(patch: Partial<TenantLifecycleState>): Promise<void>;
}

async function tenantSeeders(): Promise<TenantSeeder[]> {
  if (!DI.RootContainer.hasRegistered(TenantSeeder)) return [];
  const resolved: unknown = await DI.resolve(Array.ofType(TenantSeeder));
  const seeders = Array.isArray(resolved) ? resolved.filter((s): s is TenantSeeder => s instanceof TenantSeeder) : [];
  const names = new Set<string>();
  for (const seeder of seeders) {
    if (names.has(seeder.name)) throw new InvalidOperation(`tenancy-orm: two tenant seeders are named "${seeder.name}"`);
    names.add(seeder.name);
  }
  return seeders.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

function assertMigratable(row: TenantModel): void {
  if (row.state === 'active' || row.state === 'suspended') return;
  throw new InvalidOperation(`tenancy-orm: tenant "${row.id}" is ${row.state}; ${row.state === 'provisioning' ? 'provision() migrates it' : 'a tenant on its way out is not migrated'}`);
}

@Injectable(TenantLifecycle)
export class DefaultTenantLifecycle extends TenantLifecycle {
  public async provision(input: TenantProvisionInput): Promise<TenantRecord> {
    refuseTenantScope('provision');
    const plan = this.planProvision(input);
    const row = await TenantModel.where('id', plan.id).first();
    if (row) this.assertResumable(row, plan);
    else await this.insertProvisioning(plan);

    const body = async (steps: LifecycleSteps): Promise<TenantRecord> => {
      await this.seed(plan.id, steps);
      await this.activate(plan.id, steps);
      return toTenantRecord(await requireRow(plan.id));
    };
    return this.operate(plan.id, 'provision', undefined, body, (current) => this.assertResumable(current, plan));
  }

  public suspend(_id: string, _reason: string): Promise<void> {
    return Promise.reject(new NotSupported('tenancy-orm: suspend() arrives with v4-tl-02a-suspend-resume'));
  }

  public resume(_id: string): Promise<void> {
    return Promise.reject(new NotSupported('tenancy-orm: resume() arrives with v4-tl-02a-suspend-resume'));
  }

  public async migrate(id: string): Promise<MigrationReport> {
    refuseTenantScope('migrate');
    const row = await requireRow(id);
    assertMigratable(row);
    return { tenant: row.id, status: 'skipped', executed: [] };
  }

  public export(_id: string, _target: { fs: string; path: string }): Promise<ExportReport> {
    return Promise.reject(new NotSupported('tenancy-orm: export() arrives with v4-tl-03-export-delete'));
  }

  public delete(_id: string, _options: { reason: string; keepExport?: boolean }): Promise<void> {
    return Promise.reject(new NotSupported('tenancy-orm: delete() arrives with v4-tl-03b-tenant-delete'));
  }

  /** Milliseconds since the epoch; a test moves it to let a lease expire. */
  protected now(): number {
    return Date.now();
  }

  protected states(): Promise<TenantStateService> {
    return Promise.resolve(DI.resolve(TenantStateService));
  }

  protected planProvision(input: TenantProvisionInput): ProvisionPlan {
    const id = tenantRef(input.id).id;
    if (!isTenantId(input.slug)) throw new InvalidArgument('tenancy-orm: a slug is 1 to 64 characters of a-z, 0-9, "_" and "-"', 'slug');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name === '' || name.length > NAME_MAX) throw new InvalidArgument(`tenancy-orm: a tenant name is 1 to ${NAME_MAX} characters`, 'name');
    if (input.placement !== undefined) throw new NotSupported('tenancy-orm: a tenant with a schema placement is provisioned from v4-tl-02b-provision-schema on');
    if (input.settings !== undefined && !isRecord(input.settings)) throw new InvalidArgument('tenancy-orm: the settings of a tenant are an object', 'settings');
    return { id, slug: input.slug, name, domains: normalizeDomains(input.domains ?? []), settings: { ...(input.settings ?? {}) }, placement: undefined };
  }

  /** A retry repairs a provisioning that did not finish; it does not edit it. */
  protected assertResumable(row: TenantModel, plan: ProvisionPlan): void {
    const unfinished = row.lifecycleRecord().operation?.kind === 'provision';
    if (row.state === 'active' && !unfinished) throw new ResourceDuplicated(`tenancy-orm: tenant "${row.id}" exists and is active`);
    if (row.state !== 'provisioning' && !(row.state === 'active' && unfinished)) {
      throw new InvalidOperation(`tenancy-orm: tenant "${row.id}" is ${row.state}; only a provisioning that did not finish is provisioned again`);
    }
    const same = row.slug === plan.slug && row.name === plan.name && (row.placement?.schema ?? null) === (plan.placement?.schema ?? null);
    if (!same) throw new InvalidArgument(`tenancy-orm: tenant "${row.id}" is being provisioned with another slug, name or placement; retry with the input of the first call`, 'input');
  }

  protected async insertProvisioning(plan: ProvisionPlan): Promise<void> {
    if (await TenantModel.where('slug', plan.slug).first()) throw new ResourceDuplicated(`tenancy-orm: the slug "${plan.slug}" belongs to another tenant`);
    await assertDomainsFree(plan.id, plan.domains);
    const now = DateTime.utc();
    const lifecycle: TenantLifecycleState = { operation: { kind: 'provision', done: ['record'], startedAt: iso(this.now()) } };
    await new TenantModel({ id: plan.id, slug: plan.slug, name: plan.name, state: 'provisioning', domains: [...plan.domains], placement: plan.placement ?? null, settings: plan.settings, lifecycle, created_at: now, updated_at: now }).insert();
    // A lookup of the id before this insert left a remembered miss in the registry cache.
    await announce(plan.id);
  }

  protected async seed(id: string, steps: LifecycleSteps): Promise<void> {
    for (const seeder of await tenantSeeders()) {
      await steps.step(`seed:${seeder.name}`, async () => {
        const record = toTenantRecord(await requireRow(id));
        try {
          await inTenant(id, () => seeder.seed(record));
        } catch (err) {
          throw new InvalidOperation(`tenancy-orm: the tenant seeder "${seeder.name}" failed for tenant "${id}": ${messageOf(err)}`, err);
        }
      });
    }
  }

  protected async activate(id: string, steps: LifecycleSteps): Promise<void> {
    await steps.step('activate', async () => {
      if ((await requireRow(id)).state !== 'active') await (await this.states()).transition(id, 'active');
    });
  }

  protected async leased<T>(id: string, fn: (lease: LifecycleLease) => Promise<T>): Promise<T> {
    const lease = await claimLifecycle(id, () => this.now());
    // One step (a seeder, a large table) may outlast the lease; a renewal that fails is met by the next fenced write.
    const beat = setInterval(() => void lease.renew().catch(() => undefined), LIFECYCLE_LEASE_MS / 3);
    beat.unref();
    try {
      return await fn(lease);
    } finally {
      clearInterval(beat);
      await lease.release();
    }
  }

  /**
   * Runs `body` as operation `kind` of tenant `id`, holding its lease: the steps it finishes are written down, a
   * step that throws is written down as failed, and the record of the operation goes when `body` returns. `admit`
   * checks the row again once the lease is held: what was read before may have changed until then.
   */
  protected operate<T>(id: string, kind: LifecycleOperationKind, reason: string | undefined, body: (steps: LifecycleSteps) => Promise<T>, admit?: (row: TenantModel) => void): Promise<T> {
    return this.leased(id, async (lease) => {
      const row = await requireRow(id);
      admit?.(row);
      let state = row.lifecycleRecord();
      const running = state.operation;
      // A deletion may take over a provisioning that failed for good; nothing else takes over.
      if (running !== undefined && running.kind !== kind && !(kind === 'delete' && running.kind === 'provision')) {
        throw new InvalidOperation(`tenancy-orm: tenant "${id}" is in the middle of ${running.kind}; finish it before ${kind}`);
      }
      const resumed = running?.kind === kind ? running : undefined;
      const done = new Set(resumed?.done ?? []);
      const why = reason ?? resumed?.reason;
      const head = { kind, startedAt: resumed?.startedAt ?? iso(this.now()), ...(why === undefined ? {} : { reason: why }) };
      const operation = (): LifecycleOperation => ({ ...head, done: [...done] });
      const save = async (next: TenantLifecycleState): Promise<void> => {
        await writeLifecycle(id, next, lease.fence);
        state = next;
        await lease.renew();
      };

      await save({ ...state, operation: operation() });
      const steps: LifecycleSteps = {
        step: async (name, fn) => {
          if (done.has(name)) return;
          try {
            await fn();
          } catch (err) {
            // The step's error is the one to report; a lost lease cannot write the failure.
            await save({ ...state, operation: { ...operation(), failed: { step: name, message: messageOf(err), at: iso(this.now()) } } }).catch(() => undefined);
            throw err;
          }
          done.add(name);
          await save({ ...state, operation: operation() });
        },
        record: (patch) => save({ ...state, ...patch, operation: operation() }),
      };

      const result = await body(steps);
      await save({ ...state, operation: undefined });
      return result;
    });
  }
}
