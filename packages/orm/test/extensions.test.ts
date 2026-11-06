import type { Class } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { useTestApp } from '@spinajs/testing';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { ormApp, registerRelationHydrators } from './misc.js';
import { Orm } from '../src/orm.js';
import { ExtensionMethodCollision } from '../src/exceptions.js';
import { QueryExtension, SelectQueryExtension, UpdateQueryExtension, defineQueryExtension } from '../src/extensions.js';
import type { QueryTarget } from '../src/extensions.js';
import { installQueryExtensions } from '../src/extension-install.js';
import { DeleteQueryBuilder, InsertQueryBuilder, SelectQueryBuilder, UpdateQueryBuilder, createQuery } from '../src/builders.js';
import type { QueryBuilder } from '../src/builders.js';
import { RawModel } from './mocks/models/RawModel.js';
import '../src/bootstrap.js';
import '@spinajs/log';

chai.use(chaiAsPromised);
const expect = chai.expect;

const tags = new WeakMap<QueryBuilder, string>();
const clones: Array<[QueryBuilder, QueryBuilder]> = [];

// One methods object, one class per builder: the shape authz-orm uses for its three builders.
const taggingMethods: QueryExtension['methods'] = {
  tagged(this: QueryBuilder, tag: string) {
    tags.set(this, tag);
    return this;
  },
};

const TaggingSelect = defineQueryExtension({
  name: 'test.tagging',
  target: 'select',
  methods: taggingMethods,
  onClone(source, clone) {
    clones.push([source, clone]);
    const tag = tags.get(source);
    if (tag !== undefined) tags.set(clone, tag);
  },
});

const TaggingUpdate = defineQueryExtension({ name: 'test.tagging', target: 'update', methods: taggingMethods });

const addsTranslate = (name: string) =>
  defineQueryExtension({
    name,
    target: 'select',
    methods: {
      translate(this: QueryBuilder) {
        return this;
      },
    },
  });

class Greeting extends SelectQueryExtension {
  public readonly name = 'test.greeting';
  public readonly methods: QueryExtension['methods'] = { greet: () => 'hello' };
}

class LoudGreeting extends Greeting {
  public readonly methods: QueryExtension['methods'] = { greet: () => 'HELLO' };
}

class Rootless extends QueryExtension {
  public readonly name = 'test.rootless';
  public readonly methods: QueryExtension['methods'] = {};
}

type Tagged = SelectQueryBuilder & { tagged(tag: string): Tagged };

const has = (prototype: object, method: string) => Object.prototype.hasOwnProperty.call(prototype, method);
const make = (type: Class<QueryExtension>) => new (type as new () => QueryExtension)();
const shadowingWhere = () =>
  make(
    defineQueryExtension({
      name: 'test.shadow',
      target: 'select',
      methods: {
        where(this: QueryBuilder) {
          return this;
        },
      },
    }),
  );

