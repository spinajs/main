import type { AuthzCommand, Condition, DenyReason, FieldSet, Permission, PrincipalRef, PrincipalType, ResourceRef, ResourceType } from '@spinajs/authz';

// Structural copies of the authz-rbac and authz-abac data shapes and admin commands: the kit cannot depend
// on authz-rbac, which pulls in the ORM, so it cannot see their AuthzCommandMap augmentations either. The
// real types accept these as they are.

export type TestAssignmentSubject = PrincipalRef | { readonly set: { readonly role: string; readonly scope: ResourceRef } };

export interface TestAssignment {
  readonly id: string;
  readonly subject: TestAssignmentSubject;
  readonly role: string;
  readonly scope: ResourceRef;
  readonly tags?: readonly string[];
  readonly expiresAt?: Date | null;
  readonly grantedBy?: PrincipalRef;
  readonly source: string;
}

export interface TestSubjectSelector {
  readonly principalTypes?: readonly PrincipalType[];
  readonly actorTypes?: readonly PrincipalType[];
  readonly refs?: readonly PrincipalRef[];
  readonly rank?: { readonly ladder: string; readonly at: ResourceType; readonly lt?: string; readonly eq?: string; readonly gte?: string };
  readonly when?: Condition;
}

export interface TestRuleDef {
  readonly id: string;
  readonly kind: 'restrict' | 'cap' | 'threshold';
  readonly scope: ResourceRef;
  readonly resourceTypes?: readonly ResourceType[];
  readonly subjects?: TestSubjectSelector;
  readonly when?: Condition;
  readonly expiresAt?: Date | null;
  readonly source: string;
  readonly allow?: readonly TestAssignmentSubject[];
  readonly ladder?: string;
  readonly maxRole?: string | { readonly ref: string } | null;
  readonly stripTags?: boolean;
  readonly assignments?: { readonly scopeTypes?: readonly ResourceType[]; readonly subjectTypes?: readonly PrincipalType[] };
  readonly permissions?: readonly string[];
  readonly resource?: Condition;
  readonly minRole?: string | { readonly ref: string };
  readonly at?: ResourceType;
  readonly reason?: DenyReason & { readonly model?: never };
}

export interface TestLinkDef {
  readonly id: string;
  readonly scope: ResourceRef;
  readonly expiresAt?: Date | null;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly createdBy?: PrincipalRef;
}

export interface TestAbacPolicy {
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

type RoleSet = { readonly role: string; readonly scope: ResourceRef };
type Page = { limit: number; offset: number; after?: string };

/** The core's commands and the RBAC and ABAC ones, as AuthzCommand is with both models installed. */
export type TestAdminCommand =
  | AuthzCommand
  | { readonly kind: 'assignment.grant'; readonly subject: TestAssignmentSubject; readonly role: string; readonly scope: ResourceRef; readonly tags?: readonly string[]; readonly expiresAt?: Date | null; readonly replaceLadder?: boolean }
  | { readonly kind: 'assignment.revoke'; readonly id: string }
  | { readonly kind: 'assignment.revokeWhere'; readonly scope: ResourceRef; readonly subject?: TestAssignmentSubject; readonly role?: string }
  | { readonly kind: 'assignment.setTags' | 'assignment.addTags' | 'assignment.removeTags'; readonly id: string; readonly tags: readonly string[] }
  | { readonly kind: 'assignment.setExpiry'; readonly id: string; readonly expiresAt: Date | null }
  | { readonly kind: 'set.addMember'; readonly set: RoleSet; readonly member: PrincipalRef; readonly expiresAt?: Date | null }
  | { readonly kind: 'set.removeMember'; readonly set: RoleSet; readonly member: PrincipalRef }
  | { readonly kind: 'link.create'; readonly scope: ResourceRef; readonly role: string; readonly tags?: readonly string[]; readonly expiresAt?: Date | null; readonly attributes?: Readonly<Record<string, unknown>> }
  | { readonly kind: 'link.update'; readonly id: string; readonly expiresAt?: Date | null; readonly attributes?: Readonly<Record<string, unknown>>; readonly role?: string; readonly tags?: readonly string[] }
  | { readonly kind: 'link.revoke'; readonly id: string }
  | { readonly kind: 'rule.put'; readonly rule: Omit<TestRuleDef, 'source'> }
  | { readonly kind: 'rule.delete'; readonly id: string }
  | { readonly kind: 'policy.put'; readonly policy: Omit<TestAbacPolicy, 'source'> }
  | { readonly kind: 'policy.delete'; readonly id: string };

/** The result of one TestAdminCommand. */
export type TestAdminCommandResult = { readonly ok: true; readonly kind: TestAdminCommand['kind']; readonly id?: string; readonly token?: string; readonly affected: number } | { readonly ok: false; readonly kind: TestAdminCommand['kind']; readonly error: { readonly code: string; readonly message: string; readonly field?: string } };

/** The core's query and the RBAC and ABAC ones. */
export type TestAdminQuery =
  | { readonly kind: 'attributes'; readonly scope: ResourceRef }
  | { readonly kind: 'assignments'; readonly scope?: ResourceRef; readonly subject?: TestAssignmentSubject; readonly role?: string; readonly includeExpired?: boolean; readonly page?: Page }
  | { readonly kind: 'links' | 'rules' | 'policies'; readonly scope?: ResourceRef; readonly page?: Page }
  | { readonly kind: 'holders'; readonly scope: ResourceRef; readonly permission: Permission; readonly expandSets?: boolean; readonly page?: Page };
