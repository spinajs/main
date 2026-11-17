import type { ResourceRef } from '@spinajs/authz';
import { AttributeHistoryContributors } from '@spinajs/authz-ir';
import type { AttributeLeafImage } from '@spinajs/authz-ir';
import { Injectable, Singleton } from '@spinajs/di';

import { attributeChangeKey, loggedLeaves } from './db-store.js';

/** The leaves of `DbScopeAttributeStore` nodes (kind `attribute`, one changelog row per leaf) for replay's captured-state check. */
@Singleton()
@Injectable(AttributeHistoryContributors)
export class ScopeAttributeHistoryContributor extends AttributeHistoryContributors {
  readonly kind = 'attribute' as const;

  key(scope: ResourceRef, path: string): string {
    return attributeChangeKey(scope, path);
  }

  current(scope: ResourceRef): Promise<AttributeLeafImage[]> {
    return loggedLeaves(scope);
  }
}
