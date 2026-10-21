import type { AuthzTx, Condition, DenyReason, FieldSet, Principal, PrincipalRef, PrincipalType, ResourceRef, ResourceType } from '@spinajs/authz';

// The RBAC admin commands; importing them adds them to AuthzCommand and AuthzAdminQuery.
export type { AssignmentGrantCommand, AssignmentRevokeCommand, AssignmentRevokeWhereCommand, AssignmentTagsCommand, AssignmentSetExpiryCommand, SetAddMemberCommand, SetRemoveMemberCommand, LinkCreateCommand, LinkUpdateCommand, LinkRevokeCommand, RulePutCommand, RuleDeleteCommand, RoleSetRef, AssignmentsAdminQuery, LinksAdminQuery, RulesAdminQuery, HoldersAdminQuery } from './admin/commands.js';

/** Subject of an assignment: a principal, or the set of holders of `role` at `scope` (one level; never nested). */
export type AssignmentSubject = PrincipalRef | { readonly set: { readonly role: string; readonly scope: ResourceRef } };

export interface Assignment {
  readonly id: string;
  readonly subject: AssignmentSubject;
  readonly role: string;
  readonly scope: ResourceRef;
  readonly tags?: readonly string[]; // add-ons
  readonly expiresAt?: Date | null;
  readonly grantedBy?: PrincipalRef;
  readonly source: string;
}

/** Which principals a rule applies to; all fields AND. */
export interface SubjectSelector {
  readonly principalTypes?: readonly PrincipalType[]; // the principal or a companion has one of these types
  readonly actorTypes?: readonly PrincipalType[];
  readonly refs?: readonly PrincipalRef[];
  readonly rank?: { readonly ladder: string; readonly at: ResourceType; readonly lt?: string; readonly eq?: string; readonly gte?: string }; // effective rank at the nearest ancestor of type `at`; no role = below every role
  readonly when?: Condition;
}

/** RBAC rules (D15). */
export interface RuleDef {
  readonly id: string;
  readonly kind: 'restrict' | 'cap' | 'threshold';
  readonly scope: ResourceRef; // applies at this node and below; GLOBAL for config rules
  readonly resourceTypes?: readonly ResourceType[]; // only requests on these types (branch rules: ['branch'])
  readonly subjects?: SubjectSelector;
  readonly when?: Condition; // principal.*, actor.*, env.*, scope.*, resource.* refs
  readonly expiresAt?: Date | null;
  readonly source: string;
  // restrict: assignments made strictly above `scope` are dropped unless their subject matches `allow`
  readonly allow?: readonly AssignmentSubject[];
  // cap: clamp rank and/or strip tags of matching assignments
  readonly ladder?: string;
  readonly maxRole?: string | { readonly ref: string } | null; // null drops the assignment
  readonly stripTags?: boolean;
  readonly assignments?: { readonly scopeTypes?: readonly ResourceType[]; readonly subjectTypes?: readonly PrincipalType[] };
  // threshold: matching permissions need rank >= minRole (deciding rank of the permission, or `ladder` at `at`)
  readonly permissions?: readonly string[];
  readonly resource?: Condition; // e.g. { attr: 'resource.name', wildcard: 'release/*' }
  readonly minRole?: string | { readonly ref: string };
  readonly at?: ResourceType;
  readonly reason?: DenyReason & { readonly model?: never }; // code, payload, priority, sortKey
}

/** Share link: bearer secret + scope + expiry; its grant is an assignment to link:<id>. */
export interface LinkDef {
  readonly id: string;
  readonly scope: ResourceRef;
  readonly expiresAt?: Date | null;
  readonly attributes: Readonly<Record<string, unknown>>; // e.g. { org_only: true }
  readonly createdBy?: PrincipalRef;
}

export interface GrantDef {
  readonly permission: string;
  readonly relation?: string | readonly string[];
  readonly on?: readonly ResourcePattern[];
  readonly fields?: FieldSet;
  readonly requiresTag?: string; // the principal's live tag set must hold it, else tag_missing{tag}
  readonly grantedAt?: readonly ResourceType[]; // only assignments made at these scope types count, else provenance
}

