import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { TestConfiguration, req } from './common.js';
import { Simple } from './controllers/Simple.js';
import { Controllers, HttpServer } from '@spinajs/http';
import { fsService } from '@spinajs/fs';
import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import './../src/index.js';
import { FilterableModel } from './models/Filterable.js';
import { FilterC } from './controllers/Filter.js';
import './../src/route-arg.js';
import { FilterableLogicalOperators } from './../src/index.js';
// dto-relation e2e fixtures: tables + seed rows for the CampaignController routes
import './migrations/DtoRelation_2026_07_23_00_00_00.js';
import { Campaign } from './models/Campaign.js';


describe('Http orm tests', function () {
  this.timeout(15000);

  const sb = sinon.createSandbox();

  before(async () => {
    DI.setESMModuleSupport();
    DI.register(TestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');

    sb.spy(Simple.prototype as any);
    sb.spy(FilterC.prototype as any);

    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    // Configuration must be resolved before fsService: fsService's @Config
    // getters read the Configuration singleton, which otherwise does not exist
    // yet when this file runs standalone (mirrors http-swagger's harness).
    await DI.resolve(Configuration);
    await DI.resolve(fsService);
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
    // The filter contract is the { op, filters } envelope (see filterSchema()
    // in src/model.ts and FilterModelRouteArg); the controller receives the
    // parsed envelope object.
    it('Should filter route-args works', async () => {
      const spy = DI.get(FilterC)!.testFilter as sinon.SinonSpy;
      await req().get('filter/testFilter?filter={"op":"and","filters":[{"Column": "Number", "Operator": "eq","Value": 1}]}').set('Accept', 'application/json');

      expect(spy.args[0][0]).to.be.an('object');
      expect(spy.args[0][0].filters).to.be.an('array');
      expect(spy.args[0][0].filters.length).to.eq(1);
      expect(spy.args[0][0].filters[0].Column).to.eq('Number');
      expect(spy.args[0][0].filters[0].Operator).to.eq('eq');
      expect(spy.args[0][0].filters[0].Value).to.eq(1);
    });

    it('Should custom filter route-args works', async () => {
      const spy = DI.get(FilterC)!.testCustomFilter as sinon.SinonSpy;
      await req().get('filter/testCustomFilter?filter={"op":"and","filters":[{"Column": "Foo", "Operator": "eq","Value": 1}]}').set('Accept', 'application/json');

      expect(spy.args[0][0]).to.be.an('object');
      expect(spy.args[0][0].filters).to.be.an('array');
      expect(spy.args[0][0].filters.length).to.eq(1);
      expect(spy.args[0][0].filters[0].Column).to.eq('Foo');
      expect(spy.args[0][0].filters[0].Operator).to.eq('eq');
      expect(spy.args[0][0].filters[0].Value).to.eq(1);
    });

    it('Should relation one-to-many filter route-args works', async () => {
      const spy = DI.get(FilterC)!.testRelationFilterOneToMany as sinon.SinonSpy;
      await req().get('filter/testRelationFilterOneToMany?filter={"op":"and","filters":[{"Column": "Text", "Operator": "eq","Value": "foo"}]}').set('Accept', 'application/json');

      expect(spy.args[0][0]).to.be.an('object');
      expect(spy.args[0][0].filters).to.be.an('array');
      expect(spy.args[0][0].filters.length).to.eq(1);
      expect(spy.args[0][0].filters[0].Column).to.eq('Text');
      expect(spy.args[0][0].filters[0].Operator).to.eq('eq');
      expect(spy.args[0][0].filters[0].Value).to.eq('foo');
    });

    it('Should relation one-to-one filter route-args works', async () => {
      const spy = DI.get(FilterC)!.testRelationFilterOneToOne as sinon.SinonSpy;
      await req().get('filter/testRelationFilterOneToOne?filter={"op":"and","filters":[{"Column": "Text", "Operator": "eq","Value": "bar"}]}').set('Accept', 'application/json');

      expect(spy.args[0][0]).to.be.an('object');
      expect(spy.args[0][0].filters).to.be.an('array');
      expect(spy.args[0][0].filters.length).to.eq(1);
      expect(spy.args[0][0].filters[0].Column).to.eq('Text');
      expect(spy.args[0][0].filters[0].Operator).to.eq('eq');
      expect(spy.args[0][0].filters[0].Value).to.eq('bar');
    });

    it('Should validate filter schema', async () => {
      const result = await req().get('filter/testFilter?filter=[{"Column": "Number", "Operator": "between","Value": 1}]').set('Accept', 'application/json');
      expect(result.status).to.eq(400);
      expect(result.body).to.be.an('object');
      expect(result.body.message).to.be.eq('validation error');
    });

    it('simple query', async () => {
      const spy = DI.get(Simple)!.testGet as sinon.SinonSpy;

      await req().get('simple/1').set('Accept', 'application/json');

      expect(spy.args[0][0].constructor.name).to.eq('Test');
      expect(spy.args[0][0].Text).to.equal('witaj');
    });

    it('simple query with include', async () =>{ 

      const spy = DI.get(Simple)!.testInclude as sinon.SinonSpy;
      
      await req().get('simple/testinclude/1?include=["Belongs"]').set('Accept', 'application/json');
      expect(spy.args[0][0].constructor.name).to.eq('Test');
      expect(spy.args[0][0].Belongs.Value.Text).to.eq('belongs 1');
      expect(spy.args[0][0].Text).to.equal('witaj');
    });

    it('simple query with parent model', async () =>{ 

      const spy = DI.get(Simple)!.testWithParent as sinon.SinonSpy;
      
      await req().get('simple/testWithParent/1/1').set('Accept', 'application/json');
      expect(spy.args[0][0].constructor.name).to.eq('Test');
      expect(spy.args[0][0].Text).to.equal('witaj');
    });

    it('should fail if parent model not exist', async () =>{ 
      const result = await req().get('simple/testWithParent/111/1').set('Accept', 'application/json');
      expect(result.status).to.equal(404);
     
    });


    it('should hydrate data to model', async () => {
      const spy = DI.get(Simple)!.testHydrate as sinon.SinonSpy;
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
      // filterColumns() also carries the optional custom `query` callback
      // (undefined for plain @Filterable columns)
      expect(columns).to.deep.eq([
        {
          column: 'Text',
          operators: ['eq', 'like'],
          query: undefined,
        },
        {
          column: 'Number',
          operators: ['eq', 'gt', 'lt'],
          query: undefined,
        },
      ]);
    });

    it('Should return filterable columns schema', async () => {
      const schema = FilterableModel.filterSchema();
      // Current contract: the { op, filters } envelope. Value is not required
      // (valueless operators like isnull carry none) and supports array/boolean.
      expect(schema).to.deep.eq({
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: ['and', 'or'],
          },
          filters: {
            type: 'array',
            items: {
              type: 'object',
              anyOf: [
                {
                  type: 'object',
                  required: ['Column', 'Operator'],
                  properties: {
                    Column: { const: 'Text' },
                    Value: { type: ['string', 'integer', 'array', 'boolean'] },
                    Operator: { type: 'string', enum: ['eq', 'like'] },
                  },
                },
                {
                  type: 'object',
                  required: ['Column', 'Operator'],
                  properties: {
                    Column: { const: 'Number' },
                    Value: { type: ['string', 'integer', 'array', 'boolean'] },
                    Operator: { type: 'string', enum: ['eq', 'gt', 'lt'] },
                  },
                },
              ],
            },
          },
        },
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

      // 'gte' is not among the model's allowed operators for Number (eq, gt, lt)
      const result2 = await FilterableModel.select().filter([
        {
          Column: 'Number',
          Value: 3,
          Operator: 'gt',
        },
      ]);

      expect(result2).to.be.an('array');
      expect(result2.length).to.eq(2);
      expect(result2[0].Number).to.eq(4);
      expect(result2[1].Number).to.eq(5);

      const result3 = await FilterableModel.filter<FilterableModel>({
        op: FilterableLogicalOperators.And,
        filters: [
          {
            Column: 'Text',
            Value: 'hello',
            Operator: 'eq',
          },
        ],
      });

      expect(result3).to.be.an('array');
      expect(result3.length).to.eq(1);
      expect(result3[0].Text).to.eq('hello');
      expect(result3[0].Number).to.eq(1);
      expect(result3[0].Id).to.eq(1);
    });
  });

  describe('DTO @Relation resolution (route-level e2e)', function () {
    // NOTE: dehydrate() intentionally omits relation FK columns (see
    // StandardModelDehydrator), so the persisted FK is asserted by reloading
    // the row through the ORM - the DB is the source of truth here.
    const reloadAuthorFk = async () => ((await (Campaign as any).where({ Id: 3 }).firstOrFail()) as any).author as number;

    it('resolves the relation from the request body and persists the translated FK', async () => {
      const result = await req()
        .put('campaign/3')
        .set('Accept', 'application/json')
        .send({ Name: 'e2e-updated', author: 'user-uuid-2' });

      expect(result.status).to.eq(200);
      expect(result.body.Name).to.eq('e2e-updated');
      expect(await reloadAuthorFk()).to.eq(200);
    });

    it('returns 404 when the referenced entity does not exist', async () => {
      const result = await req()
        .put('campaign/3')
        .set('Accept', 'application/json')
        .send({ author: 'no-such-user' });

      expect(result.status).to.eq(404);
    });

    it('accepts an absent optional relation field and leaves the FK untouched', async () => {
      const fkBefore = await reloadAuthorFk();

      const result = await req()
        .put('campaign/3')
        .set('Accept', 'application/json')
        .send({ Name: 'name-only-update' });

      expect(result.status).to.eq(200);
      expect(result.body.Name).to.eq('name-only-update');
      expect(await reloadAuthorFk()).to.eq(fkBefore);
    });

    it('rejects a missing schema-required relation field with 400 (StrictCampaignDTO)', async () => {
      const result = await req()
        .put('campaign/strict/3')
        .set('Accept', 'application/json')
        .send({ Name: 'strict-no-author' });

      expect(result.status).to.eq(400);
    });

    it('still resolves the inherited relation on the strict DTO when the field is present', async () => {
      const result = await req()
        .put('campaign/strict/3')
        .set('Accept', 'application/json')
        .send({ author: 'user-uuid-1' });

      expect(result.status).to.eq(200);
      expect(await reloadAuthorFk()).to.eq(100);
    });
  });
});
