import type { PrincipalRef, ResourceRef, ResourceType } from '@spinajs/authz';

// The shape reserved for a later @spinajs/authz-rebac; fakes use it.
export interface Tuple {
  readonly object: ResourceRef;
  readonly relation: string;
  readonly subject: PrincipalRef | { readonly object: ResourceRef; readonly relation: string };
}

export abstract class TupleStore {
  abstract read(object: ResourceRef, relation: string): Promise<readonly Tuple[]>;
  abstract reverse(subject: PrincipalRef, relation: string, objectType: ResourceType): Promise<readonly ResourceRef[]>;
  abstract write(add: readonly Tuple[], remove: readonly Tuple[], actor: PrincipalRef): Promise<string>; // returns version
}
