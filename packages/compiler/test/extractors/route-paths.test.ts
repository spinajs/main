import { expect } from 'chai';
import { buildRoutePath } from '@spinajs/http';
import type { IRoute } from '@spinajs/http';
import type { ControllerEntry } from '@spinajs/manifest';
import { createProgramFromTsconfig, createContext, extractControllers } from '../../src/index.js';

describe('controller and route paths', () => {
  const unit = createProgramFromTsconfig('test/fixtures/unit/tsconfig.json');
  const ctx = createContext(unit, 'unit', 'test/fixtures/unit');
  const controllers = extractControllers(ctx, unit.sourceFiles.find((f) => f.fileName.endsWith('route-paths.ts'))!);
  const byName = (name: string): ControllerEntry => controllers.find((c) => c.className === name)!;
  const paths = (name: string): string[] => byName(name).routes.map((r) => `${r.method} ${r.fullPath}`);

  it('records the path @spinajs/http serves: handler fallback, slashes as written', () => {
    expect(paths('UsersPathController')).to.deep.equal(['get /users/list', 'get /users/emptyString', 'get /users', 'get /users//slash', 'post /users/create', 'get /users/:id']);
    expect(paths('NestedController')).to.deep.equal(['get /api/v2/things/all', 'get /api/v2/things']);
    expect(paths('RootController')).to.deep.equal(['get /health', 'get ///bare', 'get //']);
    expect(paths('LeadingSlashBaseController')).to.deep.equal(['get //lead/x']);
  });

  it('keeps the declared route path, a missing argument as an empty string', () => {
    expect(byName('UsersPathController').routes.map((r) => r.path)).to.deep.equal(['', '', '/', '/slash', '', ':id']);
  });

  it('mounts a controller without @BasePath under its lower-cased class name', () => {
    expect(byName('NoBaseController')).to.deep.include({ basePath: null, mountPath: 'nobasecontroller' });
    expect(paths('NoBaseController')).to.deep.equal(['get /nobasecontroller/ping', 'get /nobasecontroller/pong']);
  });

  it('mounts a configured base path at its default without outer slashes', () => {
    expect(byName('ConfiguredController')).to.deep.include({ basePath: '/admin/', basePathConfig: 'admin.base', mountPath: 'admin' });
    expect(paths('ConfiguredController')).to.deep.equal(['get /admin/ping']);
  });

  it('agrees with the http route builder for every route', () => {
    for (const c of controllers) {
      for (const r of c.routes) {
        expect(r.fullPath, `${c.className}.${r.handler}`).to.equal(buildRoutePath(c.mountPath!, { Path: r.path, Method: r.handler } as IRoute));
      }
    }
  });
});
