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

    it('records whether an explicitly typed property is a list', () => {
      expect(property('one')).to.include({ array: false }).and.not.have.property('tokenRef');
      expect(property('list')).to.include({ array: true }).and.not.have.property('tokenRef');
      expect(property('map')).to.include({ array: true }).and.not.have.property('tokenRef');
    });

    it('records nothing for a package built with decorator metadata: it never needs the table', async () => {
      const metadata = await analyzePackage({ tsconfig: 'test/fixtures/pkg-basic/tsconfig.json', packageRoot: 'test/fixtures/pkg-basic' });
      expect(metadata).to.not.have.property('classProperties');
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
