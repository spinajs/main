import { expect } from 'chai';
import 'mocha';
import { configuredMountPath, controllerMountPath, routeFullPath, withRoutePrefix } from '../src/index.js';

/** [basePath, route path, handler, served path]: what `@spinajs/http` mounts, slashes and all. */
export const ROUTE_PATH_TABLE: [string, string | undefined, string, string][] = [
  ['users', undefined, 'list', '/users/list'],
  ['users', '', 'emptyString', '/users/emptyString'],
  ['users', '/', 'root', '/users'],
  ['users', ':id', 'get', '/users/:id'],
  ['users', ':id/avatar', 'avatar', '/users/:id/avatar'],
  ['users', '/slash', 'leadingSlash', '/users//slash'],
  ['api/v2/things', undefined, 'all', '/api/v2/things/all'],
  ['api/v2/things', '/', 'index', '/api/v2/things'],
  ['api/v2/things', ':id', 'one', '/api/v2/things/:id'],
  ['nobasecontroller', 'ping', 'ping', '/nobasecontroller/ping'],
  ['nobasecontroller', undefined, 'pong', '/nobasecontroller/pong'],
  ['/', 'health', 'health', '/health'],
  ['/', undefined, 'bare', '///bare'],
  ['/', '/', 'slash', '//'],
  ['/lead', 'x', 'x', '//lead/x'],
  ['open/', 'ping', 'ping', '/open//ping'],
];

describe('route paths', () => {
  for (const [basePath, path, handler, served] of ROUTE_PATH_TABLE) {
    it(`routeFullPath(${JSON.stringify(basePath)}, ${JSON.stringify(path)}, ${handler}) is ${served}`, () => {
      expect(routeFullPath(basePath, path, handler)).to.equal(served);
    });
  }

  it('mounts a controller without @BasePath under its lower-cased class name', () => {
    expect(controllerMountPath(null, 'NoBaseController')).to.equal('nobasecontroller');
    expect(controllerMountPath('', 'NoBaseController')).to.equal('nobasecontroller');
    expect(controllerMountPath('users', 'UsersController')).to.equal('users');
    expect(controllerMountPath('/lead', 'LeadController')).to.equal('/lead');
  });

  it('trims the slashes of a configured base path', () => {
    expect(configuredMountPath(' /admin/b/ ')).to.equal('admin/b');
    expect(configuredMountPath('a/b')).to.equal('a/b');
    expect(configuredMountPath('/')).to.equal('/');
  });

  it('prepends the global route prefix only when it is set', () => {
    expect(withRoutePrefix('api/v1', '/users/list')).to.equal('/api/v1/users/list');
    expect(withRoutePrefix(undefined, '/users/list')).to.equal('/users/list');
    expect(withRoutePrefix('', '/users/list')).to.equal('/users/list');
  });
});
