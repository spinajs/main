import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';
import { bootConfiguration, violationPaths } from '@spinajs/authz-testing';
import { Configuration } from '@spinajs/configuration';
import type { IContainer } from '@spinajs/di';

import { AUTHZ_FS_ACL_CONFIGURATION_SCHEMA, FS_ACL_DEFAULT_RELATIONS, fsAclConfig } from '../src/index.js';
import type { FsAclConfig } from '../src/index.js';
import { configuredChild } from './helpers.js';

const expect = chai.expect;

const configurationOf = (c: IContainer): Configuration => c.get(Configuration) as Configuration;

describe('authz-fs config: fsAclConfig', () => {
  let child: IContainer | undefined;

  afterEach(async () => {
    await child?.dispose();
    child = undefined;
  });

  it('gives the defaults without an authz.fsAcl section', async () => {
    child = await configuredChild(undefined);
    expect(fsAclConfig(child)).to.deep.equal({ connection: 'default', relations: ['owner', 'editor', 'viewer'] });
    expect(FS_ACL_DEFAULT_RELATIONS).to.deep.equal(['owner', 'editor', 'viewer']);
  });

  it("reads connection and relations; 'owner' is always served, first and once", async () => {
    child = await configuredChild(undefined);
    configurationOf(child).set(['authz', 'fsAcl'], { connection: 'acl', relations: ['viewer', 'owner', 'reviewer', 'viewer'] });
    expect(fsAclConfig(child)).to.deep.equal({ connection: 'acl', relations: ['owner', 'viewer', 'reviewer'] });
  });

  it("puts 'owner' in front of a list without it", async () => {
    child = await configuredChild(undefined);
    configurationOf(child).set(['authz', 'fsAcl'], { relations: ['viewer'] });
    expect(fsAclConfig(child).relations).to.deep.equal(['owner', 'viewer']);
  });

  it('freezes the result', async () => {
    child = await configuredChild(undefined);
    const cfg = fsAclConfig(child);
    expect(Object.isFrozen(cfg)).to.equal(true);
    expect(Object.isFrozen(cfg.relations)).to.equal(true);
  });

  const BAD: [string, Record<string, unknown>, string][] = [
    ['an empty connection', { connection: '' }, 'authz.fsAcl.connection'],
    ['a connection that is not a string', { connection: 3 }, 'authz.fsAcl.connection'],
    ['relations that are not a list', { relations: 'owner' }, 'authz.fsAcl.relations'],
    ['an empty relation', { relations: [''] }, 'authz.fsAcl.relations'],
    ['a relation over 64 characters', { relations: ['x'.repeat(65)] }, 'authz.fsAcl.relations'],
    ['a relation that is not a string', { relations: [1] }, 'authz.fsAcl.relations'],
  ];
  for (const [what, section, key] of BAD) {
    it(`fails closed on ${what} that no schema checked, naming ${key}`, async () => {
      child = await configuredChild(undefined);
      configurationOf(child).set(['authz', 'fsAcl'], section);
      expect(() => fsAclConfig(child!)).to.throw(AuthzConfigError).with.property('message').that.includes(key);
    });
  }
});

describe('authz-fs config: the authz.fsAcl schema', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  async function boot(authz: Record<string, unknown>): Promise<Configuration> {
    const booted = await bootConfiguration({ authz }, [AUTHZ_FS_ACL_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    return booted.configuration;
  }

  it('defaults the connection and the relations', async () => {
    const configuration = await boot({});
    expect(configuration.get('authz.fsAcl.connection')).to.equal('default');
    expect(configuration.get('authz.fsAcl.relations')).to.deep.equal(['owner', 'editor', 'viewer']);
  });

  it('takes every documented key unchanged', async () => {
    const section = { connection: 'acl', relations: ['owner', 'reviewer'] };
    expect((await boot({ fsAcl: section })).get('authz.fsAcl')).to.deep.equal(section);
  });

  const BAD: [string, unknown, string][] = [
    ['an empty connection', { connection: '' }, 'authz.fsAcl.connection'],
    ['relations that are not a list', { relations: 'owner' }, 'authz.fsAcl.relations'],
    ['an empty relation', { relations: [''] }, 'authz.fsAcl.relations.0'],
    ['a relation over 64 characters', { relations: ['x'.repeat(65)] }, 'authz.fsAcl.relations.0'],
    ['a repeated relation', { relations: ['viewer', 'viewer'] }, 'authz.fsAcl.relations'],
    ['an unknown key', { relation: ['viewer'] }, 'authz.fsAcl.relation'],
  ];
  for (const [what, section, path] of BAD) {
    it(`refuses ${what} at boot, naming ${path}`, async () => {
      expect(await violationPaths(boot({ fsAcl: section }))).to.include(path);
    });
  }
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const yes = <_T extends true>(): void => {};

describe('authz-fs pinned shapes: FsAclConfig', () => {
  it('matches C3', () => {
    yes<Equal<FsAclConfig, { readonly connection: string; readonly relations: readonly string[] }>>();
    expect(true).to.equal(true);
  });
});
