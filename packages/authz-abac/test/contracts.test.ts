import type { AuthzAdmin, AuthzAdminQuery, AuthzCommand, Condition, FieldSet, Principal, PrincipalType, ResourceRef, ResourceType } from '@spinajs/authz';
import * as chai from 'chai';
import 'mocha';

import { PolicyStore } from '../src/index.js';
import * as root from '../src/index.js';
import type { Policy } from '../src/index.js';

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
    expect(p.id).to.equal('p1');
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
    expect(true).to.equal(true);
  });
});

describe('authz-abac admin commands (declared in AuthzCommandMap)', () => {
  type DCommand = { readonly kind: 'policy.put'; readonly policy: Omit<Policy, 'source'> } | { readonly kind: 'policy.delete'; readonly id: string };
  type DQuery = { readonly kind: 'policies'; readonly scope?: ResourceRef; readonly page?: { limit: number; offset: number } };
  type Opts = { readonly reason?: string; readonly idempotencyKey?: string; readonly dryRun?: boolean };

  interface DPolicy {
    readonly id: string;
    readonly effect: 'permit' | 'deny';
    readonly permissions: readonly string[];
    readonly resourceTypes?: readonly ResourceType[];
    readonly principalTypes?: readonly PrincipalType[];
    readonly actorTypes?: readonly PrincipalType[];
    readonly scope?: ResourceRef;
    readonly when?: Condition;
    readonly fields?: FieldSet;
    readonly reason?: string;
    readonly priority?: number;
    readonly expiresAt?: Date | null;
    readonly source: string;
  }

  it('owns Policy and adds its commands and query', () => {
    yes<Equal<Policy, DPolicy>>();
    yes<Equal<Extract<AuthzCommand, { kind: `policy.${string}` }>, DCommand>>();
    yes<Equal<Extract<AuthzAdminQuery, { kind: 'policies' }>, DQuery>>();
    yes<Equal<Parameters<AuthzAdmin['putPolicy']>, [actor: Principal, policy: Omit<DPolicy, 'source'>, opts?: Opts]>>();
    const commands: AuthzCommand[] = [{ kind: 'policy.put', policy: { id: 'p', effect: 'permit', permissions: ['*:read'] } }, { kind: 'policy.delete', id: 'p' }];
    // @ts-expect-error source is set by the server
    const withSource: AuthzCommand = { kind: 'policy.put', policy: { id: 'p', effect: 'permit', permissions: [], source: 'db' } };
    expect([...commands, withSource]).to.have.length(3);
  });
});
