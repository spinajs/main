import { Injectable, Singleton } from '@spinajs/di';
import { UnexpectedServerError } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log-common';
import type { StructuredError } from '../contract.js';
import { ErrorGroupModel } from '../models/ErrorGroupModel.js';
import { computeFingerprint } from './fingerprint.js';

const MAX_SAMPLE = 2000;
const MAX_NAME = 128;
const MAX_TRIES = 5;

export interface RecordedError {
  fingerprint: string;
  /** This call reopened a `resolved` group; of several concurrent callers only one gets true. */
  regressed: boolean;
}

/**
 * Error groups (`__scheduler_error`). Replicas record into the same rows at once, so a
 * group is bumped with in-place increments whose WHERE decides the outcome, never read-modify-write.
 */
@Singleton()
@Injectable()
export class ErrorTracker {
  @Logger('SCHEDULER')
  protected Log: Log;

  public async record(schedule: string, runId: string, error: StructuredError, now: number): Promise<RecordedError> {
    const fingerprint = computeFingerprint(schedule, error);
    const sampleMessage = error.message.slice(0, MAX_SAMPLE);
    const sampleStack = error.stack ?? null;
    const latest = { LastSeen: now, LastRunId: runId, SampleMessage: sampleMessage, SampleStack: sampleStack };

    // spinajs-orm-ignore ORM102: bounded retry of the update/insert race, at most MAX_TRIES passes
    for (let i = 0; i < MAX_TRIES; i++) {
      // `ignored` stays ignored and `open` stays open
      const bumped = await ErrorGroupModel.update(latest).increment('Count').where('Schedule', schedule).where('Fingerprint', fingerprint).where('Status', '<>', 'resolved');
      if (bumped.RowsAffected > 0) return { fingerprint, regressed: false };

      const reopened = await ErrorGroupModel.update({ ...latest, Status: 'open' }).increment('Count').where('Schedule', schedule).where('Fingerprint', fingerprint).where('Status', 'resolved');
      if (reopened.RowsAffected > 0) return { fingerprint, regressed: true };

      try {
        await ErrorGroupModel.create({
          Schedule: schedule,
          Fingerprint: fingerprint,
          Name: error.name.slice(0, MAX_NAME),
          SampleMessage: sampleMessage,
          SampleStack: sampleStack,
          Count: 1,
          FirstSeen: now,
          LastSeen: now,
          LastRunId: runId,
          Status: 'open',
        });
        return { fingerprint, regressed: false };
      } catch (err) {
        // lost the insert race on the unique (Schedule, Fingerprint) index: bump the winner's row
        if (!(await ErrorGroupModel.where('Schedule', schedule).where('Fingerprint', fingerprint).first())) throw err;
        this.Log.trace(`error group ${fingerprint} of ${schedule} inserted concurrently: ${(err as Error).message}`);
      }
    }
    throw new UnexpectedServerError(`scheduler: could not record error group ${fingerprint} of ${schedule}`);
  }
}
