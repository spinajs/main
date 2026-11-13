// Migrates users, teams and authz-orm on sqlite with their own migrations, then diffs their models against the result.
const { Bootstrapper, DI } = await import('@spinajs/di');
const { Configuration } = await import('@spinajs/configuration');
const { readManifest } = await import('@spinajs/manifest');
const { Orm, OrmMigrator, buildTargetSchema, diffSchema, introspectSchema, isActionable } = await import('@spinajs/orm');
await import('@spinajs/orm-sqlite');
await import('@spinajs/log');
// a package's migrations are in the manifest only under its declared migration dirs; importing it registers them
await import(new URL('./lib/index.js', import.meta.url).href);

const result = {};
try {
  for (const b of await DI.resolve(Array.ofType(Bootstrapper))) await b.bootstrap();
  await DI.resolve(Configuration);
  const orm = await DI.resolve(Orm);
  await DI.resolve(OrmMigrator);
  const driver = orm.Connections.get('default');
  const names = [...orm.Connections].filter(([, d]) => d === driver).map(([n]) => n);
  const diagnostics = [];
  const target = buildTargetSchema(await readManifest(process.env.SPINAJS_MANIFEST), names, diagnostics);
  const live = await introspectSchema(driver, target.map((t) => t.name));
  const changes = diffSchema(target, live.columns, live.extras, { dialect: live.dialect, foreignKeysEnforced: live.foreignKeysEnforced, diagnostics });
  result.changes = changes.filter(isActionable).map((c) => `${c.destructive ? 'DESTRUCTIVE ' : ''}${c.kind} ${c.table}${c.reason ? `: ${c.reason}` : ''}`);
  result.diagnostics = diagnostics.map((d) => `${d.severity} ${d.code}: ${d.message}`);
  await orm.dispose();
} catch (err) {
  result.error = { name: err?.constructor?.name, message: String(err?.message), stack: String(err?.stack) };
}

console.log(`<<JSON\n${JSON.stringify(result)}\nJSON>>`);
process.exit(0);
