import 'mocha';
import { expect } from 'chai';
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
});
