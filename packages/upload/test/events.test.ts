import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { LogLevel } from '@spinajs/log';
import { DateTime } from 'luxon';

import shipped from '../src/config/upload.js';
import { UPLOAD_EVENTS, UPLOAD_EVENT_NAMES, UploadAborted, UploadCompleted, UploadCreated, UploadEvents, UploadExpired, UploadFailed, UploadPartStored, finalEventOf } from '../src/index.js';
import type { UploadEvent } from '../src/index.js';
import { CaptureQueueClient, emitted, emittedNames, uploadLogs } from './support/capture.js';
import { insertSessionRow, resetUploads, rows, uploadEnv } from './support/env.js';

describe('upload events', () => {
  let events: UploadEvents;
  const session = async (values: Record<string, unknown> = {}) => (await uploadEnv()).store.requireSession(await insertSessionRow(values));
  const created = (s: Awaited<ReturnType<typeof session>>) => new UploadCreated(s, { PartSize: 4, PartCount: 3, DeclaredMime: 'text/plain', ExpiresAt: '2030-01-01T00:00:00.000Z' });

  before(async () => {
    await uploadEnv();
    events = await DI.resolve(UploadEvents);
  });
  beforeEach(resetUploads);

  it('names the twelve events of spec §6.6, and the shipped config sends each one to the upload-events black hole', () => {
    expect([...UPLOAD_EVENT_NAMES].sort()).to.deep.equal(
      ['UploadAborted', 'UploadAssemblyReleased', 'UploadAssemblyStarted', 'UploadCompleted', 'UploadContentChecked', 'UploadCreated', 'UploadExpired', 'UploadFailed', 'UploadPartCorrupted', 'UploadPartRejected', 'UploadPartStored', 'UploadPurged'],
    );
    const routing = shipped.queue.routing as Record<string, unknown>;
    expect(Object.keys(routing).sort()).to.deep.equal([...UPLOAD_EVENT_NAMES].sort());
    for (const name of UPLOAD_EVENT_NAMES) expect(routing[name], name).to.deep.equal({ connection: 'upload-events' });
    expect(shipped.queue.connections.map((c) => [c.name, c.service])).to.deep.equal([['upload-events', 'BlackHoleQueueClient']]);
  });

  it('copies the common fields from the session and its own fields from the caller', async () => {
    const s = await session({ owner: 'alice', metadata: { projectId: 'p1' } });
    const e = new UploadPartStored(s, { Part: 2, PartSize: 4, PartSha256: 'a'.repeat(64), Offset: 4, ReceivedParts: 1, PartCount: 3, Replaced: false });
    expect(e.Name).to.eq('UploadPartStored');
    expect([e.UploadId, e.Owner, e.FileName, e.Size, e.Metadata, e.TempFs, e.FilesFs, e.Status]).to.deep.equal([s.id, 'alice', 'notes.txt', 10, { projectId: 'p1' }, 'upload-temp', 'upload-files', 'open']);
    expect([e.Part, e.Offset, e.Replaced]).to.deep.equal([2, 4, false]);
    expect(DateTime.isDateTime(e.CreatedAt)).to.eq(true);
  });

  it('builds every event without arguments, as a consumer does before hydrating it (users/src/events/UserEvent.ts:5-8)', () => {
    for (const type of UPLOAD_EVENTS) {
      const blank = DI.resolve<UploadEvent>(type as unknown as Class<UploadEvent>);
      expect(blank, type.name).to.be.instanceOf(type);
      expect(blank.Name).to.eq(type.name);
    }
    const hydrated = DI.resolve<UploadCompleted>(UploadCompleted);
    hydrated.hydrate({ UploadId: 'u-1', Sha256: 'b'.repeat(64) });
    expect([hydrated.UploadId, hydrated.Sha256, hydrated.Name]).to.deep.equal(['u-1', 'b'.repeat(64), 'UploadCompleted']);
  });

  it('stage(): emits the event, and logs a failed emit at warn instead of throwing it', async () => {
    const s = await session();
    await events.stage(created(s));
    expect(emittedNames()).to.deep.equal(['UploadCreated']);

    CaptureQueueClient.FailNames.add('UploadCreated');
    await events.stage(created(s));
    expect(emittedNames()).to.deep.equal(['UploadCreated']);
    expect(uploadLogs(LogLevel.Warn).map((l) => [l.Variables.uploadId, l.Variables.event])).to.deep.equal([[s.id, 'UploadCreated']]);
  });

  it('final(): emits the event the row owes and stamps final_event_at; a failed emit leaves it owed', async () => {
    const s = await session({ status: 'aborted', final_event: 'UploadAborted' });
    CaptureQueueClient.FailNames.add('UploadAborted');
    expect(await events.final(s)).to.eq(false);
    expect((await rows('upload_sessions', { id: s.id }))[0].final_event_at).to.eq(null);
    expect(uploadLogs(LogLevel.Warn).map((l) => l.Variables.event)).to.deep.equal(['UploadAborted']);

    CaptureQueueClient.FailNames.clear();
    expect(await events.final(s)).to.eq(true);
    expect((await rows('upload_sessions', { id: s.id }))[0].final_event_at).to.not.eq(null);
    expect(emittedNames()).to.deep.equal(['UploadAborted']);
  });

  it('final(): emits nothing for a session that owes no final event', async () => {
    expect(await events.final(await session())).to.eq(false);
    expect(emitted()).to.deep.equal([]);
  });

  it('finalEventOf(): rebuilds each final event from its row, as the sweeper re-emits it', async () => {
    const completedAt = DateTime.utc();
    const done = finalEventOf(await session({ status: 'completed', final_event: 'UploadCompleted', sha256: 'f'.repeat(64), detected_mime: null, file_key: 'uploads/files/x.txt', completed_at: completedAt }));
    expect(done).to.be.instanceOf(UploadCompleted).and.include({ Sha256: 'f'.repeat(64), Mime: 'text/plain', FileKey: 'uploads/files/x.txt', CompletedAt: new Date(completedAt.toMillis()).toISOString() });
    const failed = finalEventOf(await session({ status: 'failed', final_event: 'UploadFailed', failure_code: 'upload.size_mismatch', failure_message: 'short' }));
    expect(failed).to.be.instanceOf(UploadFailed).and.include({ Code: 'upload.size_mismatch', Message: 'short' });
    expect(finalEventOf(await session({ status: 'aborted', final_event: 'UploadAborted' }))).to.be.instanceOf(UploadAborted);
    const expired = await session({ status: 'expired', final_event: 'UploadExpired' });
    expect(finalEventOf(expired)).to.be.instanceOf(UploadExpired).and.include({ ExpiresAt: new Date(expired.expires_at.toMillis()).toISOString() });
    expect(finalEventOf(await session())).to.eq(null);
  });
});
