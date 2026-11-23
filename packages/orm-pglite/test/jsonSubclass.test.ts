import 'mocha';
import { expect } from 'chai';
import { FrameworkConfiguration } from '@spinajs/configuration';
import '@spinajs/log';
import { Connection, Json, JsonValueConverter, Model, ModelBase, Orm, Primary, QueryContext, extractDecoratorPropertyDescriptor } from '@spinajs/orm';
import type { IModelDescriptor } from '@spinajs/orm';
import { createTestApp, type TestApp } from '@spinajs/testing';

import { PgliteOrmDriver } from '../src/index.js';

const CONNECTION = 'pglite-json-subclass';

class PgliteJsonSubclassConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();
    this.set('logger', { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] });
    this.set('db', { StrictTableCheck: false, Connections: [{ Driver: 'orm-driver-pglite', Name: CONNECTION }] });
  }
}

class SubJsonConverter extends JsonValueConverter {}

function JsonSubclass(): PropertyDecorator {
  const decorator: PropertyDecorator = extractDecoratorPropertyDescriptor((model: IModelDescriptor, _: unknown, column: string) => {
    model.Converters.set(column, { Class: SubJsonConverter });
  });
  return decorator;
}

@Connection(CONNECTION)
@Model('pgl_json_subclass')
class PglJsonDoc extends ModelBase {
  @Primary()
  public Id: number;

  @JsonSubclass()
  public Sub: unknown;

  @Json()
  public Base: unknown;
}

describe('PGlite: a jsonb column declaring a subclass of JsonValueConverter', function () {
  this.timeout(60000);

  let app: TestApp | undefined;

  before(async () => {
    app = await createTestApp({ configuration: PgliteJsonSubclassConfiguration, register: (c) => c.register(PgliteOrmDriver).as('orm-driver-pglite') });
    const orm = await app.resolve(Orm);
    const driver = orm.Connections.get(CONNECTION) as PgliteOrmDriver;
    await driver.executeOnDb('CREATE TABLE pgl_json_subclass ("Id" int PRIMARY KEY, "Sub" jsonb, "Base" jsonb)', [], QueryContext.Schema);
    await orm.reloadTableInfo();
  });

  after(async () => {
    await app?.dispose();
  });

  const values: Array<[string, unknown]> = [
    ['a top-level string', 'hello'],
    ['an object', { a: 1, b: [true] }],
    ['an array', [1, 'x']],
    ['a number', 42],
    ['null', null],
  ];

  values.forEach(([label, value], i) => {
    it(`round-trips ${label} as @Json() does`, async () => {
      await PglJsonDoc.insert({ Id: i + 1, Sub: value, Base: value });

      const doc = await PglJsonDoc.where('Id', i + 1).first();
      expect(doc.Sub).to.deep.eq(value);
      expect(doc.Base).to.deep.eq(value);
    });
  });

  it('reads a string that is itself JSON text as its JSON value, as @Json() does', async () => {
    await PglJsonDoc.insert({ Id: 100, Sub: '123', Base: '123' });

    const doc = await PglJsonDoc.where('Id', 100).first();
    expect(doc.Sub).to.eq(123);
    expect(doc.Base).to.eq(123);
  });
});
