import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Controllers, HttpServer } from '@spinajs/http';
import { fsService } from '@spinajs/fs';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { migrateTestDatabase } from '@spinajs/orm/testing';
import '../src/index.js';
import { TestConfiguration } from './common.js';
import { installFilterStatics } from './filter-statics.js';
import { LIST_MODELS } from './list-fixture.js';

// Taken at import, before any suite clears the cache: orm-http.test.ts explains why the map cannot be rebuilt otherwise.
const errorMapSnapshot = new Map(DI.get<Map<string, any>>('__http_error_map__') ?? []);

/** Boots the HTTP server over SQLite in memory with the list fixture migrated, as orm-http.test.ts does. */
export async function startListServer(): Promise<void> {
  DI.unregister(TestConfiguration);
  DI.clearCache();

  errorMapSnapshot.forEach((impl, name) => {
    DI.register(impl).asMapValue('__http_error_map__', name);
  });

  DI.setESMModuleSupport();
  DI.register(TestConfiguration).as(Configuration);
  DI.register(SqliteOrmDriver).as('orm-driver-sqlite');

  for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
    await b.bootstrap();
  }

  await DI.resolve(Configuration);
  await migrateTestDatabase();
  await DI.resolve(fsService);
  await DI.resolve(Controllers);
  const server = await DI.resolve(HttpServer);
  await server.start();

  for (const model of LIST_MODELS) {
    installFilterStatics(model);
  }
}

export async function stopListServer(): Promise<void> {
  const server = await DI.resolve<HttpServer>(HttpServer);
  await server.stop();
  DI.clearCache();
}
