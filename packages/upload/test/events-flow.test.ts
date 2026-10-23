import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { LogLevel } from '@spinajs/log';

import { UploadEvents } from '../src/index.js';
import type { UploadService } from '../src/index.js';
import { CaptureQueueClient, emitted, emittedNames, uploadLogs } from './support/capture.js';
import { resetUploads, rows, uploadEnv } from './support/env.js';
import { open, put, putAll, text } from './support/flow.js';

describe('upload events through a whole upload (spec §6.6, §10)', () => {
  let service: UploadService;
  const file = text(10);

  before(async () => {
    ({ service } = await uploadEnv());
  });
  beforeEach(resetUploads);

  it('emits exactly one event per stage, in order, each one after its commit', async () => {
    const session = await open(service, file);
    await putAll(service, session, file);
    await service.complete(session);

    expect(emittedNames()).to.deep.equal(['UploadCreated', 'UploadContentChecked', 'UploadPartStored', 'UploadPartStored', 'UploadPartStored', 'UploadAssemblyStarted', 'UploadCompleted']);
    expect(CaptureQueueClient.Captured.map((c) => c.inTransaction)).to.deep.equal(new Array<boolean>(7).fill(false));
  });

  it('a stage event that cannot be emitted does not fail the request', async () => {
    CaptureQueueClient.FailNames.add('UploadPartStored');
    const session = await open(service, file);
    await put(service, session, file, 1);
    expect(emitted('UploadPartStored')).to.deep.equal([]);
    expect(await rows('upload_parts', { session_id: session.id })).to.have.length(1);
    expect(uploadLogs(LogLevel.Warn).map((l) => l.Variables.event)).to.include('UploadPartStored');
  });

  it('a final event that cannot be emitted stays owed until UploadEvents.final delivers it', async () => {
    CaptureQueueClient.FailNames.add('UploadCompleted');
    const session = await open(service, file);
    await putAll(service, session, file);
    expect((await service.complete(session)).status).to.eq('completed');
    expect((await rows('upload_sessions', { id: session.id }))[0]).to.include({ final_event: 'UploadCompleted', final_event_at: null });

    CaptureQueueClient.FailNames.clear();
    const events = await DI.resolve(UploadEvents);
    expect(await events.final(await service.get(session.id))).to.eq(true);
    expect((await rows('upload_sessions', { id: session.id }))[0].final_event_at).to.not.eq(null);
    expect(emitted('UploadCompleted')).to.have.length(1);
  });
});
