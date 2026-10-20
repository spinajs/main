import type { AuthzChange } from '@spinajs/authz';
import { ChangeAudience } from '@spinajs/authz';
import type { IContainer } from '@spinajs/di';
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';

import { MembershipStore, RbacChangeAudience } from '../../src/index.js';

const expect = chai.expect;

class Members extends MembershipStore {
  constructor(private readonly members: Readonly<Record<string, readonly string[]>>) {
    super();
  }
  async setsOf(): Promise<readonly { readonly setKey: string; readonly expiresAt?: Date }[]> {
    return [];
  }
  async membersOf(setKey: string): Promise<readonly string[]> {
    return this.members[setKey] ?? [];
  }
}

const container = (store?: MembershipStore): IContainer => ({ hasRegistered: () => store !== undefined, resolve: async () => store } as unknown as IContainer);
const change = (...tags: string[]): AuthzChange => ({ tags, at: new Date('2026-10-14T12:00:00.000Z') });

describe('authz-rbac RbacChangeAudience (design §10.4)', () => {
  const store = new Members({ 'team:t1#member': ['user:alice', 'team:t2#member', 'user:bob'], 'team:all#member': ['user:*'] });
  const audience = new RbacChangeAudience(container(store));

  it('is registered as a ChangeAudience', async () => {
    expect(((await DI.resolve(Array.ofType(ChangeAudience))) as ChangeAudience[]).some((a) => a instanceof RbacChangeAudience)).to.equal(true);
  });

  it('narrows subject and link tags to their principals, without objects', async () => {
    expect(await audience.audience(change('subject:user:bob', 'subject:user:alice', 'link:l1', 'subject:link:l1'))).to.deep.equal({ principals: ['link:l1', 'user:alice', 'user:bob'] });
  });

  it('a set subject goes to its principal members', async () => {
    expect(await audience.audience(change('subject:team:t1#member'))).to.deep.equal({ principals: ['user:alice', 'user:bob'] });
  });

  it('re-keys escaped set members to the raw principal keys rooms use', async () => {
    const escaped = new RbacChangeAudience(container(new Members({ 'team:t1#member': ['user:a%23b', 'user:50%25', 'user:x%2Ay', 'team:t2#member'] })));
    expect(await escaped.audience(change('subject:team:t1#member'))).to.deep.equal({ principals: ['user:50%', 'user:a#b', 'user:x*y'] });
  });

  it('wildcards, roles, rules, policies and scopes go to everyone', async () => {
    for (const tag of ['subject:user:*', 'subject:team:all#member', 'role:viewer', 'rule:r1', 'policy:p1', 'scope:project:p1', 'model:rbac']) {
      expect(await audience.audience(change('subject:user:alice', tag)), tag).to.deep.equal({ principals: '*' });
    }
  });

  it('without a MembershipStore a set subject goes to everyone; no tags concern nobody', async () => {
    expect(await new RbacChangeAudience(container()).audience(change('subject:team:t1#member'))).to.deep.equal({ principals: '*' });
    expect(await audience.audience(change())).to.deep.equal({ principals: [], objects: [] });
  });
});
