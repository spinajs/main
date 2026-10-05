/* eslint-disable no-console */
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { CliCommand, Command } from '@spinajs/cli';

/**
 * Prints one line per finding of authn's checkAuthnConfig, `<level> <topic>: <message>`, to stdout (a report, like
 * migrate-status, not log output). The messages name keys, never values. Sets exit code 1 when any finding is an error.
 */
@Command('authn:check-config', 'Reports what the authn configuration gets wrong; prints key names, never secret values')
export class AuthnCheckConfig extends CliCommand {
  @Autoinject(Container)
  protected Container!: IContainer;

  public async execute(): Promise<void> {
    // Loaded here, not at module load: the cli dir ships scanned, and the @spinajs/authn root registers its services in
    // every process that imports it.
    const { checkAuthnConfig } = await import('@spinajs/authn');
    const findings = await checkAuthnConfig(this.Container);
    if (findings.length === 0) {
      console.log('authn:check-config: no findings');
      return;
    }
    for (const f of findings) console.log(`${f.level} ${f.topic}: ${f.message}`);
    if (findings.some((f) => f.level === 'error')) process.exitCode = 1;
  }
}
