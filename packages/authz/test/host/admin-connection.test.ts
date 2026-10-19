import 'mocha';
import { expect } from 'chai';
import { AUTHZ_CONFIGURATION_SCHEMA, AUTHZ_CONNECTION, AuthzConfigError, checkRemovedConnectionKeys } from '@spinajs/authz';
import { bootConfiguration } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';

describe('the authz connection alias', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  it('is the ORM alias authz', () => {
    expect(AUTHZ_CONNECTION).to.equal('authz');
  });

  it('gives authz.admin.connection no default: the core schema has no such key', async () => {
    const booted = await bootConfiguration({ authz: { admin: { maxBatch: 5 } } }, [AUTHZ_CONFIGURATION_SCHEMA]);
    children.push(booted.child);
    expect(booted.configuration.get('authz.admin.connection')).to.equal(undefined);
  });

  it('refuses authz.admin.connection and authz.rbac.connection, naming db.Aliases.authz', () => {
    const cases: [unknown, string][] = [
      [{ admin: { connection: 'main' } }, 'authz.admin.connection'],
      [{ rbac: { connection: 'main' } }, 'authz.rbac.connection'],
      [{ admin: { connection: 'a' }, rbac: { connection: 'b' } }, 'authz.admin.connection, authz.rbac.connection'],
    ];
    for (const [authz, keys] of cases) {
      expect(() => checkRemovedConnectionKeys(authz), keys).to.throw(AuthzConfigError, `${keys}: removed; the authz tables use the ORM connection alias "authz", so set db.Aliases.authz to the connection name instead (default: "default")`);
    }
  });

  it('accepts a configuration without them', () => {
    for (const authz of [undefined, null, {}, { admin: { maxBatch: 5 } }, { rbac: {} }]) expect(() => checkRemovedConnectionKeys(authz)).to.not.throw();
  });
});
