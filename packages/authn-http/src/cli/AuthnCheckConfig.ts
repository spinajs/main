/* eslint-disable no-console */
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { CliCommand, Command } from '@spinajs/cli';
import { Configuration } from '@spinajs/configuration';
import type { AuthnConfigFinding } from '@spinajs/authn/boot';

import { importIfInstalled } from '../optional-import.js';

// The authn packages whose roots register strategies and MFA steps. A CLI process loads no package root, so without
// these the check would report every listed strategy as missing.
const PROVIDER_PACKAGES = ['@spinajs/authn-local', '@spinajs/authn-token', '@spinajs/authn-keys', '@spinajs/authn-oidc', '@spinajs/authn-totp'];

/**
 * Prints one line per finding of authn's checkAuthnConfig, `<level> <topic>: <message>`, to stdout (a report, like
 * migrate-status, not log output). The messages name keys, never values. Sets exit code 1 when any finding is an error.
 * It opens the authn store (the app database, when authn-orm is loaded) to look for enrolled MFA steps.
 */
@Command('authn:check-config', 'Reports what the authn configuration gets wrong; prints key names, never secret values')
export class AuthnCheckConfig extends CliCommand {
  @Autoinject(Container)
  protected Container!: IContainer;

  public async execute(): Promise<void> {
    await this.loadProviders();
    // Loaded here, not at module load: the cli dir ships scanned, and the @spinajs/authn root registers its services in
    // every process that imports it.
    await import('@spinajs/authn');
    // The authn.http and authn.session schemas, so the check covers those subtrees too.
    await import('../register-schema.js');
    await import('@spinajs/authn-session/register-schema');
    const { checkAuthnConfig } = await import('@spinajs/authn/boot');
    const findings = await checkAuthnConfig(this.Container);
    const realIp = await this.realIpFinding();
    if (realIp) findings.push(realIp);
    if (findings.length === 0) {
      console.log('authn:check-config: no findings');
      return;
    }
    for (const f of findings) console.log(`${f.level} ${f.topic}: ${f.message}`);
    if (findings.some((f) => f.level === 'error')) process.exitCode = 1;
  }

  /** A RealIp replacement that ignores authn.http.trustProxy; judged only when this process registered AuthnRealIp. */
  protected async realIpFinding(): Promise<AuthnConfigFinding | undefined> {
    const { realIpOverrideFinding } = await import('../middleware/client-ip.js');
    if (!realIpOverrideFinding(this.Container, undefined)) return undefined;
    let authnTrust: unknown;
    try {
      authnTrust = ((await this.Container.resolve(Configuration)) as Configuration).get('authn.http.trustProxy');
    } catch {
      // A configuration the schema refuses is reported as schema findings; the override is then reported as a warning.
    }
    return realIpOverrideFinding(this.Container, authnTrust);
  }

  /** Registers the strategies and steps of the installed authn packages; an app may install only some of them. */
  protected async loadProviders(): Promise<void> {
    for (const specifier of PROVIDER_PACKAGES) await importIfInstalled(specifier);
  }
}
