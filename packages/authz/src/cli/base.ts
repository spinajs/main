/* eslint-disable no-console */
import { CliCommand } from '@spinajs/cli';
import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { AuthzAdminFailure } from '../contracts/admin.js';
import { SYSTEM } from '../contracts/principal.js';
import { runWithPrincipal } from '../host/storage.js';

/**
 * Base of the authz CLI commands. The CLI boots only the command it runs, so collaborators that can fail to boot are
 * looked up in `Container` when the command needs them: a failing boot then becomes a message, not a failed command
 * construction. Tests set the collaborators, or `Container` on a command built with `new`.
 */
export abstract class AuthzCliBase extends CliCommand {
  @Autoinject(Container)
  public Container: IContainer;

  protected out(line = ''): void {
    console.log(line);
  }

  protected fail(message: string): void {
    console.error(message);
    process.exitCode = 1;
  }

  /** Runs before the command line is parsed, with the same error handling. */
  protected async prepare(): Promise<void> {}

  protected asSystem(run: () => Promise<void>): Promise<void> {
    return runWithPrincipal(SYSTEM, run);
  }

  /** Parses first, then runs the body as SYSTEM (asSystem). Any error becomes a one-line message and exit code 1. */
  protected async command<T>(parse: () => T, run: (parsed: T) => Promise<void>): Promise<void> {
    let parsed: T;
    try {
      await this.prepare();
      parsed = parse();
    } catch (e) {
      return this.fail(describeCliError(e));
    }

    try {
      await this.asSystem(() => run(parsed));
    } catch (e) {
      this.fail(describeCliError(e));
    }
  }
}

export function describeCliError(e: unknown): string {
  if (e instanceof AuthzAdminFailure) return `${e.message} (${e.code}${e.field ? `, ${e.field}` : ''})`;
  return e instanceof Error ? e.message : String(e);
}
