import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';
import { bootConfiguration, violationPaths } from '@spinajs/authz-testing';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { AUTHZ_FS_CONFIGURATION_SCHEMA, fsAccessConfig, parseFsAccessConfig } from '../src/index.js';
import { configuredChild } from './helpers.js';

const expect = chai.expect;

describe('authz-fs config: parseFsAccessConfig', () => {
  it('reads a missing entry as mode off in the root domain', () => {
    expect(parseFsAccessConfig('plain', undefined)).to.deep.equal({ mode: 'off', domain: 'root' });
  });

  it('defaults the domain to root', () => {
    expect(parseFsAccessConfig('uploads', { mode: 'enforce' })).to.deep.equal({ mode: 'enforce', domain: 'root' });
    expect(parseFsAccessConfig('archive', { mode: 'audit' })).to.deep.equal({ mode: 'audit', domain: 'root' });
    expect(parseFsAccessConfig('scratch', { mode: 'off' })).to.deep.equal({ mode: 'off', domain: 'root' });
  });

  it('keeps every documented key', () => {
    const entry = { mode: 'enforce', domain: 'fs', stampOwner: true, signedUrl: { maxTtlSeconds: 900, defaultTtlSeconds: 300 }, list: 'each' };
    expect(parseFsAccessConfig('uploads', entry)).to.deep.equal(entry);
  });

  it('accepts an empty signedUrl', () => {
    expect(parseFsAccessConfig('uploads', { mode: 'enforce', signedUrl: {} }).signedUrl).to.deep.equal({});
  });

  // A dropped deny policy or operation mapping would open files: a removed key fails closed instead of being ignored.
  for (const key of ['metadata', 'resolver', 'inherit', 'policies', 'operations']) {
    it(`refuses the removed key ${key}, naming it`, () => {
      expect(() => parseFsAccessConfig('uploads', { mode: 'enforce', [key]: 'x' }))
        .to.throw(AuthzConfigError)
        .with.property('message')
        .that.includes(`authz.fs.uploads.${key}`);
    });
  }

  // Floors for an entry no schema checked (a Configuration.set, an unvalidated test configuration).
  const unchecked: [string, unknown, string][] = [
    ['an entry that is not an object', 'enforce', 'authz.fs.uploads.mode'],
    ['a null entry', null, 'authz.fs.uploads.mode'],
    ['a missing mode', { domain: 'fs' }, 'authz.fs.uploads.mode'],
    ['an unknown mode', { mode: 'strict' }, 'authz.fs.uploads.mode'],
    ['an empty domain', { mode: 'enforce', domain: '' }, 'authz.fs.uploads.domain'],
    ['a non-boolean stampOwner', { mode: 'enforce', stampOwner: 'yes' }, 'authz.fs.uploads.stampOwner'],
    ['an infinite defaultTtlSeconds', { mode: 'enforce', signedUrl: { defaultTtlSeconds: Infinity } }, 'authz.fs.uploads.signedUrl.defaultTtlSeconds'],
    ['a NaN maxTtlSeconds', { mode: 'enforce', signedUrl: { maxTtlSeconds: NaN } }, 'authz.fs.uploads.signedUrl.maxTtlSeconds'],
    ['a zero maxTtlSeconds', { mode: 'enforce', signedUrl: { maxTtlSeconds: 0 } }, 'authz.fs.uploads.signedUrl.maxTtlSeconds'],
    ['a signedUrl that is not an object', { mode: 'enforce', signedUrl: 900 }, 'authz.fs.uploads.signedUrl'],
    ['an unknown signedUrl key', { mode: 'enforce', signedUrl: { maxTtl: 5 } }, 'authz.fs.uploads.signedUrl.maxTtl'],
    ['an unknown list mode', { mode: 'enforce', list: 'all' }, 'authz.fs.uploads.list'],
  ];
  for (const [what, entry, key] of unchecked) {
    it(`fails closed on ${what} that no schema checked, naming ${key}`, () => {
      expect(() => parseFsAccessConfig('uploads', entry))
        .to.throw(AuthzConfigError)
        .with.property('message')
        .that.includes(key);
    });
  }

  it('freezes the result', () => {
    const cfg = parseFsAccessConfig('uploads', { mode: 'enforce', signedUrl: { maxTtlSeconds: 60 } });
    expect(Object.isFrozen(cfg)).to.equal(true);
    expect(Object.isFrozen(cfg.signedUrl)).to.equal(true);
  });
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

describe('authz-fs config: the authz.fs schema', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(authz: Record<string, unknown>): Promise<Configuration> {
    const booted = await bootConfiguration({ authz }, [AUTHZ_FS_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    return booted.configuration;
  }

  const refused = (entry: unknown) => violationPaths(boot({ fs: { uploads: entry } }));

  const ENTRY = { mode: 'enforce', domain: 'fs', stampOwner: true, signedUrl: { maxTtlSeconds: 900, defaultTtlSeconds: 300 }, list: 'each' };

  it('takes every documented key unchanged', async () => {
    expect((await boot({ fs: { uploads: ENTRY } })).get('authz.fs.uploads')).to.deep.equal(ENTRY);
  });

  it('an unset authz.fs has no entries', async () => {
    expect((await boot({})).get('authz.fs')).to.deep.equal({});
  });

  it('refuses an authz.fs that is not an object', async () => {
    expect(await violationPaths(boot({ fs: ['uploads'] }))).to.include('authz.fs');
  });

  const BAD: [string, unknown, string][] = [
    ['an entry that is not an object', 'enforce', 'authz.fs.uploads'],
    ['an array entry', [], 'authz.fs.uploads'],
    ['a missing mode', { domain: 'fs' }, 'authz.fs.uploads.mode'],
    ['an unknown mode', { mode: 'strict' }, 'authz.fs.uploads.mode'],
    ['an unknown key', { mode: 'enforce', Mode: 'off' }, 'authz.fs.uploads.Mode'],
    ['the removed key metadata', { mode: 'enforce', metadata: 'OrmFileMetadataStore' }, 'authz.fs.uploads.metadata'],
    ['the removed key inherit', { mode: 'enforce', inherit: { 'fs:read': 'read' } }, 'authz.fs.uploads.inherit'],
    ['the removed key policies', { mode: 'enforce', policies: [] }, 'authz.fs.uploads.policies'],
    ['the removed key operations', { mode: 'enforce', operations: {} }, 'authz.fs.uploads.operations'],
    ['the removed key resolver', { mode: 'enforce', resolver: 'R' }, 'authz.fs.uploads.resolver'],
    ['an empty domain', { mode: 'enforce', domain: '' }, 'authz.fs.uploads.domain'],
    ['a non-boolean stampOwner', { mode: 'enforce', stampOwner: 'yes' }, 'authz.fs.uploads.stampOwner'],
    ['a signedUrl that is not an object', { mode: 'enforce', signedUrl: 900 }, 'authz.fs.uploads.signedUrl'],
    ['a zero maxTtlSeconds', { mode: 'enforce', signedUrl: { maxTtlSeconds: 0 } }, 'authz.fs.uploads.signedUrl.maxTtlSeconds'],
    ['an infinite maxTtlSeconds', { mode: 'enforce', signedUrl: { maxTtlSeconds: Infinity } }, 'authz.fs.uploads.signedUrl.maxTtlSeconds'],
    ['a zero defaultTtlSeconds', { mode: 'enforce', signedUrl: { defaultTtlSeconds: 0 } }, 'authz.fs.uploads.signedUrl.defaultTtlSeconds'],
    ['an unknown signedUrl key', { mode: 'enforce', signedUrl: { ttl: 5 } }, 'authz.fs.uploads.signedUrl.ttl'],
    ['an unknown list mode', { mode: 'enforce', list: 'all' }, 'authz.fs.uploads.list'],
  ];
  for (const [what, entry, path] of BAD) {
    it(`refuses ${what} at boot, naming ${path}`, async () => {
      expect(await refused(entry)).to.include(path);
    });
  }
});
