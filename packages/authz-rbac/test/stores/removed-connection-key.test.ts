import * as chai from 'chai';
import 'mocha';
import { AuthzConfigError, checkRemovedConnectionKeys } from '@spinajs/authz';
import { bootConfiguration } from '@spinajs/authz-testing';
import type { IContainer } from '@spinajs/di';

import { AUTHZ_RBAC_CONFIGURATION_SCHEMA } from '../../src/index.js';

const expect = chai.expect;

describe('authz.rbac.connection under the authz-rbac schema', () => {
  const children: IContainer[] = [];

  afterEach(async () => {
    for (const c of children.splice(0)) await c.dispose();
  });

  it('survives validation, so the authz boot refuses it by name', async () => {
    const { child, configuration } = await bootConfiguration({ authz: { rbac: { connection: 'main' } } }, [AUTHZ_RBAC_CONFIGURATION_SCHEMA]);
    children.push(child);

    expect(configuration.get('authz.rbac.connection')).to.equal('main');
    expect(() => checkRemovedConnectionKeys(configuration.get('authz'))).to.throw(AuthzConfigError, /^authz\.rbac\.connection: removed;/);
  });
});
