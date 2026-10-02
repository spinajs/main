import type { Assignment, AssignmentSubject, AuthzTx, FieldSet, LinkDef, Principal, PrincipalRef, ResourceRef, ResourceType, RuleDef } from '@spinajs/authz';

// Declared in the core because AuthzCommand carries them.
export type { AssignmentSubject, Assignment, SubjectSelector, RuleDef, LinkDef } from '@spinajs/authz';

export interface GrantDef {
  readonly permission: string;
  readonly relation?: string | readonly string[];
  readonly on?: readonly ResourcePattern[];
  readonly fields?: FieldSet;
  readonly requiresTag?: string; // the principal's live tag set must hold it, else tag_missing{tag}
  readonly grantedAt?: readonly ResourceType[]; // only assignments made at these scope types count, else provenance
}

// glob with {principal.*} templates
export interface ResourcePattern {
  readonly type: ResourceType;
  readonly id?: string;
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
  readonly bypass?: readonly ('restrict' | 'cap')[]; // never the ceiling (D19)
}

export interface RoleDef {
  readonly name: string; // no namespace: role definitions are global in 3.0
  readonly ladder?: string; // member of this ladder; holds the grants of every lower ladder role
  readonly extends: readonly string[];
  readonly grants: readonly GrantDef[];
  readonly implies?: readonly ImpliedRole[];
  readonly subjectSet?: boolean; // holders form a subject set others can be assigned to
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
