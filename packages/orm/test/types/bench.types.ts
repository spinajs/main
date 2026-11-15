import { SortOrder } from '@spinajs/orm';
import { Team, User } from './models.js';

// Fixed workload for budget.mjs. Do not edit it: the counts must stay comparable across branches.
export async function bench(id: number, email: string): Promise<unknown[]> {
  const out: unknown[] = [];
  out.push(await User.query().where('Id', id).where('Email', email).orderBy('CreatedAt').first());
  out.push(await User.query().where('IsActive', true).whereIn('Id', [1, 2]).whereNull('Name').take(10));
  out.push(
    await User.query()
      .where(function () {
        this.where('Email', email).orWhere('Id', '>', id);
      })
      .order('Id', SortOrder.DESC),
  );
  out.push(await User.query().select('Id').select('Email').where('Id', id));
  out.push(await User.query().columns(['Id', 'Email']).groupBy('IsActive'));
  out.push(await User.query().count('Id', 'total'));
  out.push(await User.query().max('Id', 'top').min('Id', 'low'));
  out.push(await User.query().populate('Team').where('Id', id).first());
  out.push(await User.query().populate('Metadata').whereEmail(email));
  out.push(await Team.query().where('Name', email).orderByDescending('Id'));
  out.push(await User.update({ Email: email }).where('Id', id).increment('Id'));
  out.push(await User.destroy().where('Id', id));
  return out;
}
