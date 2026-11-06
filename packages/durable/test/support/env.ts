import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Orm, OrmDriver } from '@spinajs/orm';
import '@spinajs/orm-sqlite';
import '@spinajs/log';

let connections: Record<string, unknown>[] = [];

export const sqliteConnection = (name: string) => ({ Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: name });

class DurableTestConf extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '{message}' }],
        rules: [{ name: '*', level: 'error', target: 'Empty' }],
      },
      db: { DefaultConnection: String(connections[0].Name), Connections: connections },
    };
  }
}

/** Boots DI with the given connections (in-memory sqlite `default` when none) and returns the default driver. */
export async function bootDb(conns: Record<string, unknown>[] = [sqliteConnection('default')]): Promise<OrmDriver> {
  await DI.dispose();
  DI.clearCache();
  connections = conns;
  DI.register(DurableTestConf).as(Configuration);
  await DI.resolve(Configuration);
  const orm = await DI.resolve(Orm);
  return orm.Connections.get('default') as OrmDriver;
}
