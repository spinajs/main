import { col, SqlOperator } from '@spinajs/orm';
import { User } from '../models.js';

export async function staticsStrict(dynamic: string): Promise<void> {
  await User.where('Id', 1).whereEmail('a');
  await User.where('Id', SqlOperator.GT, 1);
  await User.where('Team', 3);
  await User.where(col('legacy_column'), 'x');
  await User.where({ Email: 'a' });
  await User.first((b) => {
    b.where('Email', 'x');
  });
  await User.last((b) => b.where('IsActive', true));
  await User.count((b) => b.where('Id', '>', 1));

  // The second argument of each 2-argument negative is also a valid operator (or undefined), so only the
  // column or the value can reject the call.
  // @ts-expect-error unknown column
  User.where('Nmae', 'like');
  // @ts-expect-error unknown column
  User.where('Nmae', undefined);
  // @ts-expect-error the value does not match the column type
  User.where('Id', 'like');
  // @ts-expect-error a non-literal column needs col()
  User.where(dynamic, '=');
  // @ts-expect-error unknown column behind an operator
  User.where('Nmae', '=', 1);
  // @ts-expect-error the value does not match the column type behind an operator
  User.where('Id', '>', 'x');
  // @ts-expect-error a non-literal column needs col(), also behind an operator
  User.where(dynamic, '=', 1);
  // @ts-expect-error unknown key in the object form
  User.where({ Emial: 'x' });
  // @ts-expect-error the object form checks the value type
  User.where({ Email: 1 });
  void User.first((b) => {
    // @ts-expect-error the callback builder is typed with the model instance
    b.where('Emial', 'x');
  });
}
