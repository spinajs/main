import type { SelectQueryBuilder } from '@spinajs/orm';
import { assertType } from './assert.js';
import type { Equal } from './assert.js';
import { Team, User } from './models.js';

// Loose mode never removes a property: projections keep the model type.
export async function projectionLoose(): Promise<void> {
  const selected = await User.query().select('Id');
  assertType<Equal<typeof selected, User[]>>();
  const listed = await User.query().columns(['Id']);
  assertType<Equal<typeof listed, User[]>>();
  const counted = await User.query().count();
  assertType<Equal<typeof counted, User[]>>();
  const readsAll = await User.query().select('Id').first();
  void readsAll.Email;
  void [selected, listed, counted];
}

export async function aggregatesLoose(): Promise<void> {
  const counted = await User.query().count('Id', 'total');
  assertType<Equal<typeof counted, User[]>>();
  const summed = await User.query().sum('Id', 's');
  assertType<Equal<typeof summed, User[]>>();
  void [counted, summed];
}

export async function populateLoose(dynamic: string): Promise<void> {
  const user = await User.query().where('Id', 1).populate('Team').first();
  const team: Team = user.Team.Value;
  void team;
  const withMeta = await User.query().populate('Metadata.user_id');
  assertType<Equal<(typeof withMeta)[number]['Metadata']['Populated'], true>>();
  // query scopes survive populate
  await User.query().populate('Team').whereEmail('a');
  // the callback queries the related model
  await User.query().populate('Metadata', function () {
    this.where('Key', 'k').where('Nope', 1);
  });
  // every other form still compiles and returns the builder unchanged
  await User.query().populate(dynamic).populate(['Metadata', 'Team']).populate({ Metadata: {} }).populate(Team).populate(null);
  // a class-typed builder can still be returned as one
  const returned: SelectQueryBuilder<User[]> = User.all().populate('Team');
  // on the class the callback is a class too, so class-only members stay reachable
  await User.all().populate('Team', function () {
    this.mergeStatements(User.all());
  });
  // a required relation guarantees the row; an optional one may still have none
  assertType<Equal<typeof user.Team.Value, Team>>();
  const owned = await User.query().populate('Owner').first();
  assertType<Equal<typeof owned.Owner.Value, User | undefined>>();
  assertType<Equal<typeof owned.Owner.Populated, true>>();
  void [withMeta, returned, owned];
}
