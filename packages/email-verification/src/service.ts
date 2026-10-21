import { AutoinjectService, Config } from '@spinajs/configuration';
import { AsyncService, Injectable } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';

import './register-schema.js';
import { DomainVerifier, EmailVerificationStore, UNKNOWN } from './contracts.js';
import type { CachedVerdict, DomainVerdict, EmailCheckResult } from './contracts.js';
import { emailDomain } from './domain.js';
import { LruCache } from './lru.js';
import type { EmailVerificationOptions } from './options.js';
import { withTimeout } from './timeout.js';

export interface VerifierOutcome {
  readonly verifier: string;
  readonly verdict: DomainVerdict;
  readonly error?: string;
}

@Injectable()
export class EmailVerification extends AsyncService {
  @Logger('email-verification')
  protected Log: Log;

  @Config('emailVerification')
  protected Options: EmailVerificationOptions;

  @AutoinjectService('emailVerification.verifiers', DomainVerifier)
  protected Verifiers: Map<string, DomainVerifier>;

  @AutoinjectService('emailVerification.store', EmailVerificationStore)
  protected Store: EmailVerificationStore;

  protected Lru: LruCache<CachedVerdict>;

  protected InFlight = new Map<string, Promise<EmailCheckResult>>();

  public async resolve(): Promise<void> {
    const missing = this.Options.verifiers.map((v) => v.service).filter((s) => !this.Verifiers?.has(s));
    if (missing.length > 0) {
      throw new InvalidOperation(`emailVerification.verifiers names ${missing.join(', ')}, which no DomainVerifier registers`);
    }
    this.Lru = new LruCache(this.Options.lru.maxEntries);
    await super.resolve();
  }

  public async check(email: string): Promise<EmailCheckResult> {
    if (!this.Options.enabled) return { allowed: true, domain: emailDomain(email) };
    const domain = emailDomain(email);
    if (domain === null) return this.refused(null, 'address', 'invalid_domain');

    const running = this.InFlight.get(domain);
    if (running) return running;
    const decision = this.decide(domain).finally(() => this.InFlight.delete(domain));
    this.InFlight.set(domain, decision);
    return decision;
  }

  /** Every verifier's live answer, in config order, with no cache read or write. */
  public async explain(email: string): Promise<{ domain: string | null; outcomes: VerifierOutcome[] }> {
    const domain = emailDomain(email);
    const outcomes: VerifierOutcome[] = [];
    if (domain === null) return { domain, outcomes };
    for (const verifier of this.ordered()) {
      try {
        outcomes.push({ verifier: verifier.name, verdict: await withTimeout(verifier.verify(domain), this.Options.timeoutMs) });
      } catch (err) {
        outcomes.push({ verifier: verifier.name, verdict: UNKNOWN, error: (err as Error).message });
      }
    }
    return { domain, outcomes };
  }

  protected async decide(domain: string): Promise<EmailCheckResult> {
    for (const verifier of this.ordered()) {
      const verdict = await this.verdictOf(verifier, domain);
      const source = verdict.source ?? verifier.name;
      if (verdict.result === 'allow') return { allowed: true, domain, source };
      if (verdict.result === 'refuse') return this.refused(domain, source, verdict.reason ?? 'refused');
    }
    return { allowed: true, domain };
  }

  protected ordered(): DomainVerifier[] {
    return this.Options.verifiers.map((v) => this.Verifiers.get(v.service)!);
  }

  protected async verdictOf(verifier: DomainVerifier, domain: string): Promise<DomainVerdict> {
    const key = `${verifier.name}:${domain}`;
    if (verifier.cacheable) {
      const cached = this.Lru.get(key) ?? (await this.readStore(verifier.name, domain));
      if (cached) return cached;
    }

    let verdict: DomainVerdict;
    try {
      verdict = await withTimeout(verifier.verify(domain), this.Options.timeoutMs);
    } catch (err) {
      this.Log.warn({ verifier: verifier.name, domain, error: (err as Error).message }, 'Verifier ${verifier} failed for ${domain}: ${error}');
      return this.Options.onError === 'refuse' ? { result: 'refuse', reason: 'verifier_error' } : UNKNOWN;
    }

    const ttl = verifier.cacheable ? verifier.ttlFor(verdict) : 0;
    if (ttl > 0) {
      const cached: CachedVerdict = { ...verdict, checkedAt: Date.now() };
      this.Lru.set(key, cached, Math.min(ttl, this.Options.lru.ttlSeconds) * 1000);
      await this.writeStore(verifier.name, domain, cached, ttl);
    }
    return verdict;
  }

  protected async readStore(verifier: string, domain: string): Promise<CachedVerdict | null> {
    try {
      const cached = await withTimeout(this.Store.getVerdict(verifier, domain), this.Options.timeoutMs);
      if (cached) this.Lru.set(`${verifier}:${domain}`, cached, this.Options.lru.ttlSeconds * 1000);
      return cached;
    } catch (err) {
      this.Log.warn({ verifier, domain, error: (err as Error).message }, 'Cannot read the cached ${verifier} verdict of ${domain}: ${error}');
      return null;
    }
  }

  protected async writeStore(verifier: string, domain: string, verdict: CachedVerdict, ttl: number): Promise<void> {
    try {
      await withTimeout(this.Store.setVerdict(verifier, domain, verdict, ttl), this.Options.timeoutMs);
    } catch (err) {
      this.Log.warn({ verifier, domain, error: (err as Error).message }, 'Cannot cache the ${verifier} verdict of ${domain}: ${error}');
    }
  }

  protected refused(domain: string | null, source: string, reason: string): EmailCheckResult {
    this.Log.info({ domain, source, reason }, 'Email domain ${domain} refused by ${source}: ${reason}');
    return { allowed: false, code: this.Options.refuseCode, domain, source, reason };
  }
}
