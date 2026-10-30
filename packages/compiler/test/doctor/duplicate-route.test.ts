import 'mocha';
import { expect } from 'chai';
import { createProgramFromTsconfig, createContext, extractControllers } from '../../src/index.js';
import { duplicateRoute } from '../../src/doctor/rules/duplicate-route.js';
import { fixture, controller, route, src } from './fixture.js';

const ctx = { cwd: '/fixture', fileExists: () => true, fragmentMtime: () => undefined, libMtime: () => undefined };

describe('HTTP001 duplicate-route', () => {
  it('reports the same method and fullPath across controllers', () => {
    const m = fixture({
      controllers: [
        controller({ className: 'Users', routes: [route({ handler: 'list', method: 'get', fullPath: '/users' })] }),
        controller({ className: 'Admin', routes: [route({ handler: 'all', method: 'get', fullPath: '/users', source: src('src/admin.ts', 12) }), route({ handler: 'create', method: 'post', fullPath: '/users' })] }),
      ],
    });
    expect(duplicateRoute.run(m, ctx)).to.deep.equal([
      { code: 'HTTP001', severity: 'error', message: 'Duplicate route GET /users: Users.list and Admin.all', source: src('src/admin.ts', 12) },
    ]);
  });

  it('matches paths that differ only in case or in parameter names, as Express does', () => {
    const m = fixture({
      controllers: [
        controller({ className: 'Users', routes: [route({ handler: 'get', fullPath: '/users/:id' })] }),
        controller({ className: 'Admin', routes: [route({ handler: 'one', fullPath: '/Users/:userId', source: src('src/admin.ts', 3) })] }),
      ],
    });
    expect(duplicateRoute.run(m, ctx)).to.deep.equal([
      { code: 'HTTP001', severity: 'error', message: 'Duplicate route GET /users/:id: Users.get and Admin.one (as /Users/:userId)', source: src('src/admin.ts', 3) },
    ]);
  });

  it('matches a trailing slash the way the non-strict router does', () => {
    const m = fixture({
      controllers: [controller({ className: 'Users', routes: [route({ handler: 'list', fullPath: '/users/list' }), route({ handler: 'all', path: 'list/', fullPath: '/users/list/', source: src('src/users.ts', 5) })] })],
    });
    expect(duplicateRoute.run(m, ctx)).to.deep.equal([
      { code: 'HTTP001', severity: 'error', message: 'Duplicate route GET /users/list: Users.list and Users.all (as /users/list/)', source: src('src/users.ts', 5) },
    ]);
  });

  it('does not report bare sibling routes, which are served under their handler names', () => {
    const unit = createProgramFromTsconfig('test/fixtures/unit/tsconfig.json');
    const controllers = extractControllers(createContext(unit, 'unit', 'test/fixtures/unit'), unit.sourceFiles.find((f) => f.fileName.endsWith('route-paths.ts'))!);
    expect(duplicateRoute.run(fixture({ controllers }), ctx)).to.deep.equal([]);
  });

  it('reports an explicit path that equals a sibling handler fallback', () => {
    const m = fixture({
      controllers: [controller({ className: 'Users', routes: [route({ handler: 'list', path: '', fullPath: '/users/list' }), route({ handler: 'all', path: 'list', fullPath: '/users/list', source: src('src/users.ts', 9) })] })],
    });
    expect(duplicateRoute.run(m, ctx)).to.deep.equal([
      { code: 'HTTP001', severity: 'error', message: 'Duplicate route GET /users/list: Users.list and Users.all', source: src('src/users.ts', 9) },
    ]);
  });
});
