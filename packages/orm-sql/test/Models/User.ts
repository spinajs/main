
import { _update, Primary, Connection, Model, ModelBase, HasMany, Relation } from '@spinajs/orm';
import _ from 'lodash';
import { _cfg } from '@spinajs/configuration';
import { UserMetadata } from './UserMetadata.js';

/**
 * Class defined for ORM resource support
 */
@Connection('sqlite')
@Model('users')
export class User extends ModelBase<User> {
    @Primary()
    public Id: number;

    public Uuid: string;

    public Email: string;


    @HasMany(UserMetadata, {
        foreignKey: "user_id"
    })
    public Metadata: Relation<UserMetadata, User>;

}