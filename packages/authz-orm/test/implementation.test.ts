import * as chai from 'chai';
import 'mocha';

import * as api from '../src/api.js';
import * as root from '../src/index.js';
import * as schema from '../src/schema.js';
import * as scopeAttributes from '../src/scope-attributes/index.js';

const expect = chai.expect;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const yes = <_T extends true>(): void => {};

describe('authz-orm exports', () => {
  it('the package root exports implementations typed exactly as the frozen api.ts', () => {
    yes<Equal<typeof root.AccessResource, typeof api.AccessResource>>();
    yes<Equal<typeof root.Owner, typeof api.Owner>>();
    yes<Equal<typeof root.ScopeColumn, typeof api.ScopeColumn>>();
    yes<Equal<typeof root.OrmScope, typeof api.OrmScope>>();
    yes<Equal<typeof root.registerAccessResource, typeof api.registerAccessResource>>();
    yes<Equal<typeof root.filterFields, typeof api.filterFields>>();
    yes<Equal<typeof root.ownsBy, typeof api.ownsBy>>();

    for (const name of ['AccessResource', 'Owner', 'ScopeColumn', 'OrmScope', 'registerAccessResource', 'filterFields', 'ownsBy'] as const) {
      expect(root[name], name).to.be.a('function');
      expect(root[name], name).to.not.equal(api[name]);
    }
    expect(root.OrmScopePolicy).to.equal(api.OrmScopePolicy);
    expect(root.OrmNativeCompiler).to.equal(api.OrmNativeCompiler);
  });

  it('exports nothing beyond the contract, the scope attribute store and the schema', () => {
    expect(Object.keys(root).sort()).to.deep.equal([...new Set([...Object.keys(api), ...Object.keys(scopeAttributes), ...Object.keys(schema)])].sort());
  });
});
