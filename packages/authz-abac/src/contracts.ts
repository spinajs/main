import type { Condition, FieldSet, PrincipalType, ResourceRef, ResourceType } from '@spinajs/authz';

// The ABAC admin commands; importing them adds them to AuthzCommand and AuthzAdminQuery.
export type { PolicyPutCommand, PolicyDeleteCommand, PoliciesAdminQuery } from './admin/commands.js';

export interface Policy {
  readonly id: string;
  readonly effect: 'permit' | 'deny';
  readonly permissions: readonly string[]; // globs
  readonly resourceTypes?: readonly ResourceType[];
  readonly principalTypes?: readonly PrincipalType[];
  readonly actorTypes?: readonly PrincipalType[]; // matches DecisionRequest.actor (agents under 'inherit')
  readonly scope?: ResourceRef; // applies at this node and below (per-org policies)
  readonly when?: Condition;
  readonly fields?: FieldSet;
  readonly reason?: string;
  readonly priority?: number; // default 500
  readonly expiresAt?: Date | null;
  readonly source: string;
}

export abstract class PolicyStore {
  abstract readonly name: string;
  abstract load(): Promise<readonly Policy[]>;
  abstract version(): Promise<string>;
}
