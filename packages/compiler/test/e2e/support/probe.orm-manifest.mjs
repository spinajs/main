// Boots orm-manifest-app with db.Models.Source = 'manifest' and reports the columns Account was given and how it behaves.
const { Bootstrapper, DI } = await import('@spinajs/di');
const { Configuration } = await import('@spinajs/configuration');
const { Orm, OrmMigrator, extractModelDescriptor } = await import('@spinajs/orm');
await import('@spinajs/orm-sqlite');
await import('@spinajs/log');
const { Account } = await import(new URL('./lib/models.js', import.meta.url).href);
const { Stamp } = await import(new URL('./lib/stamp.js', import.meta.url).href);

const result = {};
try {
  for (const b of await DI.resolve(Array.ofType(Bootstrapper))) await b.bootstrap();
  await DI.resolve(Configuration);
  const orm = await DI.resolve(Orm);
  await DI.resolve(OrmMigrator);
  const descriptor = extractModelDescriptor(Account);
  result.columns = descriptor.Columns.map((c) => `${c.Name}:${c.NativeType}`).sort();
  result.drift = orm.ColumnDrift.map((d) => d.message);
  // the request schema orm-http validates bodies with and http-swagger publishes
  result.schema = { types: Object.fromEntries(Object.entries(descriptor.Schema.properties).map(([k, v]) => [k, v.type])), required: [...descriptor.Schema.required].sort() };

  if (process.env.ORM_E2E_DRIFT !== '1') {
    const driver = orm.Connections.get('default');
    await driver.insert().into('accounts').values({ Name: 'ada', Active: 1, Legacy: 'kept', SeenAt: '2026-11-07T10:00:00.000Z' });
    const loaded = await Account.where({ Name: 'ada' }).first();
    result.seen = typeof loaded.SeenAt?.toISO === 'function';
    result.legacy = loaded.Legacy;
    loaded.Name = 'grace';
    loaded.Legacy = 'changed';
    await loaded.update();
    const stored = await driver.select().from('accounts').where({ Id: loaded.Id }).first();
    result.stored = { name: stored.Name, legacy: stored.Legacy };
    const stamp = await Stamp.create({ Name: 'ada' });
    result.stamp = { id: typeof stamp.Id, updated: (await driver.select().from('stamps').where({ Id: stamp.Id }).first()).Updated };
  }
  await orm.dispose();
} catch (err) {
  result.error = { name: err?.constructor?.name, message: String(err?.message), stack: String(err?.stack) };
}

console.log(`<<JSON\n${JSON.stringify(result)}\nJSON>>`);
process.exit(0);
