// Call sites from packages/scheduler/src and packages/authz-rbac/src, with their models cut down to the
// columns these queries read. They compile unchanged in loose and in strict mode.
import { ModelBase, outer } from '@spinajs/orm';
import type { ISelectQueryBuilder, IWhereBuilder, Relation } from '@spinajs/orm';
import type { DateTime } from 'luxon';

type RunStatus = 'queued' | 'running' | 'retrying' | 'emitted' | 'succeeded' | 'failed' | 'cancelled';

class ScheduleModel extends ModelBase {
  public Name: string;
  public Paused: boolean;
  public Orphaned: boolean;
  public NextRunAt: number | null;
}

class RunModel extends ModelBase {
  public Id: string;
  public Schedule: string;
  public Status: RunStatus;
  public Attempt: number;
  public NextAttemptAt: number | null;
  public CreatedAt: number;
  public StartedAt: number | null;
  public LeaseUntil: number | null;
  public JobId: string | null;
  public CancelRequested: boolean;
  public ProgressCapped: boolean;
}

class RunStepModel extends ModelBase {
  public Id: string;
  public RunId: string;
  public Attempt: number;
  public Seq: number;
  public Status: string;
  public FinishedAt: number | null;
}

class VersionRecord extends ModelBase<VersionRecord> {
  public domain: string;
  public version: string;
}

class AdminIdempotencyRecord extends ModelBase<AdminIdempotencyRecord> {
  public domain: string;
  public actor: string;
  public expires_at: DateTime;
}

class AssignmentRecord extends ModelBase<AssignmentRecord> {
  public id: string;
  public role: string;
  public scope_type: string;
  public scope_id: string;
  public subject_key: string;
  public expires_at: DateTime;
}

class MembershipRecord extends ModelBase<MembershipRecord> {
  public member_key: string;
  public set_key: string;
  public depth: number;
}

export async function schedulerCallSites(since: number, maxJitter: number, tick: number, now: number, runId: string, schedule: string, after: { createdAt: number; id: string } | undefined, batchSize: number): Promise<void> {
  await ScheduleModel.where('Paused', false).where('Orphaned', false).whereNotNull('NextRunAt').where('NextRunAt', '>', since - maxJitter).where('NextRunAt', '<=', since + tick);
  await RunModel.where('Status', 'retrying').where('NextAttemptAt', '>', since).orderBy('NextAttemptAt').first();
  const run = await RunModel.where('Id', runId).first();
  await RunModel.where('Schedule', schedule).where('Status', 'running').orderByDescending('StartedAt').first();
  const due = RunModel.query()
    .whereIn('Status', ['queued', 'retrying'])
    .where(function (this: IWhereBuilder<unknown>) {
      this.whereNull('NextAttemptAt').orWhere('NextAttemptAt', '<=', now).orWhere('CancelRequested', true);
    });
  await due.whereNotIn('Schedule', [schedule]).orderBy('CreatedAt').take(100);
  await RunModel.where('Status', 'running').where('LeaseUntil', '<', now).take(50);
  await RunModel.where('Schedule', run.Schedule).where('Status', 'running').where('Id', '<>', runId).orderByDescending('StartedAt').first();
  const emitted = RunModel.where('Status', 'emitted').whereNotNull('JobId');
  const query = after
    ? emitted.where(function (this: IWhereBuilder<unknown>) {
        this.where('CreatedAt', '>', after.createdAt).orWhere(function (this: IWhereBuilder<unknown>) {
          this.where('CreatedAt', after.createdAt).where('Id', '>', after.id);
        });
      })
    : emitted;
  await query.orderBy('CreatedAt').orderBy('Id').take(batchSize);
  const capped = RunModel.where('Status', 'running').where('ProgressCapped', true);
  await capped.where('Schedule', schedule).orderBy('CreatedAt');
  await RunStepModel.where('RunId', run.Id).where('Attempt', run.Attempt).orderBy('Seq');
  await RunStepModel.update({ Status: 'aborted', FinishedAt: now }).where('Id', run.Id);
}

export async function authzCallSites(domain: string, now: DateTime, role: string, id: string, column: 'member_key' | 'set_key', unique: string[], q: ISelectQueryBuilder<AssignmentRecord[]>, rowId: string, rowType: string): Promise<void> {
  await VersionRecord.update({ domain }).where('domain', domain);
  await AdminIdempotencyRecord.destroy().where('domain', domain).where('expires_at', '<=', now);
  await VersionRecord.where('domain', domain);
  await AssignmentRecord.query().where('role', role);
  await AssignmentRecord.destroy().where('id', id);
  q.where(function () {
    this.whereNull('expires_at').orWhere('expires_at', '>', now);
  });
  q.where('scope_type', rowType).whereColumn('scope_id', '=', outer(rowId));
  q.whereColumn('scope_type', '=', outer('ancestor_type')).whereColumn('scope_id', '=', outer('ancestor_id'));
  await MembershipRecord.query().whereIn(column, unique);
}

// Call sites from packages/users/src and packages/users-http/src.
class MetaRow extends ModelBase<MetaRow> {
  public Key: string;
  public Value: string;
  public user_id: number;
}

class UserRow extends ModelBase<UserRow> {
  public Id: number;
  public Uuid: string;
  public Login: string;
  public Email: string;
  public DeletedAt: DateTime | null;
  public Metadata: Relation<MetaRow, UserRow>;
}

export async function usersCallSites(login: string, uuid: string, ids: string[], withMetadata: boolean): Promise<UserRow | undefined> {
  for (const column of ['Uuid', 'Login', 'Email'] as const) {
    const found = await UserRow.query().where(column, login).populate('Metadata').first();
    if (found && !found.DeletedAt) return found;
  }
  await UserRow.query().where('Uuid', uuid).populate('Metadata').firstOrFail();
  await UserRow.query().whereIn('Uuid', ids).populate('Metadata');
  await UserRow.query().withDeleted().where('Uuid', uuid).populate('Metadata').first();
  const query = UserRow.query().where('Uuid', uuid);
  return (await (withMetadata ? query.populate('Metadata') : query).first()) ?? undefined;
}
