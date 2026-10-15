/* eslint-disable no-console */
import { SYSTEM, runWithPrincipal } from '@spinajs/authz';
import { CliCommand } from '@spinajs/cli';
import { DI } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { driverOf } from '../ids.js';
import { classesOf } from '../registry.js';

/** The ORM is resolved when the command runs (the Cli boots only the command); tests set `Orm`. */
export abstract class AuthzOrmCliCommand extends CliCommand {
  public Orm?: Orm;

  protected async orm(): Promise<Orm> {
    return (this.Orm ??= (await DI.resolve(Orm)) as Orm);
  }

  /** The connection of the type's first registered class, else the ORM's default. */
  protected async driverFor(type: string): Promise<OrmDriver> {
    const cls = classesOf(type)[0];
    if (cls) return driverOf(cls);
    const d = (await this.orm()).Connections.get('default');
    if (!d) throw new Error('authz:ancestors: the ORM has no default connection');
    return d;
  }

  protected out(line = ''): void {
    console.log(line);
  }

  protected fail(message: string): void {
    console.error(message);
    process.exitCode = 1;
  }

  /** Parses first, then runs the body as SYSTEM; any error becomes one line and exit code 1. */
  protected async command<T>(parse: () => T, run: (parsed: T) => Promise<void>): Promise<void> {
    let parsed: T;
    try {
      await this.orm();
      parsed = parse();
    } catch (e) {
      return this.fail(e instanceof Error ? e.message : String(e));
    }
    try {
      await runWithPrincipal(SYSTEM, () => run(parsed));
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    }
  }
}
