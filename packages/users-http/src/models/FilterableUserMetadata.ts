import { Connection, Model } from '@spinajs/orm';

import { UserMetadataBase } from '@spinajs/users';
import { Filterable } from '@spinajs/orm-http';

/**
 * The metadata model the list route filters through. Not an authz-orm `@AccessResource`: that would gate every non-SYSTEM query on
 * `users_metadata` through users' own models, and `UserMetadataService` decides each row itself.
 */
@Connection('default')
@Model('users_metadata')
export class FilterableUserMetadata extends UserMetadataBase {
  @Filterable(['eq', 'like', 'b-like', 'e-like'])
  public get Key(): string {
    return super.Key;
  }

  // NOTE: overriding only the getter drops the setter MetadataModel defines
  // for the same property — the accessor pair on this prototype shadows the
  // inherited one. Hydration assigns `Key`, so every row read through this
  // model died with "Cannot set property Key ... which has only a getter".
  public set Key(value: string) {
    super.Key = value;
  }

  @Filterable(['eq'])
  public Type: 'number' | 'float' | 'string' | 'json' | 'boolean' | 'datetime';
}
