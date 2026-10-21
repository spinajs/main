import type { Permission, PrincipalRef, ResourceRef } from '@spinajs/authz';

import type { Assignment, AssignmentSubject, LinkDef, RuleDef } from '../contracts.js';

/** The holders of `role` at `scope`: a subject set (group.member at group:G, org.member at org:O). */
export interface RoleSetRef {
  readonly role: string;
  readonly scope: ResourceRef;
}

export interface AssignmentGrantCommand {
  readonly kind: 'assignment.grant';
  readonly subject: AssignmentSubject;
  readonly role: string;
  readonly scope: ResourceRef;
  readonly tags?: readonly string[];
  readonly expiresAt?: Date | null;
  readonly replaceLadder?: boolean; // revoke the subject's other roles of the same ladder at this scope
}

export interface AssignmentRevokeCommand {
  readonly kind: 'assignment.revoke';
  readonly id: string;
}

export interface AssignmentRevokeWhereCommand {
  readonly kind: 'assignment.revokeWhere';
  readonly scope: ResourceRef;
  readonly subject?: AssignmentSubject;
  readonly role?: string;
}

/** One shape for the three tag commands, so a kind picked at run time still types as a command. */
export interface AssignmentTagsCommand {
  readonly kind: 'assignment.setTags' | 'assignment.addTags' | 'assignment.removeTags';
  readonly id: string;
  readonly tags: readonly string[];
}

export interface AssignmentSetExpiryCommand {
  readonly kind: 'assignment.setExpiry';
  readonly id: string;
  readonly expiresAt: Date | null;
}

/** Sugar over an assignment of a subjectSet role. */
export interface SetAddMemberCommand {
  readonly kind: 'set.addMember';
  readonly set: RoleSetRef;
  readonly member: PrincipalRef;
  readonly expiresAt?: Date | null;
}

export interface SetRemoveMemberCommand {
  readonly kind: 'set.removeMember';
  readonly set: RoleSetRef;
  readonly member: PrincipalRef;
}

export interface LinkCreateCommand {
  readonly kind: 'link.create';
  readonly scope: ResourceRef;
  readonly role: string;
  readonly tags?: readonly string[];
  readonly expiresAt?: Date | null;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface LinkUpdateCommand {
  readonly kind: 'link.update';
  readonly id: string;
  readonly expiresAt?: Date | null;
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly role?: string;
  readonly tags?: readonly string[];
}

export interface LinkRevokeCommand {
  readonly kind: 'link.revoke';
  readonly id: string;
}

/** Inserts or replaces a scoped rule by id; it must be in SQL form (D24). Config rules stay in config. */
export interface RulePutCommand {
  readonly kind: 'rule.put';
  readonly rule: Omit<RuleDef, 'source'>;
}

export interface RuleDeleteCommand {
  readonly kind: 'rule.delete';
  readonly id: string;
}

export interface AssignmentsAdminQuery {
  readonly kind: 'assignments';
  readonly scope?: ResourceRef;
  readonly subject?: AssignmentSubject;
  readonly role?: string;
  readonly includeExpired?: boolean;
  readonly page?: { limit: number; offset: number; after?: string };
}

export interface LinksAdminQuery {
  readonly kind: 'links';
  readonly scope?: ResourceRef;
  readonly page?: { limit: number; offset: number; after?: string };
}

export interface RulesAdminQuery {
  readonly kind: 'rules';
  readonly scope?: ResourceRef;
  readonly page?: { limit: number; offset: number; after?: string };
}

/** Who holds `permission` at `scope`, through which assignment. */
export interface HoldersAdminQuery {
  readonly kind: 'holders';
  readonly scope: ResourceRef;
  readonly permission: Permission;
  readonly expandSets?: boolean;
  readonly page?: { limit: number; offset: number; after?: string };
}

declare module '@spinajs/authz' {
  interface AuthzCommandMap {
    'assignment.grant': AssignmentGrantCommand;
    'assignment.revoke': AssignmentRevokeCommand;
    'assignment.revokeWhere': AssignmentRevokeWhereCommand;
    'assignment.setTags': AssignmentTagsCommand;
    'assignment.addTags': AssignmentTagsCommand;
    'assignment.removeTags': AssignmentTagsCommand;
    'assignment.setExpiry': AssignmentSetExpiryCommand;
    'set.addMember': SetAddMemberCommand;
    'set.removeMember': SetRemoveMemberCommand;
    'link.create': LinkCreateCommand;
    'link.update': LinkUpdateCommand;
    'link.revoke': LinkRevokeCommand;
    'rule.put': RulePutCommand;
    'rule.delete': RuleDeleteCommand;
  }

  interface AuthzCommandRowMap {
    'assignment.grant': Assignment;
    'link.create': LinkDef;
  }

  interface AuthzAdminQueryMap {
    assignments: AssignmentsAdminQuery;
    links: LinksAdminQuery;
    rules: RulesAdminQuery;
    holders: HoldersAdminQuery;
  }
}
