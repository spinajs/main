import 'mocha';
import { expect } from 'chai';
import { InvalidConfiguration } from '@spinajs/configuration';
import { InvalidArgument } from '@spinajs/exceptions';
import { ActionHook, ActionRefused } from '@spinajs/hooks';
import type { ActionPattern, BeforeContext } from '@spinajs/hooks';
import { DateTime } from 'luxon';

import { UploadError } from '../src/index.js';
import type { CreateUploadInput, UploadService } from '../src/index.js';
import { CaptureQueueClient, emitted } from './support/capture.js';
import { resetUploads, rows, setSession, uploadEnv } from './support/env.js';
import { rejection, sha256hex, text, uploadErrorOf, withHook } from './support/flow.js';

class CreateHook extends ActionHook<'upload.create'> {
  public readonly actions: readonly ActionPattern[] = ['upload.create'];

  constructor(private readonly onBefore: (ctx: BeforeContext<'upload.create'>) => void | Promise<void>) {
    super();
  }

  public before(ctx: BeforeContext<'upload.create'>): void | Promise<void> {
    return this.onBefore(ctx);
  }
}

describe('UploadService.create, get and state', () => {
  let service: UploadService;
  const file = text(10);
  const input = (more: Partial<CreateUploadInput> = {}): CreateUploadInput => ({ name: 'notes.txt', size: 10, sha256: sha256hex(file), ...more });

  before(async () => {
    ({ service } = await uploadEnv());
  });
  beforeEach(resetUploads);

  it('opens a session and answers its view', async () => {
    const before = DateTime.utc();
    const view = await service.create(input({ owner: 'alice', metadata: { projectId: 'p1' } }));

    expect(view).to.deep.include({ status: 'open', name: 'notes.txt', size: 10, partSize: 4, partCount: 3, receivedParts: [], missingParts: [1, 2, 3], offset: 0 });
    expect(DateTime.fromISO(view.expiresAt).diff(before).as('hours')).to.be.within(23.99, 24.01);
    const [row] = await rows('upload_sessions', { id: view.id });
    expect(row).to.include({ owner: 'alice', declared_sha256: sha256hex(file), declared_mime: 'text/plain', temp_fs: 'upload-temp', files_fs: 'upload-files', status: 'open' });
    expect(JSON.parse(row.metadata as string)).to.deep.equal({ projectId: 'p1' });
    expect(emitted('UploadCreated')[0]).to.include({ UploadId: view.id, Owner: 'alice', FileName: 'notes.txt', PartSize: 4, PartCount: 3, DeclaredMime: 'text/plain', DeclaredSha256: sha256hex(file) });
    expect(CaptureQueueClient.Captured.map((c) => c.inTransaction)).to.deep.equal([false]);
  });

  it('takes the declared MIME type from the name, never from the input', async () => {
    const view = await service.create({ ...input({ name: 'drawing.dwg' }), declaredMime: 'text/plain' } as CreateUploadInput);
    expect((await rows('upload_sessions', { id: view.id }))[0].declared_mime).to.eq('image/vnd.dwg');
  });

  it('refuses a file over maxFileSize with upload.too_large', async () => {
    const e = await uploadErrorOf(service.create(input({ size: 2000 })));
    expect([e.code, e.status]).to.deep.equal(['upload.too_large', 400]);
  });

  it('refuses a part size outside min..max, or one that needs more than maxParts parts, with upload.part_size', async () => {
    for (const more of [{ size: 100, partSize: 65 }, { size: 1000, partSize: 1 }, { size: 100, partSize: 0 }]) {
      expect((await uploadErrorOf(service.create(input(more)))).code, JSON.stringify(more)).to.eq('upload.part_size');
    }
  });

  it('lets the controller only tighten the limits', async () => {
    expect((await uploadErrorOf(service.create(input({ limits: { maxFileSize: 5 } })))).code).to.eq('upload.too_large');
    expect((await uploadErrorOf(service.create(input({ size: 2000, limits: { maxFileSize: 5000 } })))).code).to.eq('upload.too_large');
    const view = await service.create(input({ limits: { partSize: 5, sessionTtl: '1h' } }));
    expect([view.partSize, view.partCount]).to.deep.equal([5, 2]);
    expect(DateTime.fromISO(view.expiresAt).diffNow().as('minutes')).to.be.within(59, 61);
  });

  it('refuses a controller sessionTtl of zero, which would open an expired session', async () => {
    expect(await rejection(service.create(input({ limits: { sessionTtl: '0s' } })))).to.be.instanceOf(InvalidArgument);
    expect(await rows('upload_sessions')).to.deep.equal([]);
  });

  it('caps the open sessions of one owner with upload.too_many_sessions (429)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await service.create(input({ owner: 'alice' }))).id);
    const e = await uploadErrorOf(service.create(input({ owner: 'alice' })));
    expect([e.code, e.status]).to.deep.equal(['upload.too_many_sessions', 429]);
    await service.create(input({ owner: 'bob' }));
    await service.create(input());
    await setSession(ids[0], { status: 'aborted' });
    await service.create(input({ owner: 'alice' }));
  });

  it('holds the owner cap under concurrent creates', async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => service.create(input({ owner: 'alice' }))));
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).to.have.length(3);
    expect(refused.map((r) => (r.reason instanceof UploadError ? r.reason.code : String(r.reason)))).to.deep.equal(Array(3).fill('upload.too_many_sessions'));
    expect(await rows('upload_sessions', { owner: 'alice', status: 'open' })).to.have.length(3);
  });

  it('rechecks the owner cap after the upload.create hook ran', async () => {
    await service.create(input({ owner: 'alice' }));
    await service.create(input({ owner: 'alice' }));
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const hook = new CreateHook(async () => {
      if (++entered === 2) release();
      await gate;
    });
    const results = await withHook(hook, () => Promise.allSettled([service.create(input({ owner: 'alice' })), service.create(input({ owner: 'alice' }))]));
    expect(results.map((r) => (r.status === 'fulfilled' ? 'created' : r.reason instanceof UploadError ? r.reason.code : String(r.reason))).sort()).to.deep.equal(['created', 'upload.too_many_sessions']);
    expect(await rows('upload_sessions', { owner: 'alice', status: 'open' })).to.have.length(3);
  });

  it('refuses a name without a known MIME type unless allowed, and a declared type outside allowedTypes', async () => {
    const unknown = await uploadErrorOf(service.create(input({ name: 'blob.unknownext' })));
    expect([unknown.code, unknown.status]).to.deep.equal(['upload.unsupported_type', 400]);
    const allowed = await service.create(input({ name: 'blob.unknownext', allowUnknownType: true }));
    expect((await rows('upload_sessions', { id: allowed.id }))[0].declared_mime).to.eq(null);
    const outside = await uploadErrorOf(service.create(input({ allowedTypes: ['image/png'] })));
    expect([outside.code, outside.status]).to.deep.equal(['upload.unsupported_type', 415]);
    await service.create(input({ allowedTypes: ['text/plain'] }));
  });

  it('refuses an empty file with upload.invalid (400)', async () => {
    const e = await uploadErrorOf(service.create(input({ size: 0 })));
    expect([e.code, e.status]).to.deep.equal(['upload.invalid', 400]);
  });

  it('refuses malformed input with upload.invalid', async () => {
    const bad: Partial<CreateUploadInput>[] = [
      { name: '' },
      { name: '   ' },
      { name: 'x'.repeat(252) + '.txt' },
      { size: 0 },
      { size: -4 },
      { size: 1.5 },
      { size: Number.NaN },
      { size: Number.MAX_SAFE_INTEGER + 1 },
      { size: '10' as unknown as number },
      { sha256: 'xyz' },
      { sha256: 'a'.repeat(63) },
      { metadata: [] as unknown as Record<string, unknown> },
      { metadata: null as unknown as Record<string, unknown> },
      { owner: 7 as unknown as string },
    ];
    for (const more of bad) {
      expect((await uploadErrorOf(service.create(input(more)))).code, JSON.stringify(more)).to.eq('upload.invalid');
    }
    expect(await rows('upload_sessions')).to.deep.equal([]);
  });

  it('refuses a provider that fs.providers does not define', async () => {
    expect(await rejection(service.create(input({ fs: { temp: 'no-such-fs' } })))).to.be.instanceOf(InvalidConfiguration);
  });

  it('lets an upload.create hook refuse the session or change its metadata', async () => {
    const refused = await withHook(
      new CreateHook((ctx) => ctx.refuse('upload.quota', 'quota exceeded')),
      () => rejection(service.create(input())),
    );
    expect(refused).to.be.instanceOf(ActionRefused).and.include({ code: 'upload.quota' });
    expect(await rows('upload_sessions')).to.deep.equal([]);

    const view = await withHook(
      new CreateHook((ctx) => {
        ctx.input.metadata = { ...ctx.input.metadata, stamped: true };
      }),
      () => service.create(input({ metadata: { projectId: 'p1' } })),
    );
    expect(JSON.parse((await rows('upload_sessions', { id: view.id }))[0].metadata as string)).to.deep.equal({ projectId: 'p1', stamped: true });
  });

  it('finds a session by id, scoped to its owner when one is given', async () => {
    const view = await service.create(input({ owner: 'alice' }));
    expect((await service.get(view.id, 'alice')).id).to.eq(view.id);
    expect((await service.get(view.id)).id).to.eq(view.id);
    expect((await service.get(view.id, null)).id).to.eq(view.id);
    const other = await uploadErrorOf(service.get(view.id, 'bob'));
    expect([other.code, other.status]).to.deep.equal(['upload.not_found', 404]);
    expect((await uploadErrorOf(service.get('no-such-id'))).code).to.eq('upload.not_found');
    expect((await service.state(await service.get(view.id))).id).to.eq(view.id);
  });
});
