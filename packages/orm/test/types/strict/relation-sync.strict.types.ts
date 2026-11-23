import { DeleteQueryBuilder } from '@spinajs/orm';
import type { IRelation, IRelationSyncStatement, ManyToManyRelationList, OneToManyRelationList } from '@spinajs/orm';
import { Team, User, UserMetadata } from '../models.js';
import { assertType } from '../assert.js';
import type { Equal } from '../assert.js';

declare const items: OneToManyRelationList<UserMetadata, User>;
declare const teams: ManyToManyRelationList<Team, User>;
declare const relation: IRelation<UserMetadata, User>;

function narrowing(this: IRelationSyncStatement): void {
  this.where('team_id', 2);
  this.orWhere('team_id', 3);
  this.andWhere('team_id', 4);
  this.where('team_id', '=', 2);
  this.where({ team_id: 2 });
  this.where('team_id', 2).orWhere('team_id', 3).whereNotIn('team_id', [4]);
  // take() only on the delete, increment() only on the update (the soft-delete stamp)
  assertType<Equal<'take' extends keyof IRelationSyncStatement ? true : false, false>>();
  assertType<Equal<'increment' extends keyof IRelationSyncStatement ? true : false, false>>();
  if (this instanceof DeleteQueryBuilder) {
    this.take(1);
  }
}

export async function relationSyncStrict(): Promise<void> {
  await items.sync(narrowing);
  await teams.sync(narrowing);
  await relation.sync(narrowing);
  await User.query().first().then((u) => u.Metadata.sync(narrowing));
  await items.sync(function () {
    this.where('Key', 'k');
  });
  await items.sync();

  assertType<Equal<ThisParameterType<NonNullable<Parameters<OneToManyRelationList<UserMetadata, User>['sync']>[0]>>, IRelationSyncStatement>>();
  assertType<Equal<ThisParameterType<NonNullable<Parameters<ManyToManyRelationList<Team, User>['sync']>[0]>>, IRelationSyncStatement>>();
}
