import { Connection, Model } from '@spinajs/orm';
import _ from 'lodash';
 
import { OrmResource, UserMetadata } from '@spinajs/rbac';
import { Filterable } from '@spinajs/orm-http';

@Connection('default')
@Model('users_metadata')
@OrmResource('user.metadata')
export class FilterableUserMetadata extends UserMetadata{
   
    @Filterable(['eq', 'like', 'b-like','e-like'])
    public Key: string;

    @Filterable(['eq'])
    public Type: 'number' | 'float' | 'string' | 'json' | 'boolean' | 'datetime';
  
}
