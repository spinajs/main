import { AuthzConfigError } from '@spinajs/authz';
import { AuthzCliBase } from '@spinajs/authz/cli';
import { Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

import { driverOf } from '../ids.js';
import { classesOf } from '../registry.js';

/** The ORM is resolved when the command runs (the Cli boots only the command); tests set `Orm`. */
export abstract class AuthzOrmCliCommand extends AuthzCliBase {
  public Orm?: Orm;

  protected async orm(): Promise<Orm> {
    return (this.Orm ??= (await this.Container.resolve(Orm)) as Orm);
  }

  /** The connection of the type's first registered class, else the ORM's default. */
  protected async driverFor(type: string): Promise<OrmDriver> {
    const cls = classesOf(type)[0];
    if (cls) return driverOf(cls);
    const d = (await this.orm()).Connections.get('default');
    if (!d) throw new AuthzConfigError('authz:ancestors: the ORM has no default connection');
    return d;
  }

  protected async prepare(): Promise<void> {
    await this.orm();
  }
}
