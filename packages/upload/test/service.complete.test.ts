import 'mocha';
import { expect } from 'chai';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { DI } from '@spinajs/di';
import { ActionHook, ActionRefused } from '@spinajs/hooks';
import type { ActionPattern, BeforeContext } from '@spinajs/hooks';
import { LogLevel } from '@spinajs/log';
import { DateTime } from 'luxon';
import sinon from 'sinon';

import { UploadStorage } from '../src/index.js';
import type { UploadService, UploadSession, UploadStore } from '../src/index.js';
import { emitted, emittedNames, uploadLogs } from './support/capture.js';
import { objectsOf, pathIn, resetUploads, rows, setSession, uploadEnv } from './support/env.js';
import { open, put, putAll, rejection, sha256hex, text, uploadErrorOf, withHook } from './support/flow.js';
import { StrictFs } from './support/strict-fs.js';

class CompleteHook extends ActionHook<'upload.complete'> {
  public readonly actions: readonly ActionPattern[] = ['upload.complete'];

  constructor(private readonly onBefore: (ctx: BeforeContext<'upload.complete'>) => void) {
    super();
  }

  public before(ctx: BeforeContext<'upload.complete'>): void {
    this.onBefore(ctx);
  }
}

describe('UploadService.complete', () => {
  let service: UploadService;
  let store: UploadStore;
  let storage: UploadStorage;
  const file = text(10);
  const sessionRow = async (id: string) => (await rows('upload_sessions', { id }))[0];

  /** A session with every part of `file` stored. */
  async function uploaded(input: Parameters<typeof open>[2] = {}): Promise<UploadSession> {
    const session = await open(service, file, input);
    await putAll(service, session, file);
    return session;
  }

  before(async () => {
    ({ service, store } = await uploadEnv());
    storage = await DI.resolve(UploadStorage);
  });
  beforeEach(resetUploads);
  afterEach(() => {
    sinon.restore();
    expect(StrictFs.Banned).to.deep.equal([]);
  });

  it('assembles the parts into the files provider, verifies the file and answers the completed view', async () => {
    const session = await uploaded();
    const view = await service.complete(session);

    expect(view).to.deep.include({ status: 'completed', sha256: sha256hex(file), offset: 10, missingParts: [] });
    const row = await sessionRow(session.id);
    expect(row).to.include({ status: 'completed', sha256: sha256hex(file), claim_token: null, final_event: 'UploadCompleted' });
    expect(row.file_key).to.match(/^uploads\/files\/[0-9a-f-]{36}\.txt$/);
    expect(row.final_event_at).to.not.eq(null);
    expect(row.handled_at).to.not.eq(null);
    expect(readFileSync(pathIn('files', row.file_key as string))).to.deep.equal(file);
    expect((await rows('upload_blobs', { session_id: session.id, kind: 'file' })).map((b) => [b.key, b.state])).to.deep.equal([[row.file_key, 'live']]);
    expect(emitted('UploadCompleted')[0]).to.include({ UploadId: session.id, Sha256: sha256hex(file), Mime: 'text/plain', FileKey: row.file_key });
    expect(emittedNames().slice(-2)).to.deep.equal(['UploadAssemblyStarted', 'UploadCompleted']);
  });

  it('puts the merged file under options.fileDir', async () => {
    const session = await uploaded();
    await service.complete(session, {}, { fileDir: 'projects/p1/files' });
    expect((await sessionRow(session.id)).file_key).to.match(/^projects\/p1\/files\/[0-9a-f-]{36}\.txt$/);
  });

  it('takes the file sha256 from the complete body when create had none, and requires one by default', async () => {
    const session = await uploaded({ sha256: undefined });
    const e = await uploadErrorOf(service.complete(session));
    expect([e.code, e.status]).to.deep.equal(['upload.file_digest_required', 400]);
    expect((await sessionRow(session.id)).status).to.eq('open');

    const view = await service.complete(session, { sha256: sha256hex(file).toUpperCase() });
    expect(view.sha256).to.eq(sha256hex(file));
    expect((await sessionRow(session.id)).declared_sha256).to.eq(sha256hex(file));
  });

  it('refuses a body sha256 that differs from the declared one, and leaves the session as it is', async () => {
    const session = await uploaded();
    const e = await uploadErrorOf(service.complete(session, { sha256: sha256hex(text(10, 3)) }));
    expect(e.code).to.eq('upload.file_digest_mismatch');
    expect(await sessionRow(session.id)).to.include({ status: 'open', claim_token: null });
  });

  it('answers upload.parts_missing (409) with the missing parts and opens the session again', async () => {
    const session = await open(service, file);
    await put(service, session, file, 1);
    await put(service, session, file, 3);
    const e = await uploadErrorOf(service.complete(session));
    expect([e.code, e.status, e.details.parts]).to.deep.equal(['upload.parts_missing', 409, [2]]);
    expect(await sessionRow(session.id)).to.include({ status: 'open', claim_token: null });
    expect(emitted('UploadAssemblyReleased')[0]).to.include({ Reason: 'error' });
  });

  it('reopens the session when a stored part changed, drops only that part, and completes once it is sent again', async () => {
    const session = await uploaded();
    const [part2] = await rows('upload_parts', { session_id: session.id, number: 2 });
    writeFileSync(pathIn('temp', part2.storage_key as string), 'zzzz');

    const e = await uploadErrorOf(service.complete(session));

    expect([e.code, e.status, e.details.parts]).to.deep.equal(['upload.part_corrupted', 409, [2]]);
    expect(await sessionRow(session.id)).to.include({ status: 'open', claim_token: null });
    expect((await rows('upload_parts', { session_id: session.id })).map((p) => p.number).sort()).to.deep.equal([1, 3]);
    expect(existsSync(pathIn('temp', part2.storage_key as string))).to.eq(false);
    expect(objectsOf('files', 'uploads/files')).to.deep.equal([]);
    expect(await rows('upload_blobs', { session_id: session.id, kind: 'file' })).to.deep.equal([]);
    expect(emitted('UploadPartCorrupted')[0]).to.include({ UploadId: session.id }).and.have.deep.property('Parts', [2]);
    expect(emitted('UploadAssemblyReleased')).to.deep.equal([]);

    await put(service, session, file, 2);
    expect((await service.complete(session)).status).to.eq('completed');
  });

  it('fails the session on a file hash mismatch: parts and objects removed, UploadFailed emitted', async () => {
    const session = await uploaded({ sha256: sha256hex(text(10, 3)) });
    const e = await uploadErrorOf(service.complete(session));

    expect([e.code, e.status]).to.deep.equal(['upload.file_digest_mismatch', 400]);
    const row = await sessionRow(session.id);
    expect(row).to.include({ status: 'failed', failure_code: 'upload.file_digest_mismatch', claim_token: null, final_event: 'UploadFailed' });
    expect(row.final_event_at).to.not.eq(null);
    expect(await rows('upload_parts', { session_id: session.id })).to.deep.equal([]);
    expect(await rows('upload_blobs', { session_id: session.id })).to.deep.equal([]);
    expect(objectsOf('temp', `uploads/${session.id}`)).to.deep.equal([]);
    expect(objectsOf('files', 'uploads/files')).to.deep.equal([]);
    expect(emitted('UploadFailed')[0]).to.include({ Code: 'upload.file_digest_mismatch' });
    expect((await service.state(session)).failure).to.deep.equal({ code: 'upload.file_digest_mismatch', message: 'the assembled file does not match the declared sha256' });
    expect((await uploadErrorOf(put(service, session, file, 1))).code).to.eq('upload.not_open');
  });

  it('fails the session on a size mismatch', async () => {
    const session = await uploaded();
    const assemble = storage.assemble.bind(storage);
    sinon.stub(storage, 'assemble').callsFake(async (...args: Parameters<UploadStorage['assemble']>) => {
      const assembled = await assemble(...args);
      return { ...assembled, size: assembled.size - 1 };
    });
    const e = await uploadErrorOf(service.complete(session));
    expect(e.code).to.eq('upload.size_mismatch');
    expect(await sessionRow(session.id)).to.include({ status: 'failed', failure_code: 'upload.size_mismatch' });
  });

  it('answers upload.file_lost (409) when the assembled file is reclaimed before the commit, and keeps the parts for a retry', async () => {
    const session = await uploaded();
    const assemble = storage.assemble.bind(storage);
    const stub = sinon.stub(storage, 'assemble').callsFake(async (...args: Parameters<UploadStorage['assemble']>) => {
      const assembled = await assemble(...args);
      await store.setBlobState(assembled.blobId, 'writing', 'garbage', DateTime.utc());
      return assembled;
    });

    const e = await uploadErrorOf(service.complete(session));

    expect([e.code, e.status]).to.deep.equal(['upload.file_lost', 409]);
    expect(await sessionRow(session.id)).to.include({ status: 'open', claim_token: null, file_key: null, final_event: null });
    expect((await rows('upload_parts', { session_id: session.id })).map((p) => p.number).sort()).to.deep.equal([1, 2, 3]);
    expect(await rows('upload_blobs', { session_id: session.id, kind: 'file' })).to.deep.equal([]);
    expect(objectsOf('files', 'uploads/files')).to.deep.equal([]);
    expect(emitted('UploadCompleted')).to.deep.equal([]);
    expect(emitted('UploadAssemblyReleased')[0]).to.include({ Reason: 'error' });

    stub.restore();
    expect((await service.complete(session)).status).to.eq('completed');
  });

  it('returns the same view when called again, and runs the completion handler until it has succeeded once', async () => {
    const session = await uploaded();
    let calls = 0;
    const onCompleted = async (completed: UploadSession) => {
      calls++;
      if (completed.status !== 'completed') throw new Error(`handler saw ${completed.status}`);
      if (calls === 1) throw new Error('handler down');
      return 'assigned';
    };

    expect(await rejection(service.complete(session, {}, { onCompleted }))).to.have.property('message', 'handler down');
    expect(await sessionRow(session.id)).to.include({ status: 'completed', handled_at: null });

    const second = await service.complete(session, {}, { onCompleted });
    expect(calls).to.eq(2);
    expect((await sessionRow(session.id)).handled_at).to.not.eq(null);

    const third = await service.complete(session, {}, { onCompleted });
    expect(calls).to.eq(2);
    expect(third).to.deep.equal(second);
    expect(emitted('UploadCompleted')).to.have.length(1);
  });

  it('lets a before hook of upload.complete hold the completion back until it passes', async () => {
    const session = await uploaded();
    const refused = await withHook(
      new CompleteHook((ctx) => ctx.refuse('upload.not_assigned')),
      () => rejection(service.complete(session)),
    );
    expect(refused).to.be.instanceOf(ActionRefused);
    expect(await sessionRow(session.id)).to.include({ status: 'completed', handled_at: null });

    await service.complete(session);
    expect((await sessionRow(session.id)).handled_at).to.not.eq(null);
  });

  it('answers upload.assembling (409) while another request holds a fresh claim', async () => {
    const session = await uploaded();
    await setSession(session.id, { status: 'assembling', claim_token: 'other', claimed_at: DateTime.utc() });
    const e = await uploadErrorOf(service.complete(session));
    expect([e.code, e.status]).to.deep.equal(['upload.assembling', 409]);
  });

  it('takes over a stale claim, reports it, and completes', async () => {
    const session = await uploaded();
    await setSession(session.id, { status: 'assembling', claim_token: 'crashed', claimed_at: DateTime.utc().minus({ hours: 1 }) });
    expect((await service.complete(session)).status).to.eq('completed');
    expect(emitted('UploadAssemblyReleased')[0]).to.include({ Reason: 'stale' });
    expect(uploadLogs(LogLevel.Warn).some((l) => /stale claim/.test(String(l.Variables.message)))).to.eq(true);
  });

  it('refuses a session that is aborted, failed or expired with upload.not_open', async () => {
    for (const status of ['aborted', 'failed', 'expired']) {
      const session = await uploaded();
      await setSession(session.id, { status });
      expect((await uploadErrorOf(service.complete(session))).code, status).to.eq('upload.not_open');
    }
  });

  it('releases the claim and logs an error when the assembly fails unexpectedly', async () => {
    const session = await uploaded();
    sinon.stub(storage, 'assemble').rejects(new Error('disk on fire'));
    expect(await rejection(service.complete(session))).to.have.property('message', 'disk on fire');
    expect(await sessionRow(session.id)).to.include({ status: 'open', claim_token: null });
    expect(emitted('UploadAssemblyReleased')[0]).to.include({ Reason: 'error' });
    expect(uploadLogs(LogLevel.Error).map((l) => l.Variables.uploadId)).to.deep.equal([session.id]);
  });
});
