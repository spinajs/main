// Boots the installed orm-app from its own directory and runs its models against sqlite in plain node: timestamps,
// converters, relations and the junction row, all the way to a query, then prints what came back.
const { Bootstrapper, DI } = await import('@spinajs/di');
const { Configuration } = await import('@spinajs/configuration');
const { Orm, OrmMigrator } = await import('@spinajs/orm');
await import('@spinajs/orm-sqlite');
await import('@spinajs/log');
// Built next to the installed copy of this probe, so it does not resolve from here.
const { Owner, OwnerTag, Pet } = await import(new URL('./lib/models.js', import.meta.url).href);

const isInstant = (value) => typeof value?.toISO === 'function';

const result = {};
try {
  for (const b of await DI.resolve(Array.ofType(Bootstrapper))) await b.bootstrap();
  await DI.resolve(Configuration);
  await DI.resolve(Orm);
  await DI.resolve(OrmMigrator);

  const owner = new Owner({ Name: 'Ada', Active: true, Roles: ['admin', 'dev'] });
  owner.SeenAt = owner.CreatedAt;
  await owner.insert();

  const pet = new Pet({ Name: 'Rex', owner_id: owner.Id });
  await pet.insert();
  await new OwnerTag({ owner_id: owner.Id, tag_id: 1, Note: 'met at a fair' }).insert();

  const loaded = await Owner.where({ Id: owner.Id }).populate('Pets').populate('Tags').populate('Names').first();
  result.columns = {
    created: isInstant(loaded.CreatedAt),
    seen: isInstant(loaded.SeenAt),
    active: loaded.Active,
    roles: loaded.Roles,
  };
  result.pets = loaded.Pets.map((p) => p.Name);
  result.relationClass = loaded.Pets.constructor.name;
  result.tags = loaded.Tags.map((t) => ({ name: t.Name, link: t.Link?.constructor.name, note: t.Link?.Note }));
  result.names = loaded.Names.map((p) => p.Name);
  result.namesClass = loaded.Names.constructor.name;

  loaded.Name = 'Grace';
  await loaded.update();
  result.updated = isInstant((await Owner.where({ Id: owner.Id }).first()).UpdatedAt);

  await loaded.destroy();
  result.afterSoftDelete = (await Owner.where({ Id: owner.Id }).first()) ?? null;
  await (await DI.resolve(Orm)).dispose();
} catch (err) {
  result.error = { name: err?.constructor?.name, message: String(err?.message), stack: String(err?.stack) };
}

console.log(`<<JSON\n${JSON.stringify(result)}\nJSON>>`);
process.exit(0);
