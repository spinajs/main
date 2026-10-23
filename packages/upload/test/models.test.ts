import 'mocha';
import { expect } from 'chai';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Int64ValueConverter } from '@spinajs/orm';
import { DateTime } from 'luxon';

import { UploadBlob, UploadPart, UploadSession, toStateView } from '../src/index.js';
import { insertSessionRow, raw, resetUploads, uploadEnv } from './support/env.js';

describe('upload tables, models and the state view', () => {
  before(() => uploadEnv());
  beforeEach(resetUploads);

  const columns = async (table: string) => (await raw(`PRAGMA table_info(${table})`)).map((c) => c.name);

  it('creates the three tables with the columns of spec §6.1', async () => {
    expect(await columns('upload_sessions')).to.have.members([
      'id', 'owner', 'name', 'size', 'part_size', 'part_count', 'declared_sha256', 'declared_mime', 'detected_mime', 'status', 'metadata', 'temp_fs', 'files_fs',
      'file_key', 'sha256', 'claim_token', 'claimed_at', 'failure_code', 'failure_message', 'created_at', 'updated_at', 'expires_at', 'completed_at', 'handled_at',
      'final_event', 'final_event_at',
    ]);
    expect(await columns('upload_parts')).to.have.members(['session_id', 'number', 'size', 'sha256', 'storage_key', 'detected_mime', 'received_at']);
    expect(await columns('upload_blobs')).to.have.members(['id', 'session_id', 'fs', 'key', 'kind', 'state', 'created_at', 'updated_at']);
  });

  it('keys parts by (session_id, number) and declares the cascade from their session', async () => {
    const pk = (await raw('PRAGMA table_info(upload_parts)')).filter((c) => Number(c.pk) > 0).map((c) => c.name);
    expect(pk).to.have.members(['session_id', 'number']);
    for (const table of ['upload_parts', 'upload_blobs']) {
      const keys = (await raw(`PRAGMA foreign_key_list(${table})`)).map((k) => [k.table, k.from, k.to, k.on_delete]);
      expect(keys, table).to.deep.equal([['upload_sessions', 'session_id', 'id', 'CASCADE']]);
    }
  });

  it('creates the indexes of spec §6.1', async () => {
    const indexColumns = async (index: string) => (await raw(`PRAGMA index_info(${index})`)).map((c) => c.name);
    expect(await indexColumns('upload_sessions_status_expires')).to.deep.equal(['status', 'expires_at']);
    expect(await indexColumns('upload_sessions_owner_status')).to.deep.equal(['owner', 'status']);
    expect(await indexColumns('upload_sessions_final_event')).to.deep.equal(['final_event', 'final_event_at']);
    expect(await indexColumns('upload_blobs_state_updated')).to.deep.equal(['state', 'updated_at']);
    expect(await indexColumns('upload_blobs_session')).to.deep.equal(['session_id']);
  });

  it('reads sessions through the model with its converters, and filters them with the scopes', async () => {
    const now = DateTime.utc();
    await insertSessionRow({ id: 's-1', owner: 'alice', expires_at: now.minus({ hours: 1 }), metadata: { projectId: 'p1' }, size: 3_000_000_000, part_size: 8_388_608, part_count: 358 });
    await insertSessionRow({ id: 's-2', owner: 'alice', status: 'aborted' });
    await insertSessionRow({ id: 's-3', owner: 'bob' });

    const open = await UploadSession.query().ofOwner('alice').open();
    expect(open.map((s) => s.id)).to.deep.equal(['s-1']);
    const [s1] = open;
    expect(s1.metadata).to.deep.equal({ projectId: 'p1' });
    expect(s1.size).to.eq(3_000_000_000);
    expect(UploadSession.getModelDescriptor().Converters.get('part_size')?.Class).to.eq(Int64ValueConverter);
    expect(DateTime.isDateTime(s1.expires_at)).to.eq(true);
    expect(s1.claimed_at).to.eq(null);

    expect((await UploadSession.query().ofOwner(null).open()).map((s) => s.id).sort()).to.deep.equal(['s-1', 's-3']);
    expect((await UploadSession.query().open().expiredBefore(now)).map((s) => s.id)).to.deep.equal(['s-1']);
    const edge = await insertSessionRow({ id: 's-edge', expires_at: now });
    expect((await UploadSession.query().open().expiredBefore(now)).map((s) => s.id).sort()).to.deep.equal(['s-1', edge]);
  });

  it('scopes parts and blobs, and builds the resume view of spec §3', async () => {
    const { store } = await uploadEnv();
    const now = DateTime.utc();
    const id = await insertSessionRow();
    await store.upsertPart({ session_id: id, number: 3, size: 2, sha256: 'c'.repeat(64), storage_key: 'k3', detected_mime: null, received_at: now });
    await store.upsertPart({ session_id: id, number: 1, size: 4, sha256: 'a'.repeat(64), storage_key: 'k1', detected_mime: 'text/plain', received_at: now });
    await store.insertBlob({ id: 'b-1', session_id: id, fs: 'upload-temp', key: 'k1', kind: 'part' }, now);
    await store.insertBlob({ id: 'b-2', session_id: id, fs: 'upload-temp', key: 'k9', kind: 'part' }, now);
    await store.setBlobState('b-2', 'writing', 'garbage', now);

    expect((await UploadPart.query().ofSession(id)).map((p) => p.number).sort()).to.deep.equal([1, 3]);
    expect((await UploadBlob.query().ofSession(id).inState('garbage')).map((b) => b.id)).to.deep.equal(['b-2']);
    expect((await UploadBlob.query().inState('writing').updatedBefore(now.plus({ minutes: 1 }))).map((b) => b.id)).to.deep.equal(['b-1']);

    const session = await store.requireSession(id);
    expect(toStateView(session, await store.listParts(id))).to.deep.equal({
      id,
      status: 'open',
      name: 'notes.txt',
      size: 10,
      partSize: 4,
      partCount: 3,
      receivedParts: [
        { number: 1, size: 4, sha256: 'a'.repeat(64) },
        { number: 3, size: 2, sha256: 'c'.repeat(64) },
      ],
      missingParts: [2],
      offset: 4,
      expiresAt: new Date(session.expires_at.toMillis()).toISOString(),
      mime: 'text/plain',
    });
  });

  it('shows the sha256 of a completed session only, and the failure of a failed one', async () => {
    const { store } = await uploadEnv();
    const done = await store.requireSession(await insertSessionRow({ status: 'completed', sha256: 'f'.repeat(64), detected_mime: 'image/png' }));
    expect(toStateView(done, [])).to.include({ sha256: 'f'.repeat(64), mime: 'image/png' });
    const failed = await store.requireSession(await insertSessionRow({ status: 'failed', sha256: 'f'.repeat(64), failure_code: 'upload.size_mismatch', failure_message: 'short' }));
    const view = toStateView(failed, []);
    expect(view).to.not.have.property('sha256');
    expect(view.failure).to.deep.equal({ code: 'upload.size_mismatch', message: 'short' });
  });

  it('boots with the schema defaults the test config leaves out', async () => {
    const cfg = await DI.resolve(Configuration);
    expect(cfg.get('upload.detect.headBytes')).to.eq(4100);
    expect(cfg.get('upload.integrity')).to.deep.equal({ partDigest: 'required', fileDigest: 'required' });
    expect(cfg.get('upload.limits.sessionTtl')).to.eq('24h');
    expect(cfg.get('db.Aliases.upload')).to.eq('default');
  });
});