describe('Query extensions', () => {
  describe('installed by Orm.resolve()', () => {
    useTestApp(() =>
      ormApp({
        register: (c) => {
          registerRelationHydrators(c);
          c.register(TaggingSelect).as(SelectQueryExtension);
          c.register(TaggingUpdate).as(UpdateQueryExtension);
        },
        resolve: [Orm],
      }),
    );

    it('adds the methods to the builders the extension bases name only', () => {
      expect(has(SelectQueryBuilder.prototype, 'tagged')).to.equal(true);
      expect(has(UpdateQueryBuilder.prototype, 'tagged')).to.equal(true);
      expect(has(DeleteQueryBuilder.prototype, 'tagged')).to.equal(false);
      expect(has(InsertQueryBuilder.prototype, 'tagged')).to.equal(false);
    });

    it('runs a method with this bound to the builder', () => {
      const query = RawModel.select() as unknown as Tagged;
      expect(query.tagged('a')).to.equal(query);
      expect(tags.get(query)).to.equal('a');
    });

    it('state() exposes the model, the live relation list, the container and the connection', () => {
      const query = RawModel.select() as unknown as SelectQueryBuilder;
      const state = query.state();
      expect(state.model?.name).to.equal('RawModel');
      expect(state.relations).to.equal(query.Relations);
      expect(state.owner).to.equal(undefined);
      expect(state.container).to.equal(query.Container);
      expect(state.connection).to.equal(query.Driver);
    });

    it('state() of a non-select builder has no relations', () => {
      const { query } = createQuery(RawModel, DeleteQueryBuilder);
      expect(query.state().relations).to.deep.equal([]);
      expect(query.state().model?.name).to.equal('RawModel');
    });

    it('runs onClone with the source and the copy when a select builder is cloned', () => {
      const query = (RawModel.query() as unknown as Tagged).tagged('kept');
      const copy = query.clone();
      const [source, clone] = clones[clones.length - 1];
      expect(source).to.equal(query);
      expect(clone).to.equal(copy);
      expect(tags.get(copy)).to.equal('kept');
    });
  });

  // Runs after the block above, in file order: that block left `tagged` installed.
  describe('a later Orm.resolve() without the extension', () => {
    useTestApp(() => ormApp({ register: registerRelationHydrators, resolve: [Orm] }));

    it('removes the methods the previous install added', () => {
      expect(has(SelectQueryBuilder.prototype, 'tagged')).to.equal(false);
      expect(has(UpdateQueryBuilder.prototype, 'tagged')).to.equal(false);
    });
  });

  describe('two extensions adding translate', () => {
    const app = useTestApp(() =>
      ormApp({
        register: (c) => {
          registerRelationHydrators(c);
          c.register(addsTranslate('test.first')).as(SelectQueryExtension);
          c.register(addsTranslate('test.second')).as(SelectQueryExtension);
        },
      }),
    );

    it('fail the boot with ExtensionMethodCollision and install nothing', async () => {
      await expect(app().resolve(Orm)).to.be.rejectedWith(ExtensionMethodCollision, 'query extensions test.first and test.second both add translate to the select builder');
      expect(has(SelectQueryBuilder.prototype, 'translate')).to.equal(false);
    });
  });

  describe('installQueryExtensions()', () => {
    afterEach(() => installQueryExtensions([]));

    it('refuses a method the builder already has', () => {
      expect(() => installQueryExtensions([shadowingWhere()])).to.throw(ExtensionMethodCollision, 'query extension test.shadow adds where to the select builder, which already has it');
    });

    it('refuses an extension that extends QueryExtension without one of the four bases', () => {
      expect(() => installQueryExtensions([new Rootless()])).to.throw(InvalidArgument, 'query extension test.rootless extends QueryExtension directly; extend SelectQueryExtension, UpdateQueryExtension, DeleteQueryExtension or InsertQueryExtension');
    });

    it('defineQueryExtension() picks the base from target and refuses an unknown one', () => {
      expect(make(TaggingSelect)).to.be.instanceOf(SelectQueryExtension);
      expect(make(TaggingUpdate)).to.be.instanceOf(UpdateQueryExtension);
      expect(() => defineQueryExtension({ name: 'test.odd', target: 'merge' as QueryTarget, methods: {} })).to.throw(InvalidArgument, 'query extension test.odd targets merge; expected one of select, update, delete, insert');
    });

    it('lets an extension whose class extends another registered extension replace it', () => {
      installQueryExtensions([new Greeting(), new LoudGreeting()]);
      expect((SelectQueryBuilder.prototype as unknown as { greet(): string }).greet()).to.equal('HELLO');
    });

    it('leaves no method of the previous install behind when an install fails', () => {
      installQueryExtensions([new Greeting()]);
      expect(() => installQueryExtensions([shadowingWhere()])).to.throw(ExtensionMethodCollision);
      expect(has(SelectQueryBuilder.prototype, 'greet')).to.equal(false);
    });

    it('names a defined extension class after its base and the extension, so DI caches each one apart', () => {
      expect(defineQueryExtension({ name: 'test.named', target: 'select', methods: {} }).name).to.equal('SelectQueryExtension:test.named');
      expect(TaggingUpdate.name).to.equal('UpdateQueryExtension:test.tagging');
    });
  });
});
