import { Resolver } from 'node:dns/promises';
import { Config } from '@spinajs/configuration';
import { Autoinject, Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';

import { DomainVerifier, UNKNOWN } from '../contracts.js';
import type { DomainVerdict } from '../contracts.js';
import { normalizeDomain } from '../domain.js';
import type { DnsOptions } from '../options.js';
import { ListVerifier } from './list.js';

export interface MxResolver {
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  resolve4(domain: string): Promise<string[]>;
  resolve6(domain: string): Promise<string[]>;
}

const codeOf = (err: unknown) => (err as { code?: string } | null)?.code;
const refuse = (reason: string): DomainVerdict => ({ result: 'refuse', reason });
const RESOLVES: DomainVerdict = { result: 'unknown', reason: 'resolves' };
const NEGATIVE = new Set(['domain_not_found', 'no_mail_host', 'disposable_mx']);

@Injectable(DomainVerifier)
export class DnsVerifier extends DomainVerifier {
  public readonly name = 'dns';
  public readonly cacheable = true;

  @Logger('email-verification')
  protected Log: Log;

  @Config('emailVerification.dns')
  protected Options: DnsOptions;

  @Autoinject(ListVerifier)
  protected Lists: ListVerifier;

  protected Resolver: MxResolver;

  public async resolve(): Promise<void> {
    this.Resolver = this.createResolver();
    await super.resolve();
  }

  public async verify(domain: string): Promise<DomainVerdict> {
    let mx: { exchange: string; priority: number }[];
    try {
      mx = await this.Resolver.resolveMx(domain);
    } catch (err) {
      const code = codeOf(err);
      if (code === 'ENOTFOUND') return refuse('domain_not_found');
      if (code !== 'ENODATA') {
        this.logUnexpected(domain, err);
        return UNKNOWN;
      }
      mx = [];
    }

    if (mx.length === 0) return this.implicitMx(domain);
    if (mx.length === 1 && (mx[0].exchange === '' || mx[0].exchange === '.')) return refuse('null_mx');
    for (const { exchange } of mx) {
      const host = normalizeDomain(exchange);
      if (host !== null && this.Lists.match('block-mx', host) !== undefined) return refuse('disposable_mx');
    }
    return RESOLVES;
  }

  public ttlFor(verdict: DomainVerdict): number {
    if (verdict.reason === undefined) return 0;
    return NEGATIVE.has(verdict.reason) ? this.Options.ttl.negative : this.Options.ttl.positive;
  }

  protected createResolver(): MxResolver {
    const resolver = new Resolver({ timeout: this.Options.timeoutMs, tries: this.Options.tries });
    if (this.Options.servers.length > 0) resolver.setServers(this.Options.servers);
    return resolver;
  }

  protected logUnexpected(domain: string, err: unknown): void {
    const code = codeOf(err);
    if (typeof code === 'string' && code.startsWith('E')) return;
    this.Log.warn({ domain, error: err instanceof Error ? err.message : String(err) }, 'DNS lookup for ${domain} failed unexpectedly: ${error}');
  }

  /** RFC 5321 §5.1: with no MX, the domain's A or AAAA host receives its mail. */
  protected async implicitMx(domain: string): Promise<DomainVerdict> {
    for (const lookup of [() => this.Resolver.resolve4(domain), () => this.Resolver.resolve6(domain)]) {
      try {
        if ((await lookup()).length > 0) return RESOLVES;
      } catch (err) {
        // The MX lookup said the name exists, so ENOTFOUND here is a flaky resolver, not "no address".
        if (codeOf(err) !== 'ENODATA') {
          this.logUnexpected(domain, err);
          return UNKNOWN;
        }
      }
    }
    return refuse('no_mail_host');
  }
}
