import type { Permission, PrincipalRef, ResourceRef } from '@spinajs/authz';

// The core admin tests drive AuthzAdmin with fake handlers for the RBAC and ABAC command kinds. The core
// cannot import authz-rbac or authz-abac, so this declares structural copies of their commands for the tests.
type Subject = PrincipalRef | { readonly set: { readonly role: string; readonly scope: ResourceRef } };
type RoleSet = { readonly role: string; readonly scope: ResourceRef };
type Page = { limit: number; offset: number };
type TagsCommand = { readonly kind: 'assignment.setTags' | 'assignment.addTags' | 'assignment.removeTags'; readonly id: string; readonly tags: readonly string[] };
type ListQuery = { readonly kind: 'links' | 'rules' | 'policies'; readonly scope?: ResourceRef; readonly page?: Page };

export interface TestRule {
  readonly id: string;
  readonly kind: 'restrict' | 'cap' | 'threshold';
  readonly scope: ResourceRef;
  readonly [field: string]: unknown;
}

export interface TestPolicy {
  readonly id: string;
  readonly effect: 'permit' | 'deny';
  readonly permissions: readonly string[];
  readonly [field: string]: unknown;
}

declare module '@spinajs/authz' {
  interface AuthzCommandMap {
    'assignment.grant': { readonly kind: 'assignment.grant'; readonly subject: Subject; readonly role: string; readonly scope: ResourceRef; readonly tags?: readonly string[]; readonly expiresAt?: Date | null; readonly replaceLadder?: boolean };
    'assignment.revoke': { readonly kind: 'assignment.revoke'; readonly id: string };
    'assignment.revokeWhere': { readonly kind: 'assignment.revokeWhere'; readonly scope: ResourceRef; readonly subject?: Subject; readonly role?: string };
    'assignment.setTags': TagsCommand;
    'assignment.addTags': TagsCommand;
    'assignment.removeTags': TagsCommand;
    'assignment.setExpiry': { readonly kind: 'assignment.setExpiry'; readonly id: string; readonly expiresAt: Date | null };
    'set.addMember': { readonly kind: 'set.addMember'; readonly set: RoleSet; readonly member: PrincipalRef; readonly expiresAt?: Date | null };
    'set.removeMember': { readonly kind: 'set.removeMember'; readonly set: RoleSet; readonly member: PrincipalRef };
    'link.create': { readonly kind: 'link.create'; readonly scope: ResourceRef; readonly role: string; readonly tags?: readonly string[]; readonly expiresAt?: Date | null; readonly attributes?: Readonly<Record<string, unknown>> };
    'link.update': { readonly kind: 'link.update'; readonly id: string; readonly expiresAt?: Date | null; readonly attributes?: Readonly<Record<string, unknown>>; readonly role?: string; readonly tags?: readonly string[] };
    'link.revoke': { readonly kind: 'link.revoke'; readonly id: string };
    'rule.put': { readonly kind: 'rule.put'; readonly rule: TestRule };
    'rule.delete': { readonly kind: 'rule.delete'; readonly id: string };
    'policy.put': { readonly kind: 'policy.put'; readonly policy: TestPolicy };
    'policy.delete': { readonly kind: 'policy.delete'; readonly id: string };
  }

  interface AuthzCommandRowMap {
    'assignment.grant': { readonly id: string; readonly subject: Subject; readonly role: string; readonly scope: ResourceRef; readonly source: string };
    'link.create': { readonly id: string; readonly scope: ResourceRef; readonly attributes: Readonly<Record<string, unknown>>; readonly createdBy?: PrincipalRef };
  }

  interface AuthzAdminQueryMap {
    assignments: { readonly kind: 'assignments'; readonly scope?: ResourceRef; readonly subject?: Subject; readonly role?: string; readonly includeExpired?: boolean; readonly page?: Page };
    links: ListQuery;
    rules: ListQuery;
    policies: ListQuery;
    holders: { readonly kind: 'holders'; readonly scope: ResourceRef; readonly permission: Permission; readonly expandSets?: boolean; readonly page?: Page };
  }
}
