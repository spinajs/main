import 'mocha';
import { expect } from 'chai';
import { DateTime } from 'luxon';
import sinon from 'sinon';
import { LogLevel } from '@spinajs/log';

import type { UploadService } from '../src/index.js';
import { emitted, uploadLogs } from './support/capture.js';
import { objectsOf, resetUploads, rows, setSession, uploadEnv } from './support/env.js';
import { open, put, text, uploadErrorOf } from './support/flow.js';
import { StrictFs } from './support/strict-fs.js';

describe('UploadService.abort and expire', () => {
  let service: UploadService;
  const file = text(10);
  const sessionRow = async (id: string) => (await rows('upload_sessions', { id }))[0];

  before(async () => {
    ({ service } = await uploadEnv());
  });
  beforeEach(resetUploads);
  afterEach(() => {
    sinon.restore();
    expect(StrictFs.Banned).to.deep.equal([]);
  });

  it('aborts an open session, removes its parts and emits UploadAborted once', async () => {
    const session = await open(service, file, { owner: 'alice' });
    await put(service, session, file, 1);
    await put(service, session, file, 2);

    expect(await service.abort(session)).to.eq(true);

    const row = await sessionRow(session.id);
    expect(row).to.include({ status: 'aborted', final_event: 'UploadAborted' });
    expect(row.final_event_at).to.not.eq(null);
    expect(await rows('upload_parts', { session_id: session.id })).to.deep.equal([]);
    expect(await rows('upload_blobs', { session_id: session.id })).to.deep.equal([]);
    expect(objectsOf('temp', `uploads/${session.id}`)).to.deep.equal([]);
    expect(emitted('UploadAborted').map((e) => [String(e.UploadId), String(e.Owner)])).to.deep.equal([[session.id, 'alice']]);

    expect(await service.abort(session)).to.eq(false);
    expect(emitted('UploadAborted')).to.have.length(1);
    expect((await uploadErrorOf(put(service, session, file, 3))).code).to.eq('upload.not_open');
  });

  it('still emits the final event and reports true when dropping the parts fails after the abort committed', async () => {
    const session = await open(service, file, { owner: 'alice' });
    await put(service, session, file, 1);
    const store = (service as unknown as { Store: { transaction: () => Promise<unknown> } }).Store;
    sinon.stub(store, 'transaction').rejects(new Error('db gone'));

    expect(await service.abort(session)).to.eq(true);

    expect(await sessionRow(session.id)).to.include({ status: 'aborted', final_event: 'UploadAborted' });
    expect(emitted('UploadAborted')).to.have.length(1);
    expect(uploadLogs(LogLevel.Warn).map((l) => l.Variables.uploadId)).to.include(session.id);
  });

  it('never aborts an assembly in progress, nor a session that is no longer open', async () => {
    const assembling = await open(service, file);
    await setSession(assembling.id, { status: 'assembling', claim_token: 't', claimed_at: DateTime.utc() });
    const busy = await uploadErrorOf(service.abort(assembling));
    expect([busy.code, busy.status]).to.deep.equal(['upload.assembling', 409]);

    const completed = await open(service, file);
    await setSession(completed.id, { status: 'completed' });
    expect((await uploadErrorOf(service.abort(completed))).code).to.eq('upload.not_open');
    expect(emitted('UploadAborted')).to.deep.equal([]);
  });

  it('expires an open session past expires_at, and nothing else', async () => {
    const fresh = await open(service, file);
    expect(await service.expire(fresh)).to.eq(false);

    const past = await open(service, file);
    await setSession(past.id, { expires_at: DateTime.utc().minus({ seconds: 1 }) });
    expect(await service.expire(past)).to.eq(true);
    expect(await sessionRow(past.id)).to.include({ status: 'expired', final_event: 'UploadExpired' });
    expect(emitted('UploadExpired').map((e) => String(e.UploadId))).to.deep.equal([past.id]);

    expect(await service.expire(past)).to.eq(false);
  });
});