export interface ResourcePattern {
  readonly type: ResourceType;
  readonly id?: string; // glob with {principal.*} templates
}

// ranked roles, weakest first; rank = index
export interface LadderDef {
  readonly name: string;
  readonly roles: readonly string[];
  readonly resourceTypes?: readonly ResourceType[]; // where the ladder's grants apply; default all
}

// holding this role also gives `role`
export interface ImpliedRole {
  readonly role: string;
  readonly at: 'self-and-descendants' | 'descendants';
  readonly tags?: readonly string[];
  readonly bypass?: readonly ('restrict' | 'cap')[]; // never the ceiling
}

export interface RoleDef {
  readonly name: string; // no namespace: role definitions are global
  readonly ladder?: string; // member of this ladder; holds the grants of every lower ladder role
  readonly extends: readonly string[];
  readonly grants: readonly GrantDef[];
  readonly implies?: readonly ImpliedRole[];
  readonly subjectSet?: boolean; // holders form a subject set others can be assigned to
  readonly deny?: boolean; // subtracts its grants on its scope and below; wins over every permit (role_denied)
  readonly assignable: boolean;
  readonly scopeTypes?: readonly ResourceType[];
  readonly description?: string;
  readonly source: string;
}

export abstract class RoleStore {
  abstract readonly name: string;
  abstract load(): Promise<{ roles: readonly RoleDef[]; ladders: readonly LadderDef[] }>;
  abstract version(): Promise<string>;
}

export abstract class RuleStore {
  abstract readonly name: string;
  abstract forPath(path: readonly ResourceRef[], at: Date): Promise<readonly RuleDef[]>;
  abstract version(): Promise<string>;
}

export abstract class AssignmentStore {
  abstract readonly name: string;
  abstract forSubjects(subjects: readonly AssignmentSubject[], at: Date): Promise<readonly Assignment[]>;
  abstract holders(role: string, scope: ResourceRef, at: Date): Promise<readonly AssignmentSubject[]>; // AdminGuard last-holder
  /** Expired rows too. AdminGuard and the RBAC write handlers resolve id-only commands (assignment.revoke, tags, expiry) with it. */
  abstract byId(id: string): Promise<Assignment | null>;
  // The write methods below are called only by the RBAC write handlers of AuthzAdmin, inside its transaction.
  assign?(a: Omit<Assignment, 'id' | 'source'>, actor: PrincipalRef, tx: AuthzTx): Promise<Assignment>;
  revoke?(id: string, actor: PrincipalRef, tx: AuthzTx): Promise<void>;
}

export abstract class LinkStore {
  abstract byToken(token: string): Promise<LinkDef | null>; // compares hashes in constant time
  abstract byId(id: string): Promise<LinkDef | null>;
  create?(l: Omit<LinkDef, 'id'>, grant: { role: string; tags?: readonly string[] }, actor: PrincipalRef, tx: AuthzTx): Promise<{ link: LinkDef; token: string }>; // via AuthzAdmin only
  revoke?(id: string, actor: PrincipalRef, tx: AuthzTx): Promise<void>;
}

// default: principal + companions + subject sets
export abstract class SubjectResolver {
  abstract subjects(p: Principal): Promise<readonly AssignmentSubject[]> | readonly AssignmentSubject[];
}

/** Port: the transitive closure of subject sets. */
export abstract class MembershipStore {
  /** Sets every given member key belongs to, live at `at`, each with its membership expiry (none = never). */
  abstract setsOf(memberKeys: readonly string[], at: Date): Promise<readonly { readonly setKey: string; readonly expiresAt?: Date }[]>;
  /** Member keys (principal keys and set keys) of a set, live at `at`. */
  abstract membersOf(setKey: string, at: Date): Promise<readonly string[]>;
}

/** Subject key: `type:id` (principal) or `type:id#role` (set); wildcard `type:*`. In `id`, `%`, `#` and `*` are escaped as `%25`, `%23`, `%2A`, so keys never collide. Max 200 characters; longer keys are refused on write. */
export type SubjectKey = string;
