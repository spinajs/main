import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { buildDefinitions, getScheduleDeclarations } from '@spinajs/scheduler';
import type { RunContext, ScheduleDeclaration } from '@spinajs/scheduler';
import { DateTime } from 'luxon';
import sinon from 'sinon';

import { UploadSweeper } from '../src/index.js';
import type { SweepResult } from '../src/index.js';
import { UPLOAD_SWEEP_SCHEDULE, UploadSweepTask } from '../src/scheduler.js';
import { insertSessionRow, resetUploads, rows, uploadEnv } from './support/env.js';
import { rejection } from './support/flow.js';
import { overrideConfig } from './support/override.js';

describe('UploadSweepTask', () => {
  const declaration = (): ScheduleDeclaration => {
    const found = getScheduleDeclarations().filter((d) => d.name === UPLOAD_SWEEP_SCHEDULE);
    expect(found).to.have.length(1);
    return found[0];
  };
  const definitionOf = (config: { name: string; every?: string }[] = []) => buildDefinitions({ declarations: [declaration()], config, tickMs: 1000, validateParamsSchema: () => null })[0];
  const runContext = (signal: AbortSignal, result: (r: unknown) => void) => ({ signal, result }) as unknown as RunContext;

  before(async () => {
    await uploadEnv();
  });
  beforeEach(resetUploads);
  afterEach(() => sinon.restore());

  it('declares a leader-only schedule that skips overlapping runs, every upload.sweeper.every', () => {
    expect(declaration().target).to.eq(UploadSweepTask);
    expect(declaration().options).to.deep.include({ every: '15m', runOn: 'leader', overlap: 'skip' });
  });

  it('reads upload.sweeper.every when the scheduler builds the definition, not at import', async () => {
    await overrideConfig('upload.sweeper.every', '5m');

    const definition = definitionOf();
    expect(definition).to.deep.include({ name: UPLOAD_SWEEP_SCHEDULE, runOn: 'leader', overlap: 'skip', task: UploadSweepTask });
    expect(definition.spec).to.deep.include({ kind: 'every', intervalMs: 300_000 });
  });

  it('lets a scheduler.schedules entry of the same name override the interval', () => {
    const definition = definitionOf([{ name: UPLOAD_SWEEP_SCHEDULE, every: '1h' }]);
    expect(definition.spec).to.deep.include({ kind: 'every', intervalMs: 3_600_000 });
    expect(definition).to.deep.include({ runOn: 'leader', overlap: 'skip' });
  });

  it('sweeps with the run signal and records the counts as the run result', async () => {
    const id = await insertSessionRow({ expires_at: DateTime.utc().minus({ seconds: 1 }) });
    const sweep = sinon.spy(await DI.resolve(UploadSweeper), 'sweep');
    const signal = new AbortController().signal;
    let recorded: unknown;

    const result = await (await DI.resolve(UploadSweepTask)).execute(runContext(signal, (r) => (recorded = r)));

    expect(sweep.firstCall.args[0]).to.deep.equal({ signal });
    expect(result.expired).to.eq(1);
    expect(recorded).to.deep.equal(result);
    expect((await rows('upload_sessions', { id }))[0].status).to.eq('expired');
  });

  it('fails the run with the counts in its message when an item failed', async () => {
    const failed: SweepResult = { expired: 1, released: 0, reemitted: 0, purged: 0, removedBlobs: 0, keptBlobs: 0, errors: 2 };
    sinon.stub(await DI.resolve(UploadSweeper), 'sweep').resolves(failed);
    let recorded = false;

    const error = await rejection((await DI.resolve(UploadSweepTask)).execute(runContext(new AbortController().signal, () => (recorded = true))));

    expect((error as Error).message).to.eq(`upload sweep: 2 item(s) failed: ${JSON.stringify(failed)}`);
    expect(recorded).to.eq(false);
  });
});
