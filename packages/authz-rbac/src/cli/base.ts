/* eslint-disable no-console */
import { AuthzAdminFailure, AuthzService, SYSTEM } from '@spinajs/authz';
import type { AuthzAdmin } from '@spinajs/authz';
import { CliCommand } from '@spinajs/cli';
import { DI } from '@spinajs/di';

/**
 * The CLI boots only the command it runs, so collaborators are resolved when the command needs them (a
 * failing AuthzService boot then becomes a message, not a failed command construction). Tests set the fields.
 */
export abstract class AuthzCliCommand extends CliCommand {
  public Authz?: AuthzService;

  protected async authz(): Promise<AuthzService> {
    return (this.Authz ??= await DI.resolve(AuthzService));
  }

  protected async admin(): Promise<AuthzAdmin> {
    return (await this.authz()).admin();
  }

  protected out(line = ''): void {
    console.log(line);
  }

  protected fail(message: string): void {
    console.error(message);
    process.exitCode = 1;
  }

  /** Parses first (a bad command line never boots authz), then runs the body as SYSTEM with reason 'cli'. Any error becomes a one-line message and exit code 1. */
  protected async command<T>(parse: () => T, run: (parsed: T) => Promise<void>): Promise<void> {
    let parsed: T;
    try {
      parsed = parse();
    } catch (e) {
      return this.fail(describeError(e));
    }

    try {
      await (await this.authz()).runAs(SYSTEM, 'cli', () => run(parsed));
    } catch (e) {
      this.fail(describeError(e));
    }
  }
}

export function describeError(e: unknown): string {
  if (e instanceof AuthzAdminFailure) return `${e.message} (${e.code}${e.field ? `, ${e.field}` : ''})`;
  return e instanceof Error ? e.message : String(e);
}
