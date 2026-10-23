import 'mocha';
import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import { LogLevel } from '@spinajs/log';
import { OrmException } from '@spinajs/orm';
import { DateTime } from 'luxon';
import sinon from 'sinon';

import type { UploadStore } from '../src/index.js';
import { uploadLogs } from './support/capture.js';
import { insertSessionRow, resetUploads, rows, uploadEnv } from './support/env.js';
import { rejection } from './support/flow.js';

describe('UploadStore transitions', () => {
  let store: UploadStore;
  const row = async (id: string) => (await rows('upload_sessions', { id }))[0];
  const staleAfter = (now: DateTime) => now.minus({ minutes: 30 });

  before(async () => {
    ({ store } = await uploadEnv());
  });
  beforeEach(resetUploads);

  it('touchOpen matches only an open session that has not expired', async () => {
    const now = DateTime.utc();
    const open = await insertSessionRow();
    const aborted = await insertSessionRow({ status: 'aborted' });
    const expired = await insertSessionRow({ expires_at: now.minus({ seconds: 1 }) });
    expect(await store.touchOpen(open, now)).to.eq(true);
    expect(await store.touchOpen(aborted, now)).to.eq(false);
    expect(await store.touchOpen(expired, now)).to.eq(false);
  });

  it('claim takes an open session or a stale claim, never a fresh one; release needs the token', async () => {
    const now = DateTime.utc();
    const id = await insertSessionRow();
    const other = await insertSessionRow({ status: 'assembling', claim_token: 'x', claimed_at: now.minus({ hours: 1 }) });
    expect(await store.claim(id, 't1', now, staleAfter(now), 'a'.repeat(64))).to.eq(true);
    expect(await store.touchOpen(id, now)).to.eq(false);
    expect(await store.claim(id, 't2', now, staleAfter(now), null)).to.eq(false);
    // A staleBefore after claimed_at makes the held claim stale.
    expect(await store.claim(id, 't2', now, now.plus({ minutes: 1 }), null)).to.eq(true);
    expect(await store.release(id, 't1', now)).to.eq(false);
    expect(await store.release(id, 't2', now)).to.eq(true);
    expect(await row(id)).to.include({ status: 'open', claim_token: null, claimed_at: null, declared_sha256: 'a'.repeat(64) });
    expect(await row(other)).to.include({ status: 'assembling', claim_token: 'x' });
  });

  it('complete and fail need the claim token and record the final event owed', async () => {
    const now = DateTime.utc();
    const done = await insertSessionRow();
    await store.claim(done, 't', now, staleAfter(now), null);
    const values = { sha256: 'f'.repeat(64), file_key: 'uploads/files/x.txt', detected_mime: null };
    expect(await store.complete(done, 'other', values, now)).to.eq(false);
    expect(await store.complete(done, 't', values, now)).to.eq(true);
    expect(await row(done)).to.include({ status: 'completed', sha256: 'f'.repeat(64), file_key: 'uploads/files/x.txt', claim_token: null, final_event: 'UploadCompleted', final_event_at: null });

    const failed = await insertSessionRow();
    await store.claim(failed, 't', now, staleAfter(now), null);
    expect(await store.fail(failed, 'other', 'upload.size_mismatch', 'short', now)).to.eq(false);
    expect(await store.fail(failed, 't', 'upload.size_mismatch', 'short', now)).to.eq(true);
    expect(await row(failed)).to.include({ status: 'failed', failure_code: 'upload.size_mismatch', failure_message: 'short', claim_token: null, claimed_at: null, final_event: 'UploadFailed' });
  });

  it('abort matches only an open session; expire only an open one past expires_at', async () => {
    const now = DateTime.utc();
    const open = await insertSessionRow();
    const assembling = await insertSessionRow({ status: 'assembling' });
    expect(await store.abort(assembling, now)).to.eq(false);
    expect(await store.abort(open, now)).to.eq(true);
    expect(await row(open)).to.include({ status: 'aborted', final_event: 'UploadAborted' });

    const fresh = await insertSessionRow();
    const past = await insertSessionRow({ expires_at: now.minus({ seconds: 1 }) });
    expect(await store.expire(fresh, now)).to.eq(false);
    expect(await store.expire(past, now)).to.eq(true);
    expect(await row(past)).to.include({ status: 'expired', final_event: 'UploadExpired' });

    const boundary = await insertSessionRow({ expires_at: now });
    expect(await store.expire(boundary, now.minus({ milliseconds: 1 }))).to.eq(false);
    expect(await store.expire(boundary, now)).to.eq(true);
  });

  it('markFinalEmitted stamps the owed event once; markHandled stamps once; both report who won', async () => {
    const id = await insertSessionRow({ status: 'aborted', final_event: 'UploadAborted' });
    const earlier = DateTime.utc().minus({ minutes: 5 });
    expect(await store.markFinalEmitted(id, 'UploadCompleted', earlier)).to.eq(false);
    expect((await row(id)).final_event_at).to.eq(null);
    expect(await store.markFinalEmitted(id, 'UploadAborted', earlier)).to.eq(true);
    const stamped = (await row(id)).final_event_at;
    expect(stamped).to.not.eq(null);
    expect(await store.markFinalEmitted(id, 'UploadAborted', DateTime.utc())).to.eq(false);
    expect((await row(id)).final_event_at).to.eq(stamped);

    expect((await row(id)).handled_at).to.eq(null);
    expect(await store.markHandled(id, earlier)).to.eq(true);
    const handled = (await row(id)).handled_at;
    expect(handled).to.not.eq(null);
    expect(await store.markHandled(id, DateTime.utc())).to.eq(false);
    expect((await row(id)).handled_at).to.eq(handled);
  });

  it('upserts one part row per (session_id, number) and deletes a part only with its key', async () => {
    const now = DateTime.utc();
    const id = await insertSessionRow();
    await store.upsertPart({ session_id: id, number: 1, size: 4, sha256: 'a'.repeat(64), storage_key: 'k1', detected_mime: 'text/plain', received_at: now });
    await store.upsertPart({ session_id: id, number: 1, size: 4, sha256: 'b'.repeat(64), storage_key: 'k2', detected_mime: null, received_at: now });
    expect((await store.listParts(id)).map((p) => [p.number, p.storage_key, p.sha256, p.detected_mime])).to.deep.equal([[1, 'k2', 'b'.repeat(64), null]]);
    await store.deleteParts(id, [{ number: 1, storage_key: 'k1' }]);
    expect(await store.listParts(id)).to.have.length(1);
    await store.deleteParts(id, [{ number: 1, storage_key: 'k2' }]);
    expect(await store.findPart(id, 1)).to.eq(undefined);
  });

  it('moves only the live blobs of one kind to garbage', async () => {
    const now = DateTime.utc();
    const id = await insertSessionRow();
    await store.insertBlob({ id: 'p-live', session_id: id, fs: 'upload-temp', key: 'k1', kind: 'part' }, now);
    await store.insertBlob({ id: 'p-writing', session_id: id, fs: 'upload-temp', key: 'k2', kind: 'part' }, now);
    await store.insertBlob({ id: 'f-live', session_id: id, fs: 'upload-files', key: 'f1', kind: 'file' }, now);
    await store.setBlobState('p-live', 'writing', 'live', now);
    await store.setBlobState('f-live', 'writing', 'live', now);
    await store.setSessionBlobsState(id, 'part', 'garbage', now);
    const states = Object.fromEntries((await rows('upload_blobs', { session_id: id })).map((b) => [b.id, b.state]));
    expect(states).to.deep.equal({ 'p-live': 'garbage', 'p-writing': 'writing', 'f-live': 'live' });
    await store.setBlobStateByKey(id, 'upload-files', 'f1', 'live', 'garbage', now);
    expect((await store.listBlobs(id, 'garbage')).map((b) => b.id).sort()).to.deep.equal(['f-live', 'p-live']);
    await store.deleteBlob('p-live');
    expect((await store.listBlobs(id, 'garbage')).map((b) => b.id)).to.deep.equal(['f-live']);
  });

  it('moves a blob only from the allowed states, and reports whether it moved', async () => {
    const now = DateTime.utc();
    const id = await insertSessionRow();
    await store.insertBlob({ id: 'b1', session_id: id, fs: 'upload-temp', key: 'k1', kind: 'part' }, now);
    await store.insertBlob({ id: 'b2', session_id: id, fs: 'upload-temp', key: 'k2', kind: 'part' }, now);
    const state = async (blob: string) => (await rows('upload_blobs', { id: blob }))[0]?.state;

    expect(await store.setBlobState('b1', 'writing', 'live', now)).to.eq(true);
    expect(await store.setBlobState('b1', 'writing', 'live', now)).to.eq(false);
    expect(await store.setBlobState('b1', ['writing', 'live'], 'garbage', now)).to.eq(true);
    expect(await store.setBlobState('b1', 'writing', 'live', now)).to.eq(false);
    expect(await state('b1')).to.eq('garbage');
    expect(await store.setBlobState('missing', 'writing', 'live', now)).to.eq(false);

    expect(await store.setBlobStateByKey(id, 'upload-temp', 'k2', 'live', 'garbage', now)).to.eq(false);
    expect(await state('b2')).to.eq('writing');
    expect(await store.setBlobStateByKey(id, 'upload-temp', 'k2', 'writing', 'live', now)).to.eq(true);
    await store.setSessionBlobsState(id, 'part', 'garbage', now);
    expect(await store.setBlobStateByKey(id, 'upload-temp', 'k2', 'writing', 'live', now)).to.eq(false);
    expect(await state('b2')).to.eq('garbage');
  });

  it('finds a session scoped to its owner and counts the open sessions of an owner', async () => {
    const id = await insertSessionRow({ owner: 'alice' });
    await insertSessionRow({ owner: 'alice', status: 'completed' });
    expect((await store.findSession(id, 'alice'))?.id).to.eq(id);
    expect(await store.findSession(id, 'bob')).to.eq(undefined);
    expect((await store.findSession(id))?.id).to.eq(id);
    expect(await store.openSessionsOf('alice')).to.eq(1);
    expect(await store.openSessionsOf('bob')).to.eq(0);
  });
});

