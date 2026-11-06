import 'mocha';
import { expect } from 'chai';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { Bootstrapper, DI } from '@spinajs/di';
import type { Diagnostic, ModelEntry } from '@spinajs/manifest';
import { buildTargetSchema, diffSchema, generateMigration, introspectSchema, isActionable, Orm, type OrmDriver, type OrmMigration, type SchemaChange } from '@spinajs/orm';
import '@spinajs/log';
import '@spinajs/orm-sqlite';
import '../src/index.js';
import { col, id, manifestOf, model, shopModels } from './migrate-diff.fixture.js';

const TMP = resolve('test/.tmp-migrate-diff');

class DiffConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.Config.logger = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] };
    this.Config.db = {
      StrictTableCheck: false,
      Connections: [
        { Driver: 'orm-driver-pglite', Filename: ':memory:', Name: 'pglite' },
        { Driver: 'orm-driver-sqlite', Filename: ':memory:', Name: 'sqlite' },
      ],
    };
  }
}

interface Diffed {
  changes: SchemaChange[];
  diagnostics: Diagnostic[];
}

async function diff(driver: OrmDriver, models: ModelEntry[], options: { base?: ModelEntry[]; prune?: string[] } = {}): Promise<Diffed> {
  const diagnostics: Diagnostic[] = [];
  const target = buildTargetSchema(manifestOf(models), 'default', diagnostics);
  const base = options.base ? buildTargetSchema(manifestOf(options.base), 'default') : undefined;
  const live = await introspectSchema(driver, [...new Set([...target, ...(base ?? [])].map((t) => t.name))]);
  return { changes: diffSchema(target, live.columns, live.extras, { base, prune: options.prune, dialect: live.dialect, diagnostics }), diagnostics };
}

// ESM caches modules by URL, so every generated class gets a name no other call in this file uses
let generated = 0;

/** Writes the generated migration as JavaScript and runs its up(), as the migration runner would run the file. */
async function apply(driver: OrmDriver, changes: SchemaChange[], name: string, allowDestructive = false): Promise<string> {
  generated++;
  const { fileName, source } = generateMigration(changes, { name: `${name}${generated}`, connection: 'default', allowDestructive, now: new Date() });
  mkdirSync(TMP, { recursive: true });
  const file = join(TMP, fileName.replace(/\.ts$/, '.mjs'));
  writeFileSync(file, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, experimentalDecorators: true } }).outputText);
  const exported = (await import(pathToFileURL(file).href)) as Record<string, new () => OrmMigration>;
  await new exported[fileName.replace(/\.ts$/, '')]().up(driver);
  return source;
}

const kinds = (d: Diffed): string[] => d.changes.filter(isActionable).map((c) => `${c.destructive ? '!' : ''}${c.kind} ${c.table}`);

