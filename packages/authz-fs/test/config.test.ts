import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { fsAccessConfig, parseFsAccessConfig } from '../src/index.js';
import { configuredChild } from './helpers.js';

const expect = chai.expect;

describe('authz-fs config: parseFsAccessConfig', () => {
  it('reads a missing entry as mode off in the root domain (D1)', () => {
    expect(parseFsAccessConfig('plain', undefined)).to.deep.equal({ mode: 'off', domain: 'root' });
  });

  it('defaults the domain to root', () => {
    expect(parseFsAccessConfig('uploads', { mode: 'enforce' })).to.deep.equal({ mode: 'enforce', domain: 'root' });
    expect(parseFsAccessConfig('archive', { mode: 'audit' })).to.deep.equal({ mode: 'audit', domain: 'root' });
    expect(parseFsAccessConfig('scratch', { mode: 'off' })).to.deep.equal({ mode: 'off', domain: 'root' });
  });

  it('keeps every documented key', () => {
    const entry = {
      mode: 'enforce',
      domain: 'fs',
      metadata: 'OrmFileMetadataStore',
      stampOwner: true,
      resolver: 'TaskAttachmentPathResolver',
      inherit: { 'fs:read': 'read', 'fs:write': 'update', 'fs:delete': 'update' },
      signedUrl: { maxTtlSeconds: 900, defaultTtlSeconds: 300 },
      policies: [{ id: 'public', effect: 'permit', permissions: ['fs:read', 'fs:stat'], when: { attr: 'resource.id', glob: 'uploads:public/**' } }],
      operations: { thumbnail: 'fs:read', publish: ['fs:read', 'fs:share'] },
      list: 'each',
    };
    expect(parseFsAccessConfig('uploads', entry)).to.deep.equal({ ...entry, policies: [{ ...entry.policies[0], scope: { type: 'fs', id: 'uploads' } }] });
  });

  it('scopes a policy without a scope to its filesystem, and keeps a scope inside it', () => {
    const permit = { id: 'p', effect: 'permit', permissions: ['fs:*'] };
    const cfg = parseFsAccessConfig('uploads', {
      mode: 'enforce',
      policies: [permit, { ...permit, id: 'd', scope: { type: 'dir', id: 'uploads:public' }, resourceTypes: ['file', 'dir'] }, { ...permit, id: 'f', scope: { type: 'fs', id: 'uploads' } }],
    });
    expect(cfg.policies!.map((p) => p.scope)).to.deep.equal([
      { type: 'fs', id: 'uploads' },
      { type: 'dir', id: 'uploads:public' },
      { type: 'fs', id: 'uploads' },
    ]);
  });

  const policy = (extra: Record<string, unknown>) => ({ mode: 'enforce', policies: [{ id: 'staff', effect: 'permit', permissions: ['fs:read'], ...extra }] });
  const refused: [string, Record<string, unknown>][] = [
    ['a non-fs permission', { permissions: ['fs:read', 'task:read'] }],
    ['the * permission glob', { permissions: ['*'] }],
    ['a permission glob over every resource', { permissions: ['*:read'] }],
    ['permissions that are not a list', { permissions: 'fs:read' }],
    ['a resource type outside fs, dir and file', { resourceTypes: ['file', 'task'] }],
    ['a scope on a domain parent', { scope: { type: 'task', id: '42' } }],
    ['a scope on another filesystem', { scope: { type: 'fs', id: 'archive' } }],
    ['a scope on a directory of another filesystem', { scope: { type: 'dir', id: 'archive:public' } }],
    ['a scope without an id', { scope: { type: 'fs' } }],
  ];
  for (const [what, extra] of refused) {
    it(`refuses a policy with ${what}, naming the filesystem and the policy`, () => {
      expect(() => parseFsAccessConfig('uploads', policy(extra)))
        .to.throw(AuthzConfigError)
        .with.property('message')
        .that.includes('authz.fs.uploads.policies')
        .and.includes('"staff"');
    });
  }

  it('accepts an empty signedUrl', () => {
    expect(parseFsAccessConfig('uploads', { mode: 'enforce', signedUrl: {} }).signedUrl).to.deep.equal({});
  });

  const bad: [string, unknown, string][] = [
    ['an entry that is not an object', 'enforce', 'authz.fs.uploads'],
    ['an array entry', [], 'authz.fs.uploads'],
    ['a missing mode', { domain: 'fs' }, 'authz.fs.uploads.mode'],
    ['an unknown mode', { mode: 'strict' }, 'authz.fs.uploads.mode'],
    ['an unknown key', { mode: 'enforce', Mode: 'off' }, 'authz.fs.uploads.Mode'],
    ['an empty domain', { mode: 'enforce', domain: '' }, 'authz.fs.uploads.domain'],
    ['a non-string metadata', { mode: 'enforce', metadata: 1 }, 'authz.fs.uploads.metadata'],
    ['a non-boolean stampOwner', { mode: 'enforce', stampOwner: 'yes' }, 'authz.fs.uploads.stampOwner'],
    ['stampOwner without a metadata store', { mode: 'enforce', stampOwner: true }, 'authz.fs.uploads.stampOwner'],
    ['an empty resolver', { mode: 'enforce', resolver: '' }, 'authz.fs.uploads.resolver'],
    ['an inherit list', { mode: 'enforce', inherit: ['fs:read'] }, 'authz.fs.uploads.inherit'],
    ['an inherit key that is no permission', { mode: 'enforce', inherit: { read: 'read' } }, 'authz.fs.uploads.inherit.read'],
    ['an inherit action that is not a string', { mode: 'enforce', inherit: { 'fs:read': 1 } }, 'authz.fs.uploads.inherit.fs:read'],
    ['an inherit key that is no fs permission', { mode: 'enforce', inherit: { 'task:read': 'read' } }, 'authz.fs.uploads.inherit.task:read'],
    ['an inherit action that is no action name', { mode: 'enforce', inherit: { 'fs:read': 'task:read' } }, 'authz.fs.uploads.inherit.fs:read'],
    ['a signedUrl that is not an object', { mode: 'enforce', signedUrl: 900 }, 'authz.fs.uploads.signedUrl'],
    ['a zero maxTtlSeconds', { mode: 'enforce', signedUrl: { maxTtlSeconds: 0 } }, 'authz.fs.uploads.signedUrl.maxTtlSeconds'],
    ['an infinite maxTtlSeconds', { mode: 'enforce', signedUrl: { maxTtlSeconds: Infinity } }, 'authz.fs.uploads.signedUrl.maxTtlSeconds'],
    ['an unknown signedUrl key', { mode: 'enforce', signedUrl: { ttl: 5 } }, 'authz.fs.uploads.signedUrl.ttl'],
    ['a zero defaultTtlSeconds', { mode: 'enforce', signedUrl: { defaultTtlSeconds: 0 } }, 'authz.fs.uploads.signedUrl.defaultTtlSeconds'],
    ['an infinite defaultTtlSeconds', { mode: 'enforce', signedUrl: { defaultTtlSeconds: Infinity } }, 'authz.fs.uploads.signedUrl.defaultTtlSeconds'],
    ['a string defaultTtlSeconds', { mode: 'enforce', signedUrl: { defaultTtlSeconds: '900' } }, 'authz.fs.uploads.signedUrl.defaultTtlSeconds'],
    ['policies that are not a list', { mode: 'enforce', policies: {} }, 'authz.fs.uploads.policies'],
    ['a policy that is not an object', { mode: 'enforce', policies: ['x'] }, 'authz.fs.uploads.policies[0]'],
    ['operations that are a list', { mode: 'enforce', operations: ['fs:read'] }, 'authz.fs.uploads.operations'],
    ['an operation naming no permission', { mode: 'enforce', operations: { thumbnail: 'read' } }, 'authz.fs.uploads.operations.thumbnail'],
    ['an operation with an empty list', { mode: 'enforce', operations: { thumbnail: [] } }, 'authz.fs.uploads.operations.thumbnail'],
    ['an unknown list mode', { mode: 'enforce', list: 'all' }, 'authz.fs.uploads.list'],
  ];
  for (const [what, entry, key] of bad) {
    it(`refuses ${what}, naming ${key}`, () => {
      expect(() => parseFsAccessConfig('uploads', entry))
        .to.throw(AuthzConfigError)
        .with.property('message')
        .that.includes(key);
    });
  }

  it('freezes the result', () => {
    const cfg = parseFsAccessConfig('uploads', { mode: 'enforce', inherit: { 'fs:read': 'read' }, operations: { publish: ['fs:share'] } });
    expect(Object.isFrozen(cfg)).to.equal(true);
    expect(Object.isFrozen(cfg.inherit)).to.equal(true);
    expect(Object.isFrozen(cfg.operations)).to.equal(true);
    expect(Object.isFrozen(cfg.operations!.publish)).to.equal(true);
  });

  it('builds operations and inherit without a prototype, so no method name reads an inherited value', () => {
    const cfg = parseFsAccessConfig('uploads', { mode: 'enforce', inherit: { 'fs:read': 'read' }, operations: { publish: ['fs:share'] } });
    expect(Object.getPrototypeOf(cfg.operations)).to.equal(null);
    expect(Object.getPrototypeOf(cfg.inherit)).to.equal(null);
    expect((cfg.operations as Record<string, unknown>).toString).to.equal(undefined);
  });

  for (const key of ['__proto__', 'constructor', 'prototype']) {
    it(`refuses the operations key ${key}`, () => {
      const entry = { mode: 'enforce', operations: JSON.parse(`{ ${JSON.stringify(key)}: ["fs:read"] }`) as unknown };
      expect(() => parseFsAccessConfig('uploads', entry))
        .to.throw(AuthzConfigError)
        .with.property('message')
        .that.includes(`authz.fs.uploads.operations.${key}`);
    });
  }
});

