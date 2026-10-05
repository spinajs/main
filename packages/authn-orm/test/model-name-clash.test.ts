import { AuthnAudit, AuthnThrottle } from '@spinajs/authn';
import { AuthnNonce as KeysNonce } from '@spinajs/authn-keys';
import { DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';

import * as orm from '../src/index.js';

const models = () => DI.getRegisteredTypes<unknown>('__models__') as Array<{ name: string }>;

// DI keys classes by name and drops a second class of the same name, so a clashing model never
// reaches the ORM model list and queries find the other class under that name.
describe('ORM model names with authn-keys loaded in the same process', () => {
  it('keeps the authn-keys and the authn-orm nonce model, one table, apart in the model list', () => {
    const own = (orm as unknown as Record<string, { name: string }>).AuthnNonceModel;
    expect(own, 'authn-orm exports AuthnNonceModel').to.not.eq(undefined);
    expect(models()).to.include.members([KeysNonce, own]);
  });

  it('gives every registered model a name of its own', () => {
    const names = models().map((m) => m.name);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).to.deep.eq([]);
  });

  it('never lists a service class of authn among the models', () => {
    expect(models()).to.not.include.members([AuthnAudit as unknown as { name: string }]);
    expect(models()).to.not.include.members([AuthnThrottle as unknown as { name: string }]);
  });
});
