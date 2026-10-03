import type { Principal, RelationResolver, ResourceType } from '@spinajs/authz';

export function ownsBy<T>(type: ResourceType, relation: string, fn: (p: Principal, row: T) => boolean): RelationResolver {
  void type, relation, fn;
  throw new Error('@spinajs/authz-orm: ownsBy is not implemented yet');
}
