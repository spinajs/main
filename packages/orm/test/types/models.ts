import { ModelBase } from '@spinajs/orm';
import type { ISelectQueryBuilder, IWhereBuilder, QueryScope, Relation, SingleRelation } from '@spinajs/orm';
import type { DateTime } from 'luxon';

export class Team extends ModelBase<Team> {
  public Id: number;
  public Name: string;
}

export class UserMetadata extends ModelBase<UserMetadata> {
  public Id: number;
  public Key: string;
  public Value: string;
  public user_id: number;
}

export class UserQueryScopes implements QueryScope {
  public whereEmail(this: ISelectQueryBuilder<User[]> & UserQueryScopes, email: string) {
    return this.where('Email', email);
  }
}

export class User extends ModelBase<User> {
  public static readonly _queryScopes: UserQueryScopes = new UserQueryScopes();
  public Id: number;
  public Email: string;
  public Name?: string | null;
  public IsActive: boolean;
  public CreatedAt: DateTime;
  public Metadata: Relation<UserMetadata, User>;
  public Team: SingleRelation<Team>;
  public Owner?: SingleRelation<User>;
}

// The `upload` package style: snake_case columns and a scope generic over the builder.
export class UploadScopes implements QueryScope {
  public ofSession<B extends IWhereBuilder<Upload> & UploadScopes>(this: B, sessionId: string): B {
    return this.where('session_id', sessionId);
  }
}

export class Upload extends ModelBase<Upload> {
  public static readonly _queryScopes: UploadScopes = new UploadScopes();
  public id: string;
  public session_id: string;
}