describe('UploadStore.insertSessionWithinCap on a lock conflict', () => {
  let store: UploadStore;
  const newRow = (owner = 'alice') => {
    const now = DateTime.utc();
    return { id: randomUUID(), owner, name: 'notes.txt', size: 10, part_size: 4, part_count: 3, declared_sha256: null, declared_mime: 'text/plain', metadata: {}, temp_fs: 'upload-temp', files_fs: 'upload-files', created_at: now, expires_at: now.plus({ hours: 1 }) };
  };
  // Shaped as the drivers surface them: an OrmException whose inner error is the native one.
  const driverError = (native: { readonly message?: string; readonly errno?: number; readonly code?: string }) =>
    new OrmException('Error executing orm command ', undefined, 'UPDATE upload_sessions', [], Object.assign(new Error(native.message ?? 'driver error'), native));
  const lockOwnerOf = () => sinon.stub(store as unknown as { lockOwner(owner: string): Promise<void> }, 'lockOwner').callThrough();

  before(async () => {
    ({ store } = await uploadEnv());
  });
  beforeEach(resetUploads);
  afterEach(() => sinon.restore());

  for (const [label, native] of [
    ['a MySQL deadlock (1213)', { errno: 1213, code: 'ER_LOCK_DEADLOCK', message: 'Deadlock found when trying to get lock' }],
    ['a MySQL lock wait timeout (1205)', { errno: 1205, code: 'ER_LOCK_WAIT_TIMEOUT', message: 'Lock wait timeout exceeded' }],
    ['a Postgres serialization failure (40001)', { code: '40001', message: 'could not serialize access' }],
    ['a Postgres deadlock (40P01)', { code: '40P01', message: 'deadlock detected' }],
  ] as const) {
    it(`retries the cap transaction once after ${label}, and logs the owner`, async () => {
      const lockOwner = lockOwnerOf();
      lockOwner.onFirstCall().rejects(driverError(native));
      const row = newRow();

      expect(await store.insertSessionWithinCap(row, 3)).to.eq(true);

      expect(lockOwner.callCount).to.eq(2);
      expect(await rows('upload_sessions', { id: row.id })).to.have.length(1);
      const warned = uploadLogs(LogLevel.Warn).filter((e) => /lock conflict/.test(String(e.Variables.message)));
      expect(warned).to.have.length(1);
      expect(warned[0].Variables).to.include({ owner: 'alice' }).and.not.have.property('uploadId');
    });
  }

  it('gives up after the second lock conflict', async () => {
    const lockOwner = lockOwnerOf();
    lockOwner.rejects(driverError({ errno: 1213, code: 'ER_LOCK_DEADLOCK' }));
    const row = newRow();

    const e = await rejection(store.insertSessionWithinCap(row, 3));

    expect(e).to.be.instanceOf(OrmException);
    expect(lockOwner.callCount).to.eq(2);
    expect(await rows('upload_sessions', { id: row.id })).to.deep.equal([]);
  });

  it('does not retry any other driver error', async () => {
    const lockOwner = lockOwnerOf();
    lockOwner.onFirstCall().rejects(driverError({ errno: 1062, code: 'ER_DUP_ENTRY', message: 'Duplicate entry' }));

    expect(await rejection(store.insertSessionWithinCap(newRow(), 3))).to.be.instanceOf(OrmException);
    expect(lockOwner.callCount).to.eq(1);
  });

  it("does not retry inside a caller's transaction, which the conflict already rolled back", async () => {
    const lockOwner = lockOwnerOf();
    lockOwner.onFirstCall().rejects(driverError({ code: '40P01' }));

    expect(await rejection(store.transaction(() => store.insertSessionWithinCap(newRow(), 3)))).to.be.instanceOf(OrmException);
    expect(lockOwner.callCount).to.eq(1);
  });
});
