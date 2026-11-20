import { PolicyHashSource, thrownError } from '@spinajs/authz';
import type { AuthzService } from '@spinajs/authz';
import type { CompiledPolicy, MergeConflict, PolicyIR } from '@spinajs/authz-ir';
import { Injectable, Singleton } from '@spinajs/di';

import { ormLog } from '../host.js';
import { compileDomainPolicy } from '../policy/compile.js';
import { readPolicyVersion, recordPolicyVersion } from './policy-version.js';
import { policyVersionMode } from './schema.js';

export interface PolicyVersionSnapshot {
  readonly domain: string;
  readonly hash: string;
  readonly ir: PolicyIR;
  readonly canonical: string;
  readonly conflicts: readonly MergeConflict[];
  readonly compiledAt: Date;
  /** true: stored now, false: known already, undefined: not stored ('hash' mode, the process degraded after a failed probe, or the write gave up). */
  readonly recorded: Promise<boolean | undefined>;
}

const NOT_RECORDED: Promise<undefined> = Promise.resolve(undefined);

const moduleNotFound = (e: unknown): boolean => e instanceof Error && 'code' in e && e.code === 'ERR_MODULE_NOT_FOUND';

/** The hash of the config policy IR each domain booted with (G9, G14), stored in authz_policy_version by every node. */
@Singleton()
@Injectable(PolicyHashSource)
export class IRPolicyHashSource extends PolicyHashSource {
  /** For tests. */
  public retryDelaysMs: readonly number[] = [1000, 5000, 30000];
  private readonly snapshots = new Map<string, PolicyVersionSnapshot>();
  private readonly writes = new Map<string, Promise<boolean | undefined>>();
  private readonly warned = new Set<string>();
  private probeResult: Promise<boolean> | undefined;
  private degraded = false;

  policyHash(domain: string): string | undefined {
    return this.snapshots.get(domain)?.hash;
  }

  current(domain: string): PolicyVersionSnapshot | undefined {
    return this.snapshots.get(domain);
  }

  async prepare(domain: string, service: AuthzService): Promise<void> {
    // A re-boot in mode 'off' or a failing compile must not leave the previous boot's snapshot behind (D9).
    this.snapshots.delete(domain);
    const mode = policyVersionMode();
    if (mode === 'off') return;
    const started = performance.now();
    let compiled: CompiledPolicy;
    try {
      compiled = await compileDomainPolicy(domain, service);
    } catch (e) {
      if (!moduleNotFound(e)) throw e;
      this.warnOnce('authz-ir', { domain }, "authz-orm: @spinajs/authz-ir is not installed; decision records of domain ${domain} carry policyHash 'unknown'");
      return;
    }
    const { hash, ir, canonical, conflicts } = compiled;
    if (conflicts.length > 0) this.warnOnce(`conflicts:${hash}`, { domain, paths: conflicts.map((c) => c.path).join(', ') }, 'authz-orm: domain ${domain}, policy IR conflicts at ${paths}; the first definition is kept');
    const recorded = mode === 'record' && !this.degraded ? this.record(hash, canonical) : NOT_RECORDED;
    this.snapshots.set(domain, Object.freeze({ domain, hash, ir, canonical, conflicts, compiledAt: new Date(), recorded }));
    ormLog().info({ domain, hash, ms: Math.round(performance.now() - started), opaque: ir.opaque.length }, 'authz-orm: domain ${domain} runs policy ${hash} (${ms} ms, ${opaque} opaque)');
  }

  protected write(hash: string, canonical: string): Promise<boolean> {
    return recordPolicyVersion(hash, canonical);
  }

  /** One read on the authz connection; any failure means the store is not usable from this process. */
  protected async probe(hash: string): Promise<void> {
    await readPolicyVersion(hash);
  }

  private record(hash: string, canonical: string): Promise<boolean | undefined> {
    let p = this.writes.get(hash);
    if (p === undefined) {
      p = this.probed(hash).then((ok) => (ok ? this.attempt(hash, canonical, 0) : undefined));
      this.writes.set(hash, p);
    }
    return p;
  }

  /** The first write of the process probes the store once; a missing connection alias, a missing table or a database that is down degrades the process to 'hash' with one warning instead of retrying and logging an error on every boot. */
  private probed(hash: string): Promise<boolean> {
    this.probeResult ??= this.probe(hash).then(
      () => true,
      (e: unknown) => {
        this.degraded = true;
        ormLog().warn({ error: thrownError(e) }, "authz-orm: authz_policy_version is not reachable on the authz connection; this process cites policy hashes without storing them (mode 'hash'); run `spinajs authz:compile --record` where the database is reachable");
        return false;
      },
    );
    return this.probeResult;
  }

  private async attempt(hash: string, canonical: string, n: number): Promise<boolean | undefined> {
    try {
      return await this.write(hash, canonical);
    } catch (e) {
      if (n < this.retryDelaysMs.length) {
        await new Promise((resolve) => setTimeout(resolve, this.retryDelaysMs[n]).unref());
        return this.attempt(hash, canonical, n + 1);
      }
      // A later domain boot tries again.
      this.writes.delete(hash);
      ormLog().error({ error: thrownError(e), hash }, 'authz-orm: policy version ${hash} could not be stored in authz_policy_version; replay of its decisions needs `spinajs authz:compile --record`');
      return undefined;
    }
  }

  private warnOnce(key: string, data: Record<string, unknown>, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    ormLog().warn(data, message);
  }
}
