import type * as core from '@spinajs/authz';
import * as chai from 'chai';
import 'mocha';

import { PolicyStore } from '../src/index.js';
import * as root from '../src/index.js';
import type { Policy } from '../src/index.js';
import type { Policy as CorePolicy } from '@spinajs/authz';

const expect = chai.expect;

describe('authz-abac contracts', () => {
  it('Policy literal with every optional member', () => {
    const p: Policy = {
      id: 'p1',
      effect: 'deny',
      permissions: ['file:*'],
      resourceTypes: ['file'],
      principalTypes: ['user'],
      actorTypes: ['agent'],
      scope: { type: 'org', id: 'o1' },
      when: undefined,
      fields: undefined,
      reason: 'because',
      priority: 100,
      expiresAt: null,
      source: 'config',
    };
    const core: CorePolicy = p;
    expect(core.id).to.equal('p1');
  });

  it('effect rejects values other than permit and deny', () => {
    // @ts-expect-error 'allow' is not an effect
    const p: Policy = { id: 'p', effect: 'allow', permissions: [], source: 'config' };
    expect(p.id).to.equal('p');
  });

  it('PolicyStore is a runtime export and can be faked', async () => {
    expect((root as any).PolicyStore).to.be.a('function');
    class S extends PolicyStore {
      readonly name = 's';
      async load() {
        return [] as readonly Policy[];
      }
      async version() {
        return '1';
      }
    }
    expect(await new S().load()).to.have.length(0);
  });
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Shape<C> = Pick<C, keyof C>;
const yes = <_T extends true>(): void => {};

describe('authz-abac pinned shapes', () => {
  it('match the design exactly', () => {
    yes<Equal<Shape<PolicyStore>, { readonly name: string; load(): Promise<readonly Policy[]>; version(): Promise<string> }>>();
    yes<Equal<Policy, core.Policy>>();
    expect(true).to.equal(true);
  });
});
