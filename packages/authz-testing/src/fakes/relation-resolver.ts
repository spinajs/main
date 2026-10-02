import { RelationResolver } from '@spinajs/authz';
import type { Principal, ResourceRef, ResourceType } from '@spinajs/authz';

export type HoldsFn = (principal: Principal, ref: ResourceRef, subject?: unknown) => boolean | Promise<boolean>;

export class FakeRelationResolver extends RelationResolver {
  calls = 0;

  constructor(
    readonly type: ResourceType,
    readonly relation: string,
    private readonly fn: HoldsFn,
  ) {
    super();
  }

  holds(principal: Principal, ref: ResourceRef, subject?: unknown): boolean | Promise<boolean> {
    this.calls++;
    return this.fn(principal, ref, subject);
  }
}
