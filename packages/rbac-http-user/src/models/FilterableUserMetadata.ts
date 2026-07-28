import { Connection, Model } from '@spinajs/orm';
import _ from 'lodash';
 
import { OrmResource, UserMetadata } from '@spinajs/rbac';
import { Filterable } from '@spinajs/orm-http';

@Connection('default')
@Model('users_metadata')
@OrmResource('user.metadata')
export class FilterableUserMetadata extends UserMetadata{
   
    @Filterable(['eq', 'like', 'b-like','e-like'])
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