for (const connection of ['pglite', 'sqlite'] as const) {
  describe(`migrate-diff round trip on ${connection}`, function () {
    this.timeout(60_000);
    let driver: OrmDriver;

    before(async () => {
      DI.register(DiffConf).as(Configuration);
      for (const b of await DI.resolve(Array.ofType(Bootstrapper))) await b.bootstrap();
      const found = (await DI.resolve(Orm)).Connections.get(connection);
      if (!found) throw new Error(`no ${connection} connection`);
      driver = found;
    });

    after(async () => {
      await (await DI.resolve(Orm)).dispose();
      DI.clearCache();
      rmSync(TMP, { recursive: true, force: true });
    });

    it('creates six tables, and a second diff after the migration finds nothing', async () => {
      const models = shopModels('rt1_');
      const first = await diff(driver, models);
      expect(kinds(first)).to.deep.equal(['createTable rt1_companies', 'createTable rt1_post_tags', 'createTable rt1_posts', 'createTable rt1_settings', 'createTable rt1_tags', 'createTable rt1_users']);
      await apply(driver, first.changes, 'RoundTripCreate');
      const second = await diff(driver, models);
      expect(kinds(second)).to.deep.equal([]);
      expect(second.diagnostics.filter((d) => /indexes|foreign keys/.test(d.message))).to.deep.equal([]);
    });

    it('adds a column, relaxes NOT NULL, adds a unique column and an index; widens a length on postgres and notes lengths sqlite cannot compare', async () => {
      const v1 = [model('Article', 'rt2_articles', [id(), col('Title', { family: 'text', length: 100 }), col('Slug', { family: 'text', length: 100 })])];
      await apply(driver, (await diff(driver, v1)).changes, 'EvolveCreate');
      const v2 = [
        model('Article', 'rt2_articles', [id(), col('Title', { family: 'text', length: 200 }, { nullable: true }), col('Slug', { family: 'text', length: 100, unique: true }), col('Summary', { family: 'text' }, { nullable: true })], {
          indexes: [{ columns: ['Title'], unique: false }],
        }),
      ];
      const changed = await diff(driver, v2);
      expect(kinds(changed)).to.deep.equal(['alterColumn rt2_articles', 'addColumn rt2_articles', 'addIndex rt2_articles', 'addIndex rt2_articles']);
      const altered = changed.changes.find((c) => c.kind === 'alterColumn');
      const lengths = changed.diagnostics.map((d) => d.message).filter((m) => m.startsWith('lengths of rt2_articles'));
      if (connection === 'pglite') {
        // the S6 exit's "widen": postgres reports character_maximum_length (Q4)
        expect(altered?.reason).to.equal('rt2_articles.Title: length 100 → 200, NULL allowed');
        expect(lengths).to.deep.equal([]);
      } else {
        expect(altered?.reason).to.equal('rt2_articles.Title: NULL allowed');
        expect(lengths).to.deep.equal(['lengths of rt2_articles not compared: the driver reports none']);
      }
      await apply(driver, changed.changes, 'EvolveChange');
      expect(kinds(await diff(driver, v2))).to.deep.equal([]);
    });

    it('lists the columns no model declares (MIG002, MIG004) and never drops them', async () => {
      await driver.schema().createTable('rt3_accounts', (table) => {
        table.int('Id').primaryKey().autoIncrement();
        table.text('Name');
        table.text('Legacy');
        table.int('Mandatory').notNull();
      });
      const result = await diff(driver, [model('Account', 'rt3_accounts', [id(), col('Name', { family: 'text', inferred: true }, { nullable: true })])]);
      expect(kinds(result)).to.deep.equal([]);
      expect(result.changes.map((c) => (c.kind === 'unmanaged' ? c.detail.column : c.kind))).to.deep.equal(['Legacy', 'Mandatory']);
      expect(result.diagnostics.find((d) => d.code === 'MIG004')?.message).to.equal(
        'column rt3_accounts.Mandatory is NOT NULL without a default and no model declares it: inserts through Account fail; declare it on a model or give it a default',
      );
    });

    it('creates one table from two models mapped to it', async () => {
      const models = [model('UserBase', 'rt4_people', [id(), col('Email', { family: 'text', inferred: true })]), model('User', 'rt4_people', [id(), col('Name', { family: 'text', inferred: true }, { nullable: true })])];
      const first = await diff(driver, models);
      const created = first.changes.find((c) => c.kind === 'createTable');
      expect(created?.kind === 'createTable' ? created.detail.columns.map((c) => c.name) : []).to.deep.equal(['Id', 'Email', 'Name']);
      await apply(driver, first.changes, 'UnionCreate');
      expect(kinds(await diff(driver, models))).to.deep.equal([]);
    });

    it('drops a column removed since --base only as DESTRUCTIVE, and shows a rename as add plus drop', async () => {
      const v1 = [model('Note', 'rt5_notes', [id(), col('Title', { family: 'text', inferred: true }, { nullable: true }), col('Body', { family: 'text', inferred: true }, { nullable: true })])];
      await apply(driver, (await diff(driver, v1)).changes, 'BaseCreate');
      const v2 = [model('Note', 'rt5_notes', [id(), col('Headline', { family: 'text', inferred: true }, { nullable: true }), col('Body', { family: 'text', inferred: true }, { nullable: true })])];
      const renamed = await diff(driver, v2, { base: v1 });
      expect(kinds(renamed)).to.deep.equal(['addColumn rt5_notes', '!dropColumn rt5_notes']);
      const kept = await apply(driver, renamed.changes, 'BaseKeep');
      expect(kept).to.include('// DESTRUCTIVE: rt5_notes.Title was removed from the models since --base (pass --allow-destructive to run it)');
      const remaining = await diff(driver, v2, { base: v1 });
      expect(kinds(remaining)).to.deep.equal(['!dropColumn rt5_notes']);
      await apply(driver, remaining.changes, 'BaseDrop', true);
      expect(kinds(await diff(driver, v2, { base: v1 }))).to.deep.equal([]);
    });

    it('drops an undeclared column of an exhaustive table, or one named by --prune', async () => {
      await driver.schema().createTable('rt6_ledger', (table) => {
        table.int('Id').primaryKey().autoIncrement();
        table.text('Legacy');
      });
      const partial = [model('Ledger', 'rt6_ledger', [id()])];
      expect(kinds(await diff(driver, partial))).to.deep.equal([]);
      expect(kinds(await diff(driver, partial, { prune: ['rt6_ledger.Legacy'] }))).to.deep.equal(['!dropColumn rt6_ledger']);
      const exhaustive = await diff(driver, [model('Ledger', 'rt6_ledger', [id()], { exhaustive: true })]);
      expect(exhaustive.changes.filter(isActionable).map((c) => c.reason)).to.deep.equal(['rt6_ledger is exhaustive and no model declares Legacy']);
    });
  });
}
