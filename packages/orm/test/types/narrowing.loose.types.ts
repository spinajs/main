import { assertType } from './assert.js';
import type { Equal } from './assert.js';
import { User } from './models.js';

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
