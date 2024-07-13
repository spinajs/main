import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { TestConfiguration, req } from './common.js';
import { Simple } from './controllers/Simple.js';
import { Controllers, HttpServer } from '@spinajs/http';
import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import './../src/index.js';
import { FilterableModel } from './models/Filterable.js';


describe('Http orm tests', function () {
  this.timeout(15000);

  const sb = sinon.createSandbox();

  before(async () => {
    DI.setESMModuleSupport();
    DI.register(TestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');

    sb.spy(Simple.prototype as any);

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Controllers);
    await DI.resolve(Orm);
    const server = await DI.resolve(HttpServer);

    server.start();
  });

  after(async () => {
    const server = await DI.resolve<HttpServer>(HttpServer);
    server.stop();
    sb.restore();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('query params', function () {
    it('simple query', async () => {
      const spy = DI.get(Simple).testGet as sinon.SinonSpy;

      await req().get('simple/1').set('Accept', 'application/json');

      expect(spy.args[0][0].constructor.name).to.eq('Test');
      expect(spy.args[0][0].Text).to.equal('witaj');
    });

    it('should hydrate data to model', async () => {
      const spy = DI.get(Simple).testHydrate as sinon.SinonSpy;
      await req()
        .post('simple/testHydrate')
        .send({
          model: {
            Text: 'hydrated',
          },
        })
        .set('Accept', 'application/json');

      expect(spy.args[0][0].constructor.name).to.eq('Test');
      expect(spy.args[0][0].Text).to.eq('hydrated');
    });

    it('Should return filterable columns for model', async () => {
      const columns = FilterableModel.filterColumns();
      expect(columns.length).to.eq(2);
      expect(columns).to.deep.eq([
        {
          column: 'Text',
          operators: ['eq', 'like'],
        },
        {
          column: 'Number',
          operators: ['eq', 'gt', 'lt'],
        },
      ]);
    });

    it('Should return filterable columns schema', async () => {
      const schema = FilterableModel.filterSchema();
      expect(schema).to.deep.eq({
        type: 'array',
        oneOf: [
          {
            type: 'object',
            required: ['field', 'value', 'operator'],
            properties: {
              field: { const: 'Text' },
              value: { type: ['string', 'integer'] },
              operator: ['eq', 'like'],
            },
          },
          {
            type: 'object',
            required: ['field', 'value', 'operator'],
            properties: {
              field: { const: 'Number' },
              value: { type: ['string', 'integer'] },
              operator: ['eq', 'gt', 'lt'],
            },
          },
        ],
      });
    });

    it('Should perform filter operation on model', async () => {
      const result = await FilterableModel.select().filter([
        {
          Column: 'Text',
          Value: 'hello',
          Operator: 'eq',
        },
      ]);

      expect(result).to.be.an('array');
      expect(result.length).to.eq(1);
      expect(result[0].Text).to.eq('hello');
      expect(result[0].Number).to.eq(1);
      expect(result[0].Id).to.eq(1);

      const result2 = await FilterableModel.select().filter([
        {
          Column: 'Number',
          Value: 4,
          Operator: 'gte',
        },
      ]);

      expect(result2).to.be.an('array');
      expect(result2.length).to.eq(2);
      expect(result2[0].Number).to.eq(4);
      expect(result2[1].Number).to.eq(5);

      const result3 = await FilterableModel.filter<FilterableModel>([
        {
          Column: 'Text',
          Value: 'hello',
          Operator: 'eq',
        },
      ]);

      expect(result3).to.be.an('array');
      expect(result3.length).to.eq(1);
      expect(result3[0].Text).to.eq('hello');
      expect(result3[0].Number).to.eq(1);
      expect(result3[0].Id).to.eq(1);
    });
  });
});
