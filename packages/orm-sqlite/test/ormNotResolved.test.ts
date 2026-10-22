import { expect } from 'chai';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import 'mocha';

const run = promisify(execFile);

/**
 * A process that has not resolved an Orm, as a cli command is: imports the built packages (`npm run compile` of orm
 * and orm-sqlite first) and declares a model with the decorators called by hand.
 */
async function freshProcess(body: string): Promise<Record<string, string>> {
  const script = [
    "import { DI } from '@spinajs/di';",
    "import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';",
    "import '@spinajs/log';",
    "import { Connection, Model, ModelBase, Orm, OrmNotResolved, SelectQueryBuilder, createQuery, modelDriver, ormConnection } from '@spinajs/orm';",
    "import { SqliteOrmDriver } from '@spinajs/orm-sqlite';",
    'class Doc extends ModelBase {}',
    "Connection('sqlite')(Doc);",
    "Model('doc')(Doc);",
    'class Config extends FrameworkConfiguration {',
    '  async resolve() {',
    '    await super.resolve();',
    "    this.Config.logger = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] };",
    // StrictTableCheck off: the fixture model `doc` never gets a table.
    "    this.Config.db = { StrictTableCheck: false, Connections: [{ Name: 'sqlite', Driver: 'orm-driver-sqlite', Filename: ':memory:' }] };",
    '  }',
    '}',
    'DI.register(Config).as(Configuration);',
    "DI.register(SqliteOrmDriver).as('orm-driver-sqlite');",
    'await DI.resolve(Configuration);',
    'const result = {};',
    'const attempt = (name, fn) => { try { fn(); result[name] = "returned"; } catch (e) { result[name] = `${e instanceof OrmNotResolved ? "OrmNotResolved" : e.constructor.name}: ${e.message}`; } };',
    body,
    "console.log('RESULT ' + JSON.stringify(result));",
    'process.exit(0);',
  ].join('\n');

  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 });
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT '));
  expect(line, stdout).to.be.a('string');
  return JSON.parse(line!.slice('RESULT '.length)) as Record<string, string>;
}

describe('sqlite model driver helpers in a process that has not resolved the Orm', function () {
  this.timeout(120_000);

  it('modelDriver, ormConnection and createQuery say the Orm is not resolved, not that the connection is missing', async () => {
    const result = await freshProcess(['attempt("model", () => modelDriver(Doc));', 'attempt("connection", () => ormConnection("sqlite"));', 'attempt("query", () => createQuery(Doc, SelectQueryBuilder));'].join('\n'));

    expect(result).to.deep.eq({
      model: 'OrmNotResolved: Doc: the Orm has not created its connections yet; inject or resolve the Orm first',
      connection: 'OrmNotResolved: the Orm has not created its connections yet; inject or resolve the Orm first',
      query: 'OrmNotResolved: Doc: the Orm has not created its connections yet; inject or resolve the Orm first',
    });
  });

  it('concurrent resolves share one Orm, after which the model has its driver', async () => {
    const result = await freshProcess(
      [
        'const [orm, again] = await Promise.all([DI.resolve(Orm), DI.resolve(Orm)]);',
        'attempt("same", () => { if (again !== orm) throw new Error("another Orm"); });',
        'attempt("model", () => { if (modelDriver(Doc) !== orm.Connections.get("sqlite")) throw new Error("another driver"); });',
      ].join('\n'),
    );

    expect(result).to.deep.eq({ same: 'returned', model: 'returned' });
  });
});
