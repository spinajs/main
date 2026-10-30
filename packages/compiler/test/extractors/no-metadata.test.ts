import 'mocha';
import { expect } from 'chai';
import { analyzePackage } from '../../src/index.js';
import { DECORATED_PARAM_KIND, type ManifestFragment } from '@spinajs/manifest';

const OPTIONS = { tsconfig: 'test/fixtures/no-metadata/tsconfig.json', packageRoot: 'test/fixtures/no-metadata' };
const db = { package: 'no-metadata', file: 'src/services.ts', export: 'Db' };

describe('what a build without decorator metadata needs from the manifest', () => {
  let fragment: ManifestFragment;

  before(async () => {
    fragment = await analyzePackage(OPTIONS);
  });

  describe('route arguments', () => {
    const me = () => fragment.controllers.find((c) => c.className === 'UsersController')!.routes.find((r) => r.handler === 'me')!;

    it('records a parameter under a decorator it does not know, with its type', () => {
      const user = me().params.find((p) => p.name === 'user')!;
      expect(user.index).to.equal(1);
      expect(user.kind).to.equal(DECORATED_PARAM_KIND);
      expect(user.runtimeType.ref).to.deep.equal({ package: 'no-metadata', file: 'src/controllers.ts', export: 'Principal' });
    });

    it('never makes it a wire argument and derives no schema for it', () => {
      const user = me().params.find((p) => p.name === 'user')!;
      expect(user.wire).to.deep.equal({ in: 'none', shape: 'whole' });
      expect(user.runtimeType).to.not.have.property('schema');
    });

    it('still skips an undecorated parameter', () => {
      expect(me().params.map((p) => p.name)).to.deep.equal(['id', 'user']);
    });
  });

  describe('an argument whose class the manifest cannot name', () => {
    const route = (handler: string) => fragment.controllers.find((c) => c.className === 'UsersController')!.routes.find((r) => r.handler === handler)!;
    const OBJECT = { package: 'global', file: '', export: 'Object' };

    it('records Object for a kind that never reads the type', () => {
      const [body, req] = route('upload').params;
      expect(body.runtimeType.ref).to.deep.equal(OBJECT);
      expect(req.runtimeType.ref).to.deep.equal(OBJECT);
      expect(body.runtimeType).to.not.have.property('refProblem');
    });

    it('records why for a kind that does read it', () => {
      const [when] = route('since').params;
      expect(when.runtimeType).to.not.have.property('ref');
      expect(when.runtimeType.refProblem).to.match(/^DateTime is declared in @types\/luxon, which ships no manifest fragment/);
    });
  });

  describe('inherited routes', () => {
    it('keeps an abstract controller as a base: never mounted, its routes still answer for subclasses', () => {
      expect(fragment.controllers.map((c) => c.className)).to.deep.equal(['UsersController']);
      expect(fragment.controllerBases?.map((c) => c.className)).to.deep.equal(['CrudController']);
      expect(fragment.controllerBases?.[0].routes[0].params[0].runtimeType.ref).to.deep.equal({ package: 'global', file: '', export: 'Number' });
    });

    it('keeps a controller outside the declared dirs as a base', async () => {
      const dirs = await analyzePackage({ tsconfig: 'test/fixtures/dirs-pkg/tsconfig.json', packageRoot: 'test/fixtures/dirs-pkg', declaredDirsOnly: true });
      expect(dirs.controllers.map((c) => c.className)).to.deep.equal(['RealController']);
      expect(dirs.controllerBases?.map((c) => c.className)).to.deep.equal(['AbstractBaseController', 'ElsewhereController']);
    });
  });

  describe('decorated properties', () => {
    const entry = (className: string) => fragment.classProperties?.find((c) => c.className === className);
    const property = (name: string) => entry('Repo')!.properties.find((p) => p.property === name)!;

    it('keys every class with a typed property decorator by entry id, service or not', () => {
      expect(entry('Repo')?.id).to.equal('no-metadata:Repo');
      expect(entry('Base')?.id).to.equal('no-metadata:Base');
      expect(entry('Base')?.properties[0].tokenRef).to.deep.equal(db);
      expect(entry('Plain')).to.equal(undefined);
    });

    it('records the declared type of a property that names none', () => {
      expect(property('db').tokenRef).to.deep.equal(db);
      expect(property('lazy').tokenRef).to.deep.equal(db);
    });

    it('decides a list from the checked type: an alias, readonly, optional', () => {
      for (const name of ['alias', 'readonlyList', 'optionalAlias', 'mapAlias', 'lazyAlias', 'lazyReadonly']) {
        expect(property(name), name).to.include({ array: true }).and.not.have.property('tokenRef');
      }
    });

    it('keeps the token the decorator names', () => {
      expect(property('readonlyList').token).to.equal('Plugin');
      expect(property('alias').token).to.equal('Plugin');
    });

    it('decides a list the same way for @AutoinjectService', () => {
      const configured = fragment.services.find((s) => s.className === 'Configured')!.propertyInjects;
      const array = (name: string) => configured.find((p) => p.property === name)?.array;
      expect(array('alias')).to.equal(true);
      expect(array('readonlyList')).to.equal(true);
      expect(array('one')).to.equal(false);
    });

    it('records no type for a list under @AutoinjectService, written either way', () => {
      const { properties } = entry('ConfiguredByType')!;
      const row = (name: string) => properties.find((p) => p.property === name);
      expect(row('alias')).to.include({ array: true }).and.not.have.property('tokenRef');
      expect(row('list')).to.include({ array: true }).and.not.have.property('tokenRef');
      expect(row('one')?.tokenRef).to.deep.equal({ package: 'no-metadata', file: 'src/services.ts', export: 'Plugin' });
    });

    it('records whether an explicitly typed property is a list', () => {
      expect(property('one')).to.include({ array: false }).and.not.have.property('tokenRef');
      expect(property('list')).to.include({ array: true }).and.not.have.property('tokenRef');
      expect(property('map')).to.include({ array: true }).and.not.have.property('tokenRef');
    });

    it('records a property under a decorator it does not know, for the list shape alone', () => {
      const wrapped = (name: string) => entry('Wrapped')?.properties.find((p) => p.property === name);
      expect(wrapped('one')).to.include({ array: false }).and.not.have.property('tokenRef');
      expect(wrapped('list')).to.include({ array: true }).and.not.have.property('tokenRef');
      expect(wrapped('alias')).to.include({ array: true }).and.not.have.property('tokenRef');
    });

    it('leaves out a decorator it knows injects by its own arguments', () => {
      expect(entry('Wrapped')?.properties.map((p) => p.property)).to.not.include('name');
    });

    it('records nothing for a package built with decorator metadata: it never needs the table', async () => {
      const metadata = await analyzePackage({ tsconfig: 'test/fixtures/pkg-basic/tsconfig.json', packageRoot: 'test/fixtures/pkg-basic' });
      expect(metadata).to.not.have.property('classProperties');
    });
  });

  describe('inherited socket handlers', () => {
    const base = () => fragment.socketControllerBases?.find((c) => c.className === 'CrudSocket');

    it('keeps an abstract socket controller as a base: never mounted, its handlers still answer for subclasses', () => {
      expect(fragment.socketControllers.map((c) => c.className)).to.include('ThingsSocket').and.not.include('CrudSocket');
      expect(fragment.socketControllers.find((c) => c.className === 'ThingsSocket')?.commands).to.deep.equal([]);
      expect(fragment.socketControllerBases?.map((c) => c.className)).to.deep.equal(['CrudSocket']);
    });

    it('records the commands, events and @FromDI() types of the base', () => {
      const hello = { package: 'no-metadata', file: 'src/sockets.ts', export: 'Hello' };
      expect(base()?.commands[0].payload.ref).to.deep.equal(hello);
      expect(base()?.events[0].payload.ref).to.deep.equal(hello);
      expect(base()?.diArgs).to.deep.equal([{ handler: 'save', index: 1, ref: db }]);
    });
  });

  describe('what model and configuration decorators read', () => {
    const relation = { package: '@spinajs/orm', file: 'lib/relation-objects.js', export: 'Relation' };
    const owner = () => fragment.classProperties?.find((c) => c.className === 'Owner')?.properties;
    const ref = (name: string) => owner()?.find((p) => p.property === name)?.tokenRef;

    it('records the class a relation property declares', () => {
      expect(ref('Pets')).to.deep.equal(relation);
      expect(ref('Linked')).to.deep.equal(relation);
      expect(ref('Names')).to.deep.equal({ package: 'no-metadata', file: 'src/models.ts', export: 'PetNames' });
    });

    it('records the model of @JunctionTable', () => {
      expect(ref('Junction')).to.deep.equal({ package: 'no-metadata', file: 'src/models.ts', export: 'Link' });
    });

    it('gives a column nothing to import', () => {
      expect(owner()?.filter((p) => p.property === 'Id')).to.have.length(1);
      expect(ref('Id')).to.equal(undefined);
    });

    it('records the declared type of @AutoinjectService unless the decorator names one', () => {
      const holder = fragment.classProperties?.find((c) => c.className === 'Holder')?.properties;
      expect(holder?.find((p) => p.property === 'db')?.tokenRef).to.deep.equal(db);
      expect(holder?.find((p) => p.property === 'named')).to.not.have.property('tokenRef');
    });
  });

  describe('socket @FromDI', () => {
    it('records the type of every @FromDI() parameter by handler, hooks included', () => {
      const docs = fragment.socketControllers.find((c) => c.className === 'DocsSocket')!;
      expect(docs.diArgs).to.deep.equal([
        { handler: 'open', index: 1, ref: db },
        { handler: 'seen', index: 0, ref: db },
        { handler: 'connected', index: 0, ref: db },
      ]);
    });
  });
});
