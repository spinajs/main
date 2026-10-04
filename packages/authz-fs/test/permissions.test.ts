import * as chai from 'chai';
import 'mocha';

import { PermissionRegistryImpl } from '@spinajs/authz';

import { FS_PERMISSIONS, FsResourceAdapter } from '../src/index.js';

const expect = chai.expect;

describe('authz-fs permissions', () => {
  const registry = (): PermissionRegistryImpl => {
    const r = new PermissionRegistryImpl();
    r.register(FS_PERMISSIONS, 'adapter:fs');
    r.freeze();
    return r;
  };

  it('declares the six fs permissions on fs, dir and file', () => {
    expect(FS_PERMISSIONS.map((p) => p.name)).to.deep.equal(['fs:read', 'fs:stat', 'fs:list', 'fs:write', 'fs:delete', 'fs:share']);
    for (const p of FS_PERMISSIONS) {
      expect(p.resource, p.name).to.equal('fs');
      expect(p.action, p.name).to.equal(p.name.slice(3));
      expect(p.types, p.name).to.deep.equal(['fs', 'dir', 'file']);
      expect(p.description, p.name).to.be.a('string').and.not.equal('');
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(FS_PERMISSIONS)).to.equal(true);
    for (const p of FS_PERMISSIONS) {
      expect(Object.isFrozen(p), p.name).to.equal(true);
      expect(Object.isFrozen(p.types), p.name).to.equal(true);
    }
  });

  it('registers and freezes in a real PermissionRegistry', () => {
    const r = registry();
    expect(r.all().map((d) => d.name)).to.have.members(FS_PERMISSIONS.map((p) => p.name));
    expect(r.require('fs:share').source).to.equal('adapter:fs');
    expect(r.match('fs:*')).to.have.length(6);
    expect(r.types()).to.deep.equal(['dir', 'file', 'fs']);
  });

  it('fs:read and fs:write imply fs:stat, nothing else implies', () => {
    const r = registry();
    expect(r.get('fs:read')?.implies).to.deep.equal(['fs:stat']);
    expect(r.get('fs:write')?.implies).to.deep.equal(['fs:stat']);
    expect(r.impliedBy('fs:stat')).to.deep.equal(['fs:read', 'fs:write']);
    for (const name of ['fs:read', 'fs:list', 'fs:write', 'fs:delete', 'fs:share']) expect(r.impliedBy(name), name).to.deep.equal([]);
    for (const name of ['fs:stat', 'fs:list', 'fs:delete', 'fs:share']) expect(r.get(name)?.implies, name).to.equal(undefined);
  });

  it('is what the adapter declares', () => {
    expect(new FsResourceAdapter().permissions()).to.equal(FS_PERMISSIONS);
  });
});
