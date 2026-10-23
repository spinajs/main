import 'mocha';
import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { PassThrough } from 'node:stream';

import type { UploadService } from '../src/index.js';
import { emitted } from './support/capture.js';
import { objectsOf, pathIn, resetUploads, rows, uploadEnv } from './support/env.js';
import { bodyOf, chunk, open, putAll, sha256hex, sha256raw, text, uploadErrorOf } from './support/flow.js';
import { StrictFs } from './support/strict-fs.js';

/**
 * SQLite runs transactions one at a time (orm-sqlite/src/index.ts:296) and holds outside statements until the open one
 * ends (orm-sqlite/src/index.ts:133-155), so these races are serialised here. The Postgres row lock they rely on is
 * proved by test/spikes/row-lock.test.ts.
 */
describe('upload races', () => {
  let service: UploadService;

  before(async () => {
    ({ service } = await uploadEnv());
  });
  beforeEach(resetUploads);
  afterEach(() => {
    expect(StrictFs.Banned).to.deep.equal([]);
  });

  it('two concurrent writes of one part: each streams to its own key, the last commit wins, the other copy is removed', async () => {
    const file = text(10);
    const session = await open(service, file);
    const a = Buffer.from('aaaa');
    const b = Buffer.from('bbbb');

    await Promise.all([service.putPart(session, 1, bodyOf(a), sha256raw(a), 4), service.putPart(session, 1, bodyOf(b), sha256raw(b), 4)]);

    const [row] = await rows('upload_parts', { session_id: session.id, number: 1 });
    expect([sha256hex(a), sha256hex(b)]).to.include(row.sha256);
    const winner = row.sha256 === sha256hex(a) ? a : b;
    expect(readFileSync(pathIn('temp', row.storage_key as string))).to.deep.equal(winner);
    expect((await rows('upload_blobs', { session_id: session.id })).map((x) => [x.key, x.state])).to.deep.equal([[row.storage_key, 'live']]);
    expect(objectsOf('temp', `uploads/${session.id}`)).to.deep.equal([basename(row.storage_key as string)]);
    expect(emitted('UploadPartStored').map((e) => e.Replaced as boolean).sort()).to.deep.equal([false, true]);
  });

  it('a resend that commits after the complete claim is refused with upload.not_open and leaves nothing behind', async () => {
    const file = text(10);
    const session = await open(service, file);
    await putAll(service, session, file);
    const original = chunk(session, file, 1);
    const body = new PassThrough();
    const resend = service.putPart(session, 1, body, sha256raw(original), 4);

    const view = await service.complete(session);
    body.end(original);
    const e = await uploadErrorOf(resend);

    expect([view.status, e.code]).to.deep.equal(['completed', 'upload.not_open']);
    expect((await rows('upload_blobs', { session_id: session.id, kind: 'part' })).map((x) => x.state)).to.deep.equal(['live', 'live', 'live']);
    expect(objectsOf('temp', `uploads/${session.id}`)).to.have.length(3);
    const [row] = await rows('upload_sessions', { id: session.id });
    expect(readFileSync(pathIn('files', row.file_key as string))).to.deep.equal(file);
  });

  it('two concurrent completes: one assembles; the other answers the completed view or upload.assembling', async () => {
    const file = text(10);
    const session = await open(service, file);
    await putAll(service, session, file);

    const results = await Promise.allSettled([service.complete(session), service.complete(session)]);

    expect(results.filter((r) => r.status === 'fulfilled')).to.have.length.of.at.least(1);
    for (const r of results) {
      if (r.status === 'fulfilled') expect(r.value.status).to.eq('completed');
      else expect(r.reason).to.include({ code: 'upload.assembling' });
    }
    expect(emitted('UploadCompleted')).to.have.length(1);
    expect(await rows('upload_blobs', { session_id: session.id, kind: 'file' })).to.have.length(1);
  });
});