describe('authz-fs config: fsAccessConfig', () => {
  let child: IContainer | undefined;

  afterEach(async () => {
    await child?.dispose();
    child = undefined;
  });

  it('reads authz.fs.<name> through the container Configuration', async () => {
    child = await configuredChild({ uploads: { mode: 'enforce', domain: 'fs' }, archive: { mode: 'audit' } });
    expect(fsAccessConfig('uploads', child)).to.deep.equal({ mode: 'enforce', domain: 'fs' });
    expect(fsAccessConfig('archive', child)).to.deep.equal({ mode: 'audit', domain: 'root' });
    expect(fsAccessConfig('plain', child)).to.deep.equal({ mode: 'off', domain: 'root' });
  });

  it('reads the configuration on every call', async () => {
    child = await configuredChild({ uploads: { mode: 'audit' } });
    expect(fsAccessConfig('uploads', child).mode).to.equal('audit');
    (child.get(Configuration) as Configuration).set(['authz', 'fs'], { uploads: { mode: 'enforce' } });
    expect(fsAccessConfig('uploads', child).mode).to.equal('enforce');
  });

  it('treats a missing authz.fs as no entries', async () => {
    child = await configuredChild(undefined);
    expect(fsAccessConfig('uploads', child)).to.deep.equal({ mode: 'off', domain: 'root' });
  });

  it('ignores inherited object members as fs names', async () => {
    child = await configuredChild({});
    for (const name of ['constructor', '__proto__', 'toString']) expect(fsAccessConfig(name, child).mode, name).to.equal('off');
  });

  it('refuses an authz.fs that is not an object', async () => {
    child = await configuredChild(['uploads']);
    expect(() => fsAccessConfig('uploads', child)).to.throw(AuthzConfigError, 'authz.fs');
  });

  it('refuses when no Configuration is resolved', () => {
    child = DI.child();
    expect(() => fsAccessConfig('uploads', child)).to.throw(AuthzConfigError, /Configuration/);
  });
});
