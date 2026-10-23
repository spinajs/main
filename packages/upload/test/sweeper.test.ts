import 'mocha';
import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { getFs } from '@spinajs/fs';
import { LogLevel } from '@spinajs/log';
import { DateTime } from 'luxon';
import sinon from 'sinon';

import { UploadSweeper } from '../src/index.js';
import type { SweepResult, UploadConfig, UploadService, UploadSession, UploadStore } from '../src/index.js';
import { CaptureLogTarget, CaptureQueueClient, emitted, emittedNames, uploadLogs } from './support/capture.js';
import { insertSessionRow, objectsOf, pathIn, resetUploads, rows, setSession, uploadEnv } from './support/env.js';
import { open, put, putAll, sha256hex, text, uploadErrorOf } from './support/flow.js';
import { overrideConfig } from './support/override.js';
import { StrictFs } from './support/strict-fs.js';

// Paths under TEST_ROOT only, built by pathIn().
/* eslint-disable security/detect-non-literal-fs-filename */
const present = (path: string): boolean => existsSync(path);

function place(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'abcd');
}
/* eslint-enable security/detect-non-literal-fs-filename */

describe('UploadSweeper', () => {
  let service: UploadService;
  let store: UploadStore;
  let sweeper: UploadSweeper;
  const file = text(10);
  const longAgo = () => DateTime.utc().minus({ days: 8 });
  const sessionRow = async (id: string) => (await rows('upload_sessions', { id }))[0];
  const nothing: SweepResult = { expired: 0, released: 0, reemitted: 0, purged: 0, removedBlobs: 0, keptBlobs: 0, errors: 0 };

  /** An object on disk with its blob row, as UploadStorage would have left it. */
  async function object(sessionId: string, values: { state: string; kind?: string; provider?: 'temp' | 'files'; key?: string; updated_at?: DateTime }): Promise<{ id: string; key: string; path: string }> {
    const { driver } = await uploadEnv();
    const provider = values.provider ?? 'temp';
    const id = randomUUID();
    const key = values.key ?? `uploads/${sessionId}/00001-${id}`;
    const path = pathIn(provider, key);
    place(path);
    const at = values.updated_at ?? DateTime.utc();
    await driver
      .insert()
      .into('upload_blobs')
      .values({ id, session_id: sessionId, fs: `upload-${provider}`, key, kind: values.kind ?? 'part', state: values.state, created_at: at, updated_at: at });
    return { id, key, path };
  }

  async function completed(): Promise<UploadSession> {
    const session = await open(service, file);
    await putAll(service, session, file);
    await service.complete(session);
    return service.get(session.id);
  }

  /** Every table's rows, for comparing two runs. */
  async function snapshot(): Promise<unknown> {
    return { sessions: await rows('upload_sessions'), parts: await rows('upload_parts'), blobs: await rows('upload_blobs') };
  }

  async function withBatch(batch: number): Promise<void> {
    const upload = (await DI.resolve(Configuration)).get<UploadConfig>('upload');
    await overrideConfig('upload', { ...upload, sweeper: { ...upload.sweeper, batch } });
  }

  before(async () => {
    ({ service, store } = await uploadEnv());
    sweeper = await DI.resolve(UploadSweeper);
  });
  beforeEach(resetUploads);
  afterEach(() => {
    sinon.restore();
    expect(StrictFs.Banned).to.deep.equal([]);
  });

  it('expires open sessions past expires_at and removes their parts; a second run changes nothing', async () => {
    const due = await open(service, file, { owner: 'alice' });
    await put(service, due, file, 1);
    await put(service, due, file, 2);
    await setSession(due.id, { expires_at: DateTime.utc().minus({ seconds: 1 }) });
    const fresh = await open(service, file);
    await put(service, fresh, file, 1);
    CaptureQueueClient.reset();

    expect(await sweeper.sweep()).to.deep.equal({ ...nothing, expired: 1, removedBlobs: 2 });

    expect(await sessionRow(due.id)).to.include({ status: 'expired', final_event: 'UploadExpired' });
    expect((await sessionRow(due.id)).final_event_at).to.not.eq(null);
    expect(await rows('upload_parts', { session_id: due.id })).to.deep.equal([]);
    expect(await rows('upload_blobs', { session_id: due.id })).to.deep.equal([]);
    expect(objectsOf('temp', `uploads/${due.id}`)).to.deep.equal([]);
    expect(emitted('UploadExpired').map((e) => [String(e.UploadId), String(e.Owner)])).to.deep.equal([[due.id, 'alice']]);
    expect((await sessionRow(fresh.id)).status).to.eq('open');
    expect(await rows('upload_parts', { session_id: fresh.id })).to.have.length(1);

    const first = await snapshot();
    CaptureQueueClient.reset();
    expect(await sweeper.sweep()).to.deep.equal(nothing);
    expect(await snapshot()).to.deep.equal(first);
    expect(emittedNames()).to.deep.equal([]);
  });

  it('releases a stale claim and removes its partial target; a fresh claim is left alone', async () => {
    const stale = await open(service, file);
    await putAll(service, stale, file);
    await setSession(stale.id, { status: 'assembling', claim_token: 'crashed', claimed_at: DateTime.utc().minus({ hours: 1 }) });
    const target = await object(stale.id, { state: 'writing', kind: 'file', provider: 'files', key: `uploads/files/${randomUUID()}.txt` });
    const busy = await open(service, file);
    await setSession(busy.id, { status: 'assembling', claim_token: 'alive', claimed_at: DateTime.utc() });
    CaptureQueueClient.reset();

    expect(await sweeper.sweep()).to.deep.equal({ ...nothing, released: 1, removedBlobs: 1 });

    expect(await sessionRow(stale.id)).to.include({ status: 'open', claim_token: null, claimed_at: null });
    expect(await rows('upload_parts', { session_id: stale.id })).to.have.length(3);
    expect(await rows('upload_blobs', { id: target.id })).to.deep.equal([]);
    expect(present(target.path)).to.eq(false);
    expect(emitted('UploadAssemblyReleased').map((e) => [String(e.UploadId), String(e.Reason)])).to.deep.equal([[stale.id, 'stale']]);
    expect(uploadLogs(LogLevel.Warn).filter((l) => String(l.Variables.message).includes('stale claim')).map((l) => l.Variables.uploadId)).to.deep.equal([stale.id]);
    expect(await sessionRow(busy.id)).to.include({ status: 'assembling', claim_token: 'alive' });

    const resumed = await service.complete(await service.get(stale.id));
    expect(resumed.status).to.eq('completed');
  });

  it('expires a released session in the same run when it is past expires_at', async () => {
    const session = await open(service, file);
    await put(service, session, file, 1);
    await setSession(session.id, { status: 'assembling', claim_token: 'crashed', claimed_at: DateTime.utc().minus({ hours: 1 }), expires_at: DateTime.utc().minus({ minutes: 1 }) });

    expect(await sweeper.sweep()).to.deep.equal({ ...nothing, released: 1, expired: 1, removedBlobs: 1 });
    expect((await sessionRow(session.id)).status).to.eq('expired');
    expect(await sweeper.sweep()).to.deep.equal(nothing);
  });

  it('removes garbage and stale writing blobs by key, and keeps fresh writing and live ones', async () => {
    const s = await insertSessionRow();
    const garbage = await object(s, { state: 'garbage' });
    const staleWriting = await object(s, { state: 'writing', updated_at: DateTime.utc().minus({ hours: 1 }) });
    const freshWriting = await object(s, { state: 'writing' });
    const live = await object(s, { state: 'live', updated_at: DateTime.utc().minus({ hours: 1 }) });
    const rm = sinon.spy(getFs('upload-temp'), 'rm');

    expect(await sweeper.sweep()).to.deep.equal({ ...nothing, removedBlobs: 2 });

    expect(rm.args.map((a) => a[0]).sort()).to.deep.equal([garbage.key, staleWriting.key].sort());
    for (const gone of [garbage, staleWriting]) {
      expect(present(gone.path)).to.eq(false);
      expect(await rows('upload_blobs', { id: gone.id })).to.deep.equal([]);
    }
    for (const kept of [freshWriting, live]) {
      expect(present(kept.path)).to.eq(true);
      expect(await rows('upload_blobs', { id: kept.id })).to.have.length(1);
    }
  });

  it('does not remove a writing blob that went live after it was read', async () => {
    const s = await insertSessionRow();
    const late = await object(s, { state: 'writing', updated_at: DateTime.utc().minus({ hours: 1 }) });
    const read = store.sweepableBlobs.bind(store);
    sinon.stub(store, 'sweepableBlobs').callsFake(async (state, before, page) => {
      const found = await read(state, before, page);
      if (state === 'writing') for (const b of found) await store.setBlobState(b.id, 'writing', 'live', DateTime.utc());
      return found;
    });

    expect(await sweeper.sweep()).to.deep.equal(nothing);
    expect(present(late.path)).to.eq(true);
    expect((await rows('upload_blobs', { id: late.id }))[0].state).to.eq('live');
  });

  it('keeps the row when an rm fails, warns with the uploadId, and removes it on the next run', async () => {
    const s = await insertSessionRow();
    const garbage = await object(s, { state: 'garbage' });
    sinon.stub(getFs('upload-temp'), 'rm').rejects(new Error('disk busy'));

    expect(await sweeper.sweep()).to.deep.equal({ ...nothing, keptBlobs: 1 });
    expect(await rows('upload_blobs', { id: garbage.id })).to.have.length(1);
    expect(uploadLogs(LogLevel.Warn).map((l) => [l.Variables.uploadId, l.Variables.key])).to.deep.equal([[s, garbage.key]]);

    sinon.restore();
    expect(await sweeper.sweep()).to.deep.equal({ ...nothing, removedBlobs: 1 });
    expect(await rows('upload_blobs', { id: garbage.id })).to.deep.equal([]);
    expect(present(garbage.path)).to.eq(false);
  });

  it('reads in batches of upload.sweeper.batch and reads a row it could not remove once per run', async () => {
    await withBatch(2);
    const due = DateTime.utc().minus({ seconds: 1 });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await insertSessionRow({ expires_at: due }));
    ids.sort();
    const reads = sinon.spy(store, 'openExpiredBy');

    expect((await sweeper.sweep()).expired).to.eq(5);
    expect(reads.args.map((a) => a[1])).to.deep.equal([
      { after: '', limit: 2 },
      { after: ids[1], limit: 2 },
      { after: ids[3], limit: 2 },
    ]);

    sinon.restore();
    await withBatch(1);
    const s = await insertSessionRow();
    await object(s, { state: 'garbage' });
    await object(s, { state: 'garbage' });
    sinon.stub(getFs('upload-temp'), 'rm').rejects(new Error('disk busy'));
    const garbageReads = sinon.spy(store, 'sweepableBlobs');
    expect((await sweeper.sweep()).keptBlobs).to.eq(2);
    expect(garbageReads.args.filter((a) => a[0] === 'garbage')).to.have.length(3);
  });

  it('logs an unexpected failure at error with its uploadId and goes on with the others', async () => {
    const due = DateTime.utc().minus({ seconds: 1 });
    const bad = await insertSessionRow({ expires_at: due });
    const good = await insertSessionRow({ expires_at: due });
    const expire = service.expire.bind(service);
    sinon.stub(service, 'expire').callsFake(async (session) => {
      if (session.id === bad) throw new Error('db hiccup');
      return expire(session);
    });

    expect(await sweeper.sweep()).to.deep.equal({ ...nothing, expired: 1, errors: 1 });
    expect((await sessionRow(good)).status).to.eq('expired');
    expect((await sessionRow(bad)).status).to.eq('open');
    expect(uploadLogs(LogLevel.Error).map((l) => l.Variables.uploadId)).to.deep.equal([bad]);
  });

  it('stops before the next batch once the signal is aborted', async () => {
    await insertSessionRow({ expires_at: DateTime.utc().minus({ seconds: 1 }) });
    const controller = new AbortController();
    controller.abort();
    const reads = sinon.spy(store, 'openExpiredBy');

    expect(await sweeper.sweep({ signal: controller.signal })).to.deep.equal(nothing);
    expect(reads.callCount).to.eq(0);
  });

  it('logs the run summary at info with every count', async () => {
    await insertSessionRow({ expires_at: DateTime.utc().minus({ seconds: 1 }) });
    await sweeper.sweep();
    const summary = uploadLogs(LogLevel.Info).filter((l) => String(l.Variables.message).startsWith('Upload sweep:'));
    expect(summary).to.have.length(1);
    expect(summary[0].Variables).to.include({ expired: 1, released: 0, reemitted: 0, purged: 0, removedBlobs: 0, keptBlobs: 0, errors: 0 });
  });
  it("purges a completed session's parts after retainFinished, and keeps its row and file", async () => {
    const session = await completed();
    const young = await completed();
    await setSession(session.id, { updated_at: longAgo() });
    CaptureQueueClient.reset();

    expect(await sweeper.sweep()).to.deep.equal({ ...nothing, purged: 1, removedBlobs: 3 });

    expect(await rows('upload_parts', { session_id: session.id })).to.deep.equal([]);
    expect((await rows('upload_blobs', { session_id: session.id })).map((b) => [b.kind, b.state])).to.deep.equal([['file', 'live']]);
    expect(present(pathIn('temp', `uploads/${session.id}`))).to.eq(false);
    expect(present(pathIn('files', String(session.file_key)))).to.eq(true);
    expect(await sessionRow(session.id)).to.include({ status: 'completed', file_key: session.file_key });
    expect(emitted('UploadPurged').map((e) => [String(e.UploadId), Number(e.Blobs)])).to.deep.equal([[session.id, 3]]);
    expect(await rows('upload_parts', { session_id: young.id })).to.have.length(3);

    CaptureQueueClient.reset();
    expect(await sweeper.sweep()).to.deep.equal(nothing);
    expect(emittedNames()).to.deep.equal([]);
  });

  it('purges failed, aborted and expired sessions whole after retainFinished', async () => {
    const failed = await open(service, file, { sha256: sha256hex(text(10, 1)) });
    await putAll(service, failed, file);
    expect((await uploadErrorOf(service.complete(failed))).code).to.eq('upload.file_digest_mismatch');
    const aborted = await open(service, file);
    await put(service, aborted, file, 1);
    await service.abort(aborted);
    const expired = await open(service, file);
    await put(service, expired, file, 1);
    await setSession(expired.id, { expires_at: DateTime.utc().minus({ seconds: 1 }) });
    // Expired outside a sweep, so its parts are still there.
    expect(await service.expire(expired)).to.eq(true);
    const stray = await object(aborted.id, { state: 'writing', updated_at: DateTime.utc() });
    for (const id of [failed.id, aborted.id, expired.id]) await setSession(id, { updated_at: longAgo() });
    CaptureQueueClient.reset();

    expect(await sweeper.sweep()).to.deep.equal({ ...nothing, purged: 3, removedBlobs: 2 });

    for (const id of [failed.id, aborted.id, expired.id]) {
      expect(await rows('upload_sessions', { id })).to.deep.equal([]);
      expect(await rows('upload_parts', { session_id: id })).to.deep.equal([]);
      expect(await rows('upload_blobs', { session_id: id })).to.deep.equal([]);
      expect(present(pathIn('temp', `uploads/${id}`))).to.eq(false);
    }
    expect(present(stray.path)).to.eq(false);
    expect(emitted('UploadPurged').map((e) => String(e.UploadId)).sort()).to.deep.equal([failed.id, aborted.id, expired.id].sort());
    expect(uploadLogs(LogLevel.Info).filter((l) => String(l.Variables.message).endsWith('purged')).map((l) => l.Variables.uploadId)).to.have.members([failed.id, aborted.id, expired.id]);
  });

  it('keeps the merged file when the app put it under the session prefix', async () => {
    const session = await open(service, file);
    await putAll(service, session, file);
    await service.complete(session, {}, { fileDir: `uploads/${session.id}/merged` });
    const done = await service.get(session.id);
    expect(String(done.file_key).startsWith(`uploads/${session.id}/merged/`)).to.eq(true);
    await setSession(session.id, { updated_at: longAgo() });
    const rm = sinon.spy(getFs('upload-temp'), 'rm');

    expect((await sweeper.sweep()).purged).to.eq(1);
    expect(rm.args.map((a) => a[0])).to.not.include(`uploads/${session.id}`);
    expect(present(pathIn('files', String(done.file_key)))).to.eq(true);
  });

  it('skips the purge while the final event is owed, re-emits it, and purges once it is delivered', async () => {
    const session = await open(service, file);
    await put(service, session, file, 1);
    CaptureQueueClient.FailNames.add('UploadAborted');
    await service.abort(session);
    expect((await sessionRow(session.id)).final_event_at).to.eq(null);
    await setSession(session.id, { updated_at: longAgo() });

    expect(await sweeper.sweep()).to.deep.equal(nothing);
    expect(await sessionRow(session.id)).to.include({ status: 'aborted', final_event_at: null });
    expect(uploadLogs(LogLevel.Warn).filter((l) => l.Variables.uploadId === session.id && String(l.Variables.message).includes('final event'))).to.have.length(2);

    CaptureQueueClient.reset();
    CaptureLogTarget.reset();
    expect(await sweeper.sweep()).to.deep.equal({ ...nothing, reemitted: 1, purged: 1 });
    expect(emittedNames()).to.deep.equal(['UploadAborted', 'UploadPurged']);
    expect(uploadLogs(LogLevel.Warn).map((l) => [l.Variables.uploadId, l.Variables.event])).to.deep.equal([[session.id, 'UploadAborted']]);
    expect(await rows('upload_sessions', { id: session.id })).to.deep.equal([]);
  });

  it('re-emits an owed UploadCompleted once upload.assembly.staleAfter passed, and stamps final_event_at', async () => {
    CaptureQueueClient.FailNames.add('UploadCompleted');
    const session = await completed();
    CaptureQueueClient.reset();

    // Made final just now: its own emit may still be in flight.
    expect(await sweeper.sweep()).to.deep.equal(nothing);
    await setSession(session.id, { updated_at: DateTime.utc().minus({ hours: 1 }) });
    expect(await sweeper.sweep()).to.deep.equal({ ...nothing, reemitted: 1 });
    expect(emitted('UploadCompleted').map((e) => [String(e.UploadId), String(e.FileKey)])).to.deep.equal([[session.id, String(session.file_key)]]);
    expect((await sessionRow(session.id)).final_event_at).to.not.eq(null);
    expect(await sweeper.sweep()).to.deep.equal(nothing);
  });

  it('keeps a purged session until every object of it is gone', async () => {
    const session = await open(service, file);
    await put(service, session, file, 1);
    await service.abort(session);
    const stuck = await object(session.id, { state: 'garbage' });
    await setSession(session.id, { updated_at: longAgo() });
    sinon.stub(getFs('upload-temp'), 'rm').rejects(new Error('disk busy'));

    // Tried once as a leftover and once by the purge.
    expect(await sweeper.sweep()).to.deep.equal({ ...nothing, keptBlobs: 2 });
    expect(await rows('upload_sessions', { id: session.id })).to.have.length(1);

    sinon.restore();
    CaptureQueueClient.reset();
    expect(await sweeper.sweep()).to.deep.equal({ ...nothing, removedBlobs: 1, purged: 1 });
    expect(await rows('upload_sessions', { id: session.id })).to.deep.equal([]);
    expect(present(stuck.path)).to.eq(false);
    expect(emitted('UploadPurged').map((e) => Number(e.Blobs))).to.deep.equal([0]);
  });

  it('leaves a purge that another sweep won to that sweep', async () => {
    const done = await completed();
    const aborted = await open(service, file);
    await service.abort(aborted);
    for (const id of [done.id, aborted.id]) await setSession(id, { updated_at: longAgo() });
    // The other sweep dropped the part rows and deleted the session between this sweep's read and its change.
    sinon.stub(store, 'dropParts').resolves(false);
    sinon.stub(store, 'deleteFinishedSession').resolves(false);
    CaptureQueueClient.reset();

    expect((await sweeper.sweep()).purged).to.eq(0);
    expect(emitted('UploadPurged')).to.deep.equal([]);
  });

  it('two sweeps at once emit each expiry and purge once', async () => {
    const due = await open(service, file);
    await put(service, due, file, 1);
    await setSession(due.id, { expires_at: DateTime.utc().minus({ seconds: 1 }) });
    const old = await open(service, file);
    await service.abort(old);
    await setSession(old.id, { updated_at: longAgo() });
    const done = await completed();
    await setSession(done.id, { updated_at: longAgo() });
    CaptureQueueClient.reset();

    const [a, b] = await Promise.all([sweeper.sweep(), sweeper.sweep()]);

    expect(a.expired + b.expired).to.eq(1);
    expect(a.purged + b.purged).to.eq(2);
    expect(emittedNames().filter((n) => n === 'UploadExpired')).to.have.length(1);
    expect(emittedNames().filter((n) => n === 'UploadPurged')).to.have.length(2);
    expect(await sweeper.sweep()).to.deep.equal(nothing);
  });

  it('never hands a session that is not terminal to the purge, even an old delivered one', async () => {
    const live = await open(service, file);
    await put(service, live, file, 1);
    await setSession(live.id, { updated_at: longAgo(), final_event_at: longAgo() });
    const finished = await open(service, file);
    await service.abort(finished);
    await setSession(finished.id, { updated_at: longAgo() });
    const dropParts = sinon.spy(store, 'dropParts');
    const abandonBlobs = sinon.spy(store, 'abandonBlobs');

    expect((await sweeper.sweep()).purged).to.eq(1);

    expect(dropParts.args.map((a) => a[0])).to.not.include(live.id);
    expect(abandonBlobs.args.map((a) => a[0])).to.not.include(live.id);
    expect(await sessionRow(live.id)).to.include({ status: 'open' });
    expect(await rows('upload_parts', { session_id: live.id })).to.have.length(1);
    expect((await rows('upload_blobs', { session_id: live.id })).map((b) => b.state)).to.deep.equal(['live']);
  });
});
