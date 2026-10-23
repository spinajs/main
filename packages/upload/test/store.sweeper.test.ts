import 'mocha';
import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';

import type { UploadStore } from '../src/index.js';
import { insertSessionRow, resetUploads, rows, uploadEnv } from './support/env.js';

describe('UploadStore sweeper statements', () => {
  let store: UploadStore;
  const now = () => DateTime.utc();
  const page = (limit = 10, after = '') => ({ after, limit });
  const ids = (list: { id: string }[]) => list.map((r) => r.id);
  const sorted = (...list: string[]) => [...list].sort();

  async function blob(sessionId: string, values: Record<string, unknown> = {}): Promise<string> {
    const { driver } = await uploadEnv();
    const id = typeof values.id === 'string' ? values.id : randomUUID();
    const at = now();
    await driver
      .insert()
      .into('upload_blobs')
      .values({ id, session_id: sessionId, fs: 'upload-temp', key: `uploads/${sessionId}/${id}`, kind: 'part', state: 'live', created_at: at, updated_at: at, ...values });
    return id;
  }

  async function part(sessionId: string, number: number): Promise<void> {
    const { driver } = await uploadEnv();
    await driver.insert().into('upload_parts').values({ session_id: sessionId, number, size: 4, sha256: 'a'.repeat(64), storage_key: `uploads/${sessionId}/${number}`, received_at: now() });
  }

  before(async () => {
    ({ store } = await uploadEnv());
  });
  beforeEach(resetUploads);

  it('openExpiredBy reads open sessions with expires_at <= now, in id pages', async () => {
    const t = now();
    const a = await insertSessionRow({ expires_at: t.minus({ seconds: 1 }) });
    const b = await insertSessionRow({ expires_at: t });
    await insertSessionRow({ expires_at: t.plus({ seconds: 1 }) });
    await insertSessionRow({ status: 'aborted', expires_at: t.minus({ hours: 1 }) });

    expect(ids(await store.openExpiredBy(t, page()))).to.deep.equal(sorted(a, b));
    const [first] = sorted(a, b);
    expect(ids(await store.openExpiredBy(t, page(1)))).to.deep.equal([first]);
    expect(ids(await store.openExpiredBy(t, page(10, first)))).to.deep.equal(sorted(a, b).slice(1));
  });

  it('staleClaims reads assembling sessions claimed before staleBefore', async () => {
    const t = now();
    const stale = await insertSessionRow({ status: 'assembling', claim_token: 's', claimed_at: t.minus({ hours: 1 }) });
    await insertSessionRow({ status: 'assembling', claim_token: 'f', claimed_at: t });
    await insertSessionRow({ status: 'open', claimed_at: t.minus({ hours: 1 }) });
    expect(ids(await store.staleClaims(t.minus({ minutes: 30 }), page()))).to.deep.equal([stale]);
  });

  it('owedFinalEvents reads sessions made final before a time whose final_event_at is null', async () => {
    const t = now();
    const owed = await insertSessionRow({ status: 'aborted', final_event: 'UploadAborted', updated_at: t.minus({ hours: 1 }) });
    await insertSessionRow({ status: 'aborted', final_event: 'UploadAborted', updated_at: t });
    await insertSessionRow({ status: 'aborted', final_event: 'UploadAborted', updated_at: t.minus({ hours: 1 }), final_event_at: t });
    await insertSessionRow({ updated_at: t.minus({ hours: 1 }) });
    expect(ids(await store.owedFinalEvents(t.minus({ minutes: 30 }), page()))).to.deep.equal([owed]);
  });

  it('retainedCompleted reads delivered completed sessions older than the cutoff that still have part rows', async () => {
    const t = now();
    const old = t.minus({ days: 8 });
    const due = await insertSessionRow({ status: 'completed', updated_at: old, final_event: 'UploadCompleted', final_event_at: old });
    // Already purged: no part rows left.
    await insertSessionRow({ status: 'completed', updated_at: old, final_event: 'UploadCompleted', final_event_at: old });
    const owed = await insertSessionRow({ status: 'completed', updated_at: old, final_event: 'UploadCompleted' });
    const young = await insertSessionRow({ status: 'completed', updated_at: t, final_event: 'UploadCompleted', final_event_at: t });
    for (const id of [due, owed, young]) await part(id, 1);
    expect(ids(await store.retainedCompleted(t.minus({ days: 7 }), page()))).to.deep.equal([due]);
  });

  it('retainedFinished reads delivered failed, aborted and expired sessions older than the cutoff', async () => {
    const t = now();
    const old = t.minus({ days: 8 });
    const delivered = { updated_at: old, final_event_at: old };
    const failed = await insertSessionRow({ status: 'failed', final_event: 'UploadFailed', ...delivered });
    const aborted = await insertSessionRow({ status: 'aborted', final_event: 'UploadAborted', ...delivered });
    const expired = await insertSessionRow({ status: 'expired', final_event: 'UploadExpired', ...delivered });
    await insertSessionRow({ status: 'completed', final_event: 'UploadCompleted', ...delivered });
    await insertSessionRow({ status: 'aborted', final_event: 'UploadAborted', updated_at: old });
    await insertSessionRow({ status: 'aborted', final_event: 'UploadAborted', updated_at: t, final_event_at: t });
    expect(ids(await store.retainedFinished(t.minus({ days: 7 }), page()))).to.deep.equal(sorted(failed, aborted, expired));
  });

  it('sweepableBlobs reads one state, optionally only rows updated before a time', async () => {
    const t = now();
    const s = await insertSessionRow();
    const garbage = await blob(s, { state: 'garbage', updated_at: t });
    const staleWriting = await blob(s, { state: 'writing', updated_at: t.minus({ hours: 1 }) });
    await blob(s, { state: 'writing', updated_at: t });
    await blob(s, { state: 'live', updated_at: t.minus({ hours: 1 }) });
    expect(ids(await store.sweepableBlobs('garbage', null, page()))).to.deep.equal([garbage]);
    expect(ids(await store.sweepableBlobs('writing', t.minus({ minutes: 30 }), page()))).to.deep.equal([staleWriting]);
  });

  it('dropParts turns live part blobs into garbage and deletes the part rows, once', async () => {
    const t = now();
    const s = await insertSessionRow();
    await part(s, 1);
    const live = await blob(s);
    const writing = await blob(s, { state: 'writing' });
    const file = await blob(s, { kind: 'file' });
    expect(await store.dropParts(s, t)).to.eq(true);
    expect(await rows('upload_parts', { session_id: s })).to.deep.equal([]);
    const states = Object.fromEntries((await rows('upload_blobs', { session_id: s })).map((b) => [b.id, b.state]));
    expect(states).to.deep.equal({ [live]: 'garbage', [writing]: 'writing', [file]: 'live' });
    expect(await store.dropParts(s, t)).to.eq(false);
  });

  it('abandonBlobs turns every writing and live blob of the session into garbage', async () => {
    const t = now();
    const s = await insertSessionRow();
    const other = await insertSessionRow();
    await blob(s, { state: 'writing' });
    await blob(s, { kind: 'file' });
    const untouched = await blob(other);
    expect(await store.abandonBlobs(s, t)).to.eq(true);
    expect((await rows('upload_blobs', { session_id: s })).map((b) => b.state)).to.deep.equal(['garbage', 'garbage']);
    expect((await rows('upload_blobs', { id: untouched }))[0].state).to.eq('live');
    expect(await store.abandonBlobs(s, t)).to.eq(false);
  });

  it('deleteFinishedSession deletes only a delivered failed, aborted or expired session', async () => {
    const t = now();
    const aborted = await insertSessionRow({ status: 'aborted', final_event: 'UploadAborted', final_event_at: t });
    const owed = await insertSessionRow({ status: 'aborted', final_event: 'UploadAborted' });
    const completed = await insertSessionRow({ status: 'completed', final_event: 'UploadCompleted', final_event_at: t });
    const open = await insertSessionRow();
    expect(await store.deleteFinishedSession(aborted)).to.eq(true);
    expect(await store.deleteFinishedSession(aborted)).to.eq(false);
    for (const id of [owed, completed, open]) expect(await store.deleteFinishedSession(id)).to.eq(false);
    expect((await rows('upload_sessions')).map((r) => r.id)).to.have.members([owed, completed, open]);
  });
});
