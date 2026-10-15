import { ChangeAudience, principalKey } from '@spinajs/authz';
import type { AuthzChange, ResourceRef } from '@spinajs/authz';
import { Container, Inject, Injectable, Singleton } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { MembershipStore } from '../contracts.js';
import { parsePrincipalSubjectKey, parseSetKey } from '../model/sets/keys.js';

type Answer = { readonly principals: readonly string[] | '*'; readonly objects?: readonly ResourceRef[] };

const EVERYONE: Answer = Object.freeze({ principals: '*' });
const NOBODY: Answer = Object.freeze({ principals: Object.freeze([]), objects: Object.freeze([]) });

const isWildcardKey = (key: string): boolean => key.endsWith(':*') && parseSetKey(key) === undefined;

/**
 * Who an RBAC change reaches (design §10.4, lane L8 decision 10). No `objects`: whether a changed scope has
 * descendants is in authz-orm's ancestor table, which this package does not read, so clients refetch.
 */
@Singleton()
@Injectable(ChangeAudience)
@Inject(Container)
export class RbacChangeAudience extends ChangeAudience {
  constructor(private readonly container: IContainer) {
    super();
  }

  async audience(change: AuthzChange): Promise<Answer> {
    if (change.tags.length === 0) return NOBODY;
    const out = new Set<string>();
    for (const tag of change.tags) {
      const keys = await this.principalsOf(tag, change.at);
      if (keys === '*') return EVERYONE;
      for (const k of keys) out.add(k);
    }
    return Object.freeze({ principals: Object.freeze([...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) });
  }

  private async principalsOf(tag: string, at: Date): Promise<readonly string[] | '*'> {
    if (tag.startsWith('link:')) return [`link:${tag.slice('link:'.length)}`];
    if (!tag.startsWith('subject:')) return '*';
    const key = tag.slice('subject:'.length);
    if (parseSetKey(key)) return this.members(key, at);
    return isWildcardKey(key) ? '*' : [key];
  }

  private async members(setKey: string, at: Date): Promise<readonly string[] | '*'> {
    if (!this.container.hasRegistered(MembershipStore)) return '*';
    const store = (await this.container.resolve(MembershipStore)) as MembershipStore;
    const members = await store.membersOf(setKey, at);
    if (members.some(isWildcardKey)) return '*';
    // Members are escaped subjectKeyOf keys; rooms and SSE streams are keyed by the raw principalKey.
    return members.flatMap((k) => {
      const p = parsePrincipalSubjectKey(k);
      return p ? [principalKey(p)] : [];
    });
  }
}
