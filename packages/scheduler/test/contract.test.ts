import { expect } from 'chai';
import { ResourceNotFound } from '@spinajs/exceptions';
import {
  ErrorGroupNotFound,
  errorCodeFor,
  exitCodeForError,
  formatSseEvent,
  httpStatusForError,
  InvalidRunParams,
  InvalidRunState,
  isTerminalEvent,
  isTerminalStatus,
  parseSseEventId,
  RunConflict,
  RunEvent,
  RunNotFound,
  RunStatus,
  ScheduleNotFound,
  SchedulePaused,
  sseEventId,
} from '../src/index.js';

const status = (s: RunStatus): RunEvent => ({
  type: 'status',
  status: s,
  reason: null,
  id: 41,
  seq: 3,
  runId: 'r1',
  schedule: 'a',
  attempt: 1,
  ts: '2026-01-05T10:00:00.000Z',
});

describe('contract', () => {
  it('maps service errors to codes, HTTP statuses and exit codes', () => {
    const cases: Array<[unknown, string, number, number]> = [
      [new ScheduleNotFound('x'), 'not-found', 404, 4],
      [new RunNotFound('r'), 'not-found', 404, 4],
      [new ErrorGroupNotFound('f'), 'not-found', 404, 4],
      [new RunConflict('busy', 'r0'), 'conflict', 409, 3],
      [new InvalidRunParams('bad', [{ path: '/file', message: 'must be string' }]), 'invalid-params', 400, 2],
      [new InvalidRunState('nope', 'succeeded'), 'invalid-state', 409, 3],
      [new SchedulePaused('x'), 'invalid-state', 409, 3],
      [new Error('boom'), 'error', 500, 1],
    ];
    for (const [err, code, http, exit] of cases) {
      expect(errorCodeFor(err)).to.eq(code);
      expect(httpStatusForError(err)).to.eq(http);
      expect(exitCodeForError(err)).to.eq(exit);
    }
    expect(new ScheduleNotFound('x')).to.be.instanceOf(ResourceNotFound);
    expect(new RunConflict('busy', 'r0').runId).to.eq('r0');
  });

  it('encodes SSE ids per target and formats frames', () => {
    const e = status('running');
    expect(sseEventId({ runId: 'r1' }, e)).to.eq('3');
    expect(sseEventId({ schedule: 'a' }, e)).to.eq('41');
    expect(parseSseEventId('17')).to.eq(17);
    expect(parseSseEventId('')).to.eq(undefined);
    expect(parseSseEventId('x')).to.eq(undefined);
    expect(formatSseEvent({ runId: 'r1' }, e)).to.eq(`id: 3\nevent: status\ndata: ${JSON.stringify(e)}\n\n`);
  });

  it('treats only final statuses as terminal; retrying and emitted keep a stream open', () => {
    const all: RunStatus[] = [
      'queued',
      'running',
      'succeeded',
      'failed',
      'retrying',
      'dead',
      'aborted',
      'emitted',
      'skipped',
      'misfired',
    ];
    expect(all.filter(isTerminalStatus)).to.deep.eq(['succeeded', 'failed', 'dead', 'aborted', 'skipped', 'misfired']);
    expect(isTerminalEvent(status('succeeded'))).to.eq(true);
    expect(isTerminalEvent(status('retrying'))).to.eq(false);
    expect(isTerminalEvent(status('emitted'))).to.eq(false);
  });
});
