import { expect } from 'chai';
import 'mocha';

import { AuthzConfigError, PermissionRegistry, UnknownPermission } from '@spinajs/authz';

import { FakePermissionRegistry } from '../src/index.js';

describe('FakePermissionRegistry', () => {
  it('builds defs from names: parsed resource/action, types = [resource], source fake', () => {
    const r = new FakePermissionRegistry(['file:read', 'user.metadata:write']);
    expect(r).to.be.instanceOf(PermissionRegistry);
    expect(r.get('file:read')).to.deep.eq({ name: 'file:read', resource: 'file', action: 'read', types: ['file'], source: 'fake' });
    expect(r.require('user.metadata:write').types).to.deep.eq(['user.metadata']);
    expect(Object.isFrozen(r.get('file:read'))).to.eq(true);
  });

  it('keeps the parts of a partial def that are given', () => {
    const r = new FakePermissionRegistry([{ name: 'fs:stat', types: ['fs', 'dir'], fields: true, source: 'adapter:fs' }]);
    expect(r.get('fs:stat')).to.deep.eq({ name: 'fs:stat', resource: 'fs', action: 'stat', types: ['fs', 'dir'], fields: true, source: 'adapter:fs' });
  });

  it('rejects invalid names and duplicates', () => {
    expect(() => new FakePermissionRegistry(['nocolon'])).to.throw(AuthzConfigError);
    expect(() => new FakePermissionRegistry(['a:b', 'a:b'])).to.throw(AuthzConfigError);
  });

  it('require throws UnknownPermission, get returns undefined', () => {
    const r = new FakePermissionRegistry(['file:read']);
    expect(r.get('file:write')).to.eq(undefined);
    expect(() => r.require('file:write')).to.throw(UnknownPermission);
  });

  it('match uses permission globs in registration order', () => {
    const r = new FakePermissionRegistry(['file:read', 'file:write', 'user:read']);
    expect(r.match('file:*').map((d) => d.name)).to.deep.eq(['file:read', 'file:write']);
    expect(r.match('*:read').map((d) => d.name)).to.deep.eq(['file:read', 'user:read']);
    expect(r.match('*')).to.have.length(3);
    expect(() => r.match('**')).to.throw(AuthzConfigError);
  });

  it('impliedBy is the transitive closure of implies, cycle-safe, without the name itself', () => {
    const r = new FakePermissionRegistry([
      { name: 'fs:admin', implies: ['fs:write'] },
      { name: 'fs:write', implies: ['fs:stat', 'fs:read'] },
      'fs:read',
      'fs:stat',
      { name: 'x:a', implies: ['x:b'] },
      { name: 'x:b', implies: ['x:a'] },
    ]);
    expect(r.impliedBy('fs:stat')).to.deep.eq(['fs:admin', 'fs:write']);
    expect(r.impliedBy('fs:write')).to.deep.eq(['fs:admin']);
    expect(r.impliedBy('fs:admin')).to.deep.eq([]);
    expect(r.impliedBy('x:a')).to.deep.eq(['x:b']);
  });

  it('register adds defs later; all lists every def', () => {
    const r = new FakePermissionRegistry(['a:b']);
    r.register('c:d', { name: 'e:f', source: 'model:rbac' });
    expect(r.all().map((d) => d.name)).to.deep.eq(['a:b', 'c:d', 'e:f']);
    expect(r.get('e:f')!.source).to.eq('model:rbac');
  });
});
