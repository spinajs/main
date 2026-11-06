#!/usr/bin/env node
/**
 * D12: what does one test file pay for a migrated PGlite database? Imports the built lib/, so build first.
 *
 *   node packages/testing-orm/bench/pglite-spinup.mjs [--runs 10] [--tables 20]
 *
 * Every *BootMs is createTestDatabase() plus a test app boot that runs the pending migrations.
 * schemaFirstBootMs           the default strategy's first call: it also creates the shared PGlite instance
 * schemaBootMedianMs          the default strategy afterwards: a new schema, migrations run in it
 * schemaDisposeMedianMs       dropping that schema
 * templateBuildMs             strategy 'template', first call: a cold PGlite, the migrations, the dump
 * templateBootMedianMs        strategy 'template' afterwards: a PGlite loaded from the dump
 * freshInstanceBootMedianMs   no sharing and no template: a new PGlite migrated on every boot
 */
import { performance } from 'node:perf_hooks';
import { FrameworkConfiguration } from '@spinajs/configuration';
import '@spinajs/log';
import { Migration, Orm, OrmMigration } from '@spinajs/orm';
import { createTestApp } from '@spinajs/testing';
import { createTestDatabase } from '../lib/index.js';

const option = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
};

const RUNS = option('--runs', 10);
const TABLES = option('--tables', 20);
const SILENT = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] };

class BenchSchema_2026_11_03_00_00_00 extends OrmMigration {
  async up(connection) {
    for (let i = 0; i < TABLES; i++) {
      await connection.schema().createTable(`bench_${i}`, (t) => {
        t.int('Id').primaryKey().autoIncrement();
        t.string('Name');
        t.dateTime('At');
      });
    }
  }

  async down() {}
}
Migration('default')(BenchSchema_2026_11_03_00_00_00);

function configurationFor(connection) {
  return class BenchConfiguration extends FrameworkConfiguration {
    async resolve() {
      await super.resolve();
      this.set('logger', SILENT);
      this.set('db', { DefaultConnection: 'default', StrictTableCheck: false, Connections: [connection] });
    }
  };
}

/** createTestDatabase( options ) and an app boot on it; returns the milliseconds and the database. */
async function boot(options) {
  const started = performance.now();
  const db = await createTestDatabase(options);
  const app = await createTestApp({ configuration: configurationFor(db.config), resolve: [Orm] });
  const ms = performance.now() - started;
  await app.dispose();
  return { ms, db };
}

async function timed(fn) {
  const started = performance.now();
  await fn();
  return performance.now() - started;
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = (ms) => Math.round(ms);

const first = await boot({});
const schemaDispose = [await timed(() => first.db.dispose())];
const schemaBoots = [];
for (let i = 0; i < RUNS; i++) {
  const run = await boot({});
  schemaBoots.push(run.ms);
  schemaDispose.push(await timed(() => run.db.dispose()));
}

const templateBuildMs = await timed(() => createTestDatabase({ strategy: 'template' }));
const templateBoots = [];
for (let i = 0; i < RUNS; i++) templateBoots.push((await boot({ strategy: 'template' })).ms);

const freshBoots = [];
for (let i = 0; i < RUNS; i++) {
  const started = performance.now();
  const app = await createTestApp({ configuration: configurationFor({ Driver: 'orm-driver-pglite', Name: 'default', Migration: { OnStartup: true } }), resolve: [Orm] });
  freshBoots.push(performance.now() - started);
  await app.dispose();
}

console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      tables: TABLES,
      runs: RUNS,
      schemaFirstBootMs: round(first.ms),
      schemaBootMedianMs: round(median(schemaBoots)),
      schemaDisposeMedianMs: round(median(schemaDispose)),
      templateBuildMs: round(templateBuildMs),
      templateBootMedianMs: round(median(templateBoots)),
      freshInstanceBootMedianMs: round(median(freshBoots)),
      under100ms: { schema: median(schemaBoots) < 100, template: median(templateBoots) < 100 },
    },
    null,
    2,
  ),
);
