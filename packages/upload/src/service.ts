import { randomUUID } from 'node:crypto';
import { Config } from '@spinajs/configuration';
import { Autoinject, DI, Injectable, Singleton } from '@spinajs/di';
import { Hooks } from '@spinajs/hooks';
import { Log, Logger } from '@spinajs/log';
import { DateTime } from 'luxon';

import { ContentTypeCheck, allowsType } from './content/check.js';
import type { ContentCheckResult } from './content/check.js';
import { parsePositiveDuration } from './duration.js';
import { UploadError, isUploadError } from './errors.js';
import { UploadEvents } from './events/emitter.js';
import { UploadAssemblyReleased, UploadAssemblyStarted, UploadContentChecked, UploadCreated, UploadPartCorrupted, UploadPartRejected, UploadPartStored } from './events/events.js';
import type { UploadCompleteHookInput, UploadCreateHookInput } from './hooks.js';
import { effectiveLimits, planParts } from './limits.js';
import type { UploadPart } from './models/UploadPart.js';
import type { UploadSession } from './models/UploadSession.js';
import { expectedPartSize, missingParts } from './parts.js';
import { UploadStorage, assertFsProviders } from './storage.js';
import type { AssembledFile, WrittenPart } from './storage.js';
import { UploadStore } from './store.js';
import type { NewSessionRow } from './store.js';
import type { AllowedTypes, CompleteInput, CreateUploadInput, PartStoredView, PutPartOptions, UploadConfig, UploadLimits, UploadStateView } from './types.js';
import { isoOf, toStateView } from './view.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;

const SHA256_BYTES = 32;

const MAX_NAME_LENGTH = 255;

const invalid = (message: string): UploadError => new UploadError('upload.invalid', message);

function assertMetadata(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid('metadata must be an object');
}

function assertName(name: unknown): void {
  if (typeof name !== 'string' || name.trim() === '' || name.length > MAX_NAME_LENGTH) throw invalid(`name must be 1 to ${MAX_NAME_LENGTH} characters`);
}

function assertFileInput(input: CreateUploadInput): void {
  assertName(input.name);
  if (!Number.isSafeInteger(input.size) || input.size < 1) throw invalid('size must be a positive integer');
  if (input.sha256 !== undefined && (typeof input.sha256 !== 'string' || !SHA256_HEX.test(input.sha256.toLowerCase()))) throw invalid('sha256 must be 64 hex characters');
  if (input.metadata !== undefined) assertMetadata(input.metadata);
  if (input.owner !== undefined && input.owner !== null && typeof input.owner !== 'string') throw invalid('owner must be a string or null');
}

interface SessionPlan {
  readonly name: string;
  readonly size: number;
  readonly sha256: string | null;
  readonly partSize: number;
  readonly partCount: number;
  readonly declaredMime: string | null;
  readonly owner: string | null;
  readonly metadata: Record<string, unknown>;
  readonly tempFs: string;
  readonly filesFs: string;
  readonly ttlMs: number;
  readonly maxOpenSessions: number;
}

const hookInputOf = (plan: SessionPlan): UploadCreateHookInput => ({
  name: plan.name,
  size: plan.size,
  sha256: plan.sha256,
  partSize: plan.partSize,
  partCount: plan.partCount,
  declaredMime: plan.declaredMime,
  owner: plan.owner,
  metadata: { ...plan.metadata },
});

interface CheckedContent {
  readonly result: ContentCheckResult;
  readonly event: UploadContentChecked;
}

export interface CompleteOptions {
  /** Directory of the merged file on the files provider; default `<upload.fs.prefix>/files`. The key is `<dir>/<uuid><ext>`. */
  readonly fileDir?: string;
  /** Runs once per completed session while handled_at is null; a rejection makes the next complete run it again (spec §5). */
  readonly onCompleted?: (session: UploadSession) => Promise<unknown>;
}

interface FileMismatch {
  readonly code: 'upload.size_mismatch' | 'upload.file_digest_mismatch';
  readonly message: string;
}

const notOpen = (session: UploadSession): UploadError => new UploadError('upload.not_open', `upload ${session.id} is ${session.status}`);

const lostClaim = (id: string): UploadError => new UploadError('upload.assembling', `upload ${id}: another request holds the assembly claim`);

function mismatchOf(session: UploadSession, file: AssembledFile, declared: string | null): FileMismatch | null {
  if (file.size !== session.size) return { code: 'upload.size_mismatch', message: `assembled ${file.size} bytes, declared ${session.size}` };
  if (declared !== null && file.sha256 !== declared) return { code: 'upload.file_digest_mismatch', message: 'the assembled file does not match the declared sha256' };
  return null;
}

const tooManySessions = (cap: number): UploadError => new UploadError('upload.too_many_sessions', `the owner already has ${cap} open uploads`);

/**
 * The upload's domain operations, without HTTP (spec §6.3). A controller looks the session up with get(id, owner),
 * authorizes it, then calls the operation. Every refusal is an UploadError with a stable code (src/errors.ts).
 */
@Singleton()
@Injectable()
export class UploadService {
  @Config('upload')
  protected Options: UploadConfig;

  @Logger('upload')
  protected Log: Log;

  @Autoinject(UploadStore)
  protected Store: UploadStore;

  @Autoinject(UploadStorage)
  protected Storage: UploadStorage;

  @Autoinject(ContentTypeCheck)
  protected Content: ContentTypeCheck;

  @Autoinject(UploadEvents)
  protected Events: UploadEvents;

  public async create(input: CreateUploadInput): Promise<UploadStateView> {
    const plan = this.planSession(input, effectiveLimits(this.Options.limits, input.limits));
    // A cheap early refusal, so a full owner never reaches the hooks; insertSession checks again under the owner lock.
    if (plan.owner !== null && (await this.Store.openSessionsOf(plan.owner)) >= plan.maxOpenSessions) throw tooManySessions(plan.maxOpenSessions);
    const hooks = await DI.resolve<Hooks>(Hooks);
    return hooks.run('upload.create', hookInputOf(plan), (hooked) => this.insertSession(plan, hooked.metadata), { mutable: ['metadata'], refusable: true });
  }

  /** `owner` null or absent: unscoped. A session of another owner answers upload.not_found, like a missing one (spec §6.5). */
  public async get(id: string, owner: string | null = null): Promise<UploadSession> {
    const session = await this.Store.findSession(id, owner);
    if (!session) throw new UploadError('upload.not_found', `upload ${id} not found`);
    return session;
  }

  public async state(session: UploadSession): Promise<UploadStateView> {
    const fresh = await this.Store.requireSession(session.id);
    return toStateView(fresh, await this.Store.listParts(fresh.id));
  }

  /**
   * Spec §4.1. `digest` is the raw sha-256 of the Content-Digest header and `length` the Content-Length; a refusal
   * before the read leaves `body` unread for the caller to drain or close.
   */
  public async putPart(session: UploadSession, part: number, body: NodeJS.ReadableStream, digest: Buffer | undefined, length: number | undefined, options: PutPartOptions = {}): Promise<PartStoredView> {
    try {
      const expected = this.preflightPart(session, part, digest, length);
      const written = await this.receivePart(session, part, body, expected, digest);
      const checked = part === 1 ? await this.checkContent(session, written, options.allowedTypes ?? '*') : undefined;
      const previous = await this.commitPart(session, part, written, checked?.result.detectedMime ?? null);
      return await this.partStored(session, part, written, previous, checked?.event);
    } catch (err) {
      if (isUploadError(err)) await this.partRejected(session, part, err);
      throw err;
    }
  }

  /** Spec §4.2, §5. Safe to call again: a completed session answers its view, and runs the handler while handled_at is null. */
  public async complete(session: UploadSession, input: CompleteInput = {}, options: CompleteOptions = {}): Promise<UploadStateView> {
    const current = await this.Store.requireSession(session.id);
    if (current.status === 'completed') return this.finishCompleted(current, options);
    if (current.status !== 'open' && current.status !== 'assembling') throw notOpen(current);
    if (this.heldByAnother(current)) throw new UploadError('upload.assembling', `upload ${current.id} is being assembled`);
    const declared = this.declaredFileHash(current, input);
    const token = await this.claim(current, declared);
    if (token === null) return this.afterLostClaim(current.id, options);
    let completed: UploadSession;
    try {
      await this.announceClaim(current, token);
      completed = await this.assembleClaimed(current.id, token, declared, options.fileDir ?? `${this.Options.fs.prefix}/files`);
    } catch (err) {
      await this.releaseAfterError(current.id, token, err);
      throw err;
    }
    return this.finishCompleted(completed, options);
  }

  /** Spec §5: open → aborted only; false when the session was already aborted, and an assembly in progress is never aborted. */
  public async abort(session: UploadSession): Promise<boolean> {
    if (!(await this.Store.abort(session.id, DateTime.utc()))) {
      const current = await this.Store.requireSession(session.id);
      if (current.status === 'aborted') return false;
      throw current.status === 'assembling' ? new UploadError('upload.assembling', `upload ${session.id} is being assembled`) : notOpen(current);
    }
    try {
      await this.dropParts(session);
    } catch (err) {
      this.Log.warn({ uploadId: session.id, error: err }, 'Upload ${uploadId}: parts were not removed; the sweeper removes them');
    }
    await this.Events.final(await this.Store.requireSession(session.id));
    this.Log.info({ uploadId: session.id, owner: session.owner }, 'Upload ${uploadId} aborted');
    return true;
  }

  /** open → expired once expires_at passed; the sweeper removes the parts (spec §9). false when the session was not due. */
  public async expire(session: UploadSession): Promise<boolean> {
    if (!(await this.Store.expire(session.id, DateTime.utc()))) return false;
    await this.Events.final(await this.Store.requireSession(session.id));
    this.Log.info({ uploadId: session.id, owner: session.owner }, 'Upload ${uploadId} expired');
    return true;
  }

  private planSession(input: CreateUploadInput, limits: UploadLimits): SessionPlan {
    assertFileInput(input);
    if (input.size > limits.maxFileSize) throw new UploadError('upload.too_large', `${input.size} bytes is over the ${limits.maxFileSize} byte limit`);
    const parts = planParts(input.size, input.partSize, limits);
    return {
      name: input.name,
      size: input.size,
      sha256: input.sha256 === undefined ? null : input.sha256.toLowerCase(),
      ...parts,
      declaredMime: this.declaredMimeOf(input),
      owner: input.owner ?? null,
      metadata: input.metadata ?? {},
      ...this.providersOf(input),
      ttlMs: parsePositiveDuration(limits.sessionTtl, 'upload.limits.sessionTtl'),
      maxOpenSessions: limits.maxOpenSessionsPerOwner,
    };
  }

  /** From the name only (spec §4.3): a client's Content-Type is never trusted. */
  private declaredMimeOf(input: CreateUploadInput): string | null {
    const declared = this.Content.mimeOf(input.name);
    if (declared === null && input.allowUnknownType !== true) throw new UploadError('upload.unsupported_type', `no MIME type is known for ${input.name}`);
    if (declared !== null && !allowsType(input.allowedTypes ?? '*', declared)) throw new UploadError('upload.unsupported_type', `${declared} is not accepted`, {}, 415);
    return declared;
  }

  /** Fixed at create, so a config change never strands an open session (spec §6.1). */
  private providersOf(input: CreateUploadInput): { tempFs: string; filesFs: string } {
    const tempFs = input.fs?.temp ?? this.Options.fs.temp;
    const filesFs = input.fs?.files ?? this.Options.fs.files;
    assertFsProviders([tempFs, filesFs]);
    return { tempFs, filesFs };
  }

  private async insertSession(plan: SessionPlan, metadata: unknown): Promise<UploadStateView> {
    assertMetadata(metadata);
    const now = DateTime.utc();
    const row: NewSessionRow = {
      id: randomUUID(),
      owner: plan.owner,
      name: plan.name,
      size: plan.size,
      part_size: plan.partSize,
      part_count: plan.partCount,
      declared_sha256: plan.sha256,
      declared_mime: plan.declaredMime,
      metadata,
      temp_fs: plan.tempFs,
      files_fs: plan.filesFs,
      created_at: now,
      expires_at: now.plus(plan.ttlMs),
    };
    if (plan.owner === null) await this.Store.insertSession(row);
    else if (!(await this.Store.insertSessionWithinCap({ ...row, owner: plan.owner }, plan.maxOpenSessions))) throw tooManySessions(plan.maxOpenSessions);
    const session = await this.Store.requireSession(row.id);
    await this.Events.stage(
      new UploadCreated(session, { PartSize: plan.partSize, PartCount: plan.partCount, DeclaredMime: plan.declaredMime, ...(plan.sha256 !== null ? { DeclaredSha256: plan.sha256 } : {}), ExpiresAt: isoOf(session.expires_at) }),
    );
    this.Log.info({ uploadId: row.id, owner: plan.owner, size: plan.size, partCount: plan.partCount, metadataKeys: Object.keys(metadata) }, 'Upload ${uploadId} created');
    return toStateView(session, []);
  }

  private preflightPart(session: UploadSession, part: number, digest: Buffer | undefined, length: number | undefined): number {
    if (!Number.isInteger(part) || part < 1 || part > session.part_count) throw new UploadError('upload.part_number', `part ${part} is outside 1..${session.part_count}`);
    if (session.status !== 'open') throw new UploadError('upload.not_open', `upload ${session.id} is ${session.status}`);
    if (session.expires_at.toMillis() <= Date.now()) throw new UploadError('upload.expired', `upload ${session.id} expired`);
    const expected = expectedPartSize(session.size, session.part_size, part);
    if (length === undefined) throw new UploadError('upload.length_required', 'the part length is required');
    if (length !== expected) throw new UploadError('upload.part_size', `part ${part} must be ${expected} bytes, not ${length}`);
    if (digest === undefined && this.Options.integrity.partDigest === 'required') throw new UploadError('upload.digest_required', 'a sha-256 Content-Digest is required');
    // No body of any length hashes to it, so the bytes need not be read to know the answer.
    if (digest !== undefined && digest.length !== SHA256_BYTES) throw new UploadError('upload.part_digest_mismatch', `a sha-256 digest is ${SHA256_BYTES} bytes, not ${digest.length}`);
    return expected;
  }

  private async receivePart(session: UploadSession, part: number, body: NodeJS.ReadableStream, expected: number, digest: Buffer | undefined): Promise<WrittenPart> {
    const declared = digest === undefined ? undefined : digest.toString('hex');
    const written = await this.Storage.writePart(session, part, body, expected, declared);
    let refusal: UploadError | null = null;
    if (written.size !== expected) refusal = new UploadError('upload.part_size', `part ${part} ended after ${written.size} of ${expected} bytes`);
    else if (declared !== undefined && written.sha256 !== declared) refusal = new UploadError('upload.part_digest_mismatch', `part ${part} does not match its Content-Digest`);
    if (refusal !== null) {
      await this.Storage.discard(written.blobId, session.temp_fs, written.key, session.id);
      throw refusal;
    }
    return written;
  }

  private async checkContent(session: UploadSession, written: WrittenPart, allowedTypes: AllowedTypes): Promise<CheckedContent> {
    const result = await this.Content.check({ head: written.head, declaredMime: session.declared_mime, allowedTypes, uploadId: session.id });
    this.Log.debug({ uploadId: session.id, part: 1, detectedMime: result.detectedMime, detectorId: result.detectorId, accepted: result.accepted }, 'Upload ${uploadId} content checked');
    const event = new UploadContentChecked(session, {
      DeclaredMime: session.declared_mime,
      ...(result.detectedMime !== null ? { DetectedMime: result.detectedMime } : {}),
      ...(result.detectorId !== null ? { DetectorId: result.detectorId } : {}),
      Accepted: result.accepted,
    });
    if (!result.accepted) {
      await this.Storage.discard(written.blobId, session.temp_fs, written.key, session.id);
      await this.Events.stage(event);
      throw new UploadError(result.code, `the content of ${session.name} is refused`, {}, 415);
    }
    return { result, event };
  }

  /** One transaction (spec §4.1 step 4): touchOpen takes the row lock that the complete claim also needs, then the upsert. */
  private async commitPart(session: UploadSession, part: number, written: WrittenPart, detectedMime: string | null): Promise<UploadPart | undefined> {
    const now = DateTime.utc();
    try {
      return await this.Store.transaction(async () => {
        if (!(await this.Store.touchOpen(session.id, now))) throw await this.notCommittable(session.id);
        const previous = await this.Store.findPart(session.id, part);
        await this.Store.upsertPart({ session_id: session.id, number: part, size: written.size, sha256: written.sha256, storage_key: written.key, detected_mime: part === 1 ? detectedMime : null, received_at: now });
        // The sweeper reclaims a blob that stayed 'writing' too long; the row must not point at an object it removed.
        if (!(await this.Store.setBlobState(written.blobId, 'writing', 'live', now))) {
          throw new UploadError('upload.part_lost', `part ${part} of upload ${session.id} was reclaimed before it committed`);
        }
        // false: the replaced blob is already garbage or gone, which is what this asks for.
        if (previous !== undefined) await this.Store.setBlobStateByKey(session.id, session.temp_fs, previous.storage_key, 'live', 'garbage', now);
        return previous;
      });
    } catch (err) {
      await this.Storage.discard(written.blobId, session.temp_fs, written.key, session.id);
      throw err;
    }
  }

  private async partStored(session: UploadSession, part: number, written: WrittenPart, previous: UploadPart | undefined, checked: UploadContentChecked | undefined): Promise<PartStoredView> {
    if (previous !== undefined) await this.removeGarbage(session.id);
    const view = toStateView(session, await this.Store.listParts(session.id));
    if (checked !== undefined) await this.Events.stage(checked);
    await this.Events.stage(
      new UploadPartStored(session, { Part: part, PartSize: written.size, PartSha256: written.sha256, Offset: view.offset, ReceivedParts: view.receivedParts.length, PartCount: session.part_count, Replaced: previous !== undefined }),
    );
    this.Log.debug({ uploadId: session.id, part, size: written.size, offset: view.offset }, 'Upload ${uploadId} part ${part} stored');
    return { part, size: written.size, sha256: written.sha256, offset: view.offset, missingParts: view.missingParts };
  }

  /** After the commit the part is stored, so a failure here must not refuse it; the sweeper removes what is left. */
  private async removeGarbage(sessionId: string): Promise<void> {
    try {
      await this.Storage.removeGarbage(sessionId);
    } catch (err) {
      this.Log.warn({ uploadId: sessionId, error: err }, 'Upload ${uploadId}: garbage was not removed; the sweeper removes it');
    }
  }

  private async partRejected(session: UploadSession, part: number, err: UploadError): Promise<void> {
    this.Log.warn({ uploadId: session.id, part, code: err.code }, 'Upload ${uploadId} part ${part} rejected: ${code}');
    await this.Events.stage(new UploadPartRejected(session, { Part: part, Code: err.code }));
  }

  /** touchOpen matched nothing: a session still open expired while the body streamed. */
  private async notCommittable(id: string): Promise<UploadError> {
    const fresh = await this.Store.findSession(id);
    if (fresh?.status === 'open') return new UploadError('upload.expired', `upload ${id} expired`);
    return new UploadError('upload.not_open', `upload ${id} is no longer open`);
  }

  private declaredFileHash(session: UploadSession, input: CompleteInput): string | null {
    const given = input.sha256 === undefined ? null : String(input.sha256).toLowerCase();
    if (given !== null && !SHA256_HEX.test(given)) throw invalid('sha256 must be 64 hex characters');
    if (given !== null && session.declared_sha256 !== null && given !== session.declared_sha256) throw new UploadError('upload.file_digest_mismatch', 'the sha256 differs from the one declared at create');
    const declared = session.declared_sha256 ?? given;
    if (declared === null && this.Options.integrity.fileDigest === 'required') throw new UploadError('upload.file_digest_required', 'the sha256 of the file is required');
    return declared;
  }

  /** Only the request holding the claim lists and assembles the parts (spec §5). null: another request holds it. */
  private async claim(session: UploadSession, declared: string | null): Promise<string | null> {
    const token = randomUUID();
    const now = DateTime.utc();
    if (!(await this.Store.claim(session.id, token, now, this.staleBefore(now), declared))) return null;
    return token;
  }

  private staleBefore(now: DateTime): DateTime {
    return now.minus(parsePositiveDuration(this.Options.assembly.staleAfter, 'upload.assembly.staleAfter'));
  }

  private heldByAnother(session: UploadSession): boolean {
    return session.status === 'assembling' && session.claimed_at !== null && session.claimed_at >= this.staleBefore(DateTime.utc());
  }

  /** Runs inside complete()'s try, so a failure here releases the claim instead of leaving it stuck. */
  private async announceClaim(session: UploadSession, token: string): Promise<void> {
    const claimed = await this.Store.requireSession(session.id);
    if (session.status === 'assembling') {
      this.Log.warn({ uploadId: session.id }, 'Upload ${uploadId}: stale claim taken over');
      await this.Events.stage(new UploadAssemblyReleased(claimed, { Reason: 'stale' }));
    }
    this.Log.debug({ uploadId: session.id }, 'Upload ${uploadId}: claim taken');
    this.Log.info({ uploadId: session.id, owner: session.owner, partCount: session.part_count }, 'Upload ${uploadId}: assembly started');
    await this.Events.stage(new UploadAssemblyStarted(claimed, { ClaimToken: token, PartCount: session.part_count }));
  }

  private async afterLostClaim(id: string, options: CompleteOptions): Promise<UploadStateView> {
    const fresh = await this.Store.requireSession(id);
    if (fresh.status === 'completed') return this.finishCompleted(fresh, options);
    if (fresh.status === 'assembling') throw new UploadError('upload.assembling', `upload ${id} is being assembled`);
    if (fresh.status === 'open' && fresh.expires_at.toMillis() <= Date.now()) throw new UploadError('upload.expired', `upload ${id} expired`);
    // Open again: another request held the claim and released it in the meantime, so a retry can take it.
    if (fresh.status === 'open') throw new UploadError('upload.assembling', `upload ${id}: another request held the assembly claim; retry`);
    throw notOpen(fresh);
  }

  private async assembleClaimed(id: string, token: string, declared: string | null, dir: string): Promise<UploadSession> {
    const session = await this.Store.requireSession(id);
    const parts = await this.Store.listParts(id);
    const missing = missingParts(session.part_count, parts.map((p) => p.number));
    if (missing.length > 0) throw new UploadError('upload.parts_missing', `parts ${missing.join(', ')} are missing`, { parts: missing });
    const detectedMime = parts[0].detected_mime;
    const file = await this.Storage.assemble(session, parts, { dir, contentType: detectedMime ?? session.declared_mime ?? 'application/octet-stream', declaredSha256: declared });
    if (file.corrupted.length > 0) return this.reopenCorrupted(session, token, parts, file);
    const mismatch = mismatchOf(session, file, declared);
    if (mismatch !== null) return this.failAssembly(session, token, file, mismatch);
    return this.commitCompleted(session, token, file, detectedMime);
  }

  /** Spec §4.2: drop the changed parts and the partial file, and open the session again so the client resends only them. */
  private async reopenCorrupted(session: UploadSession, token: string, parts: readonly UploadPart[], file: AssembledFile): Promise<never> {
    const now = DateTime.utc();
    const bad = parts.filter((p) => file.corrupted.includes(p.number));
    try {
      await this.Store.transaction(async () => {
        // The session row first: the sweeper's release locks it before the blob rows, and the other order can deadlock.
        if (!(await this.Store.release(session.id, token, now))) throw lostClaim(session.id);
        await this.Store.deleteParts(session.id, bad);
        // Results ignored: false means already garbage or gone, which is the target state.
        for (const part of bad) await this.Store.setBlobStateByKey(session.id, session.temp_fs, part.storage_key, 'live', 'garbage', now);
        await this.Store.setBlobState(file.blobId, ['writing', 'live'], 'garbage', now);
      });
    } catch (err) {
      await this.Storage.discard(file.blobId, session.files_fs, file.key, session.id);
      throw err;
    }
    await this.removeGarbage(session.id);
    await this.Events.stage(new UploadPartCorrupted(await this.Store.requireSession(session.id), { Parts: [...file.corrupted] }));
    this.Log.warn({ uploadId: session.id, parts: file.corrupted }, 'Upload ${uploadId}: stored parts changed; the session is open again');
    throw new UploadError('upload.part_corrupted', `parts ${file.corrupted.join(', ')} changed in storage; send them again`, { parts: [...file.corrupted] });
  }

  /** Spec §4.2: the client sent other bytes than it hashed, so the parts go too. */
  private async failAssembly(session: UploadSession, token: string, file: AssembledFile, mismatch: FileMismatch): Promise<never> {
    const now = DateTime.utc();
    try {
      await this.Store.transaction(async () => {
        if (!(await this.Store.fail(session.id, token, mismatch.code, mismatch.message, now))) throw lostClaim(session.id);
        await this.Store.setBlobState(file.blobId, ['writing', 'live'], 'garbage', now);
        await this.Store.setSessionBlobsState(session.id, 'part', 'garbage', now);
        await this.Store.deleteAllParts(session.id);
      });
    } catch (err) {
      await this.Storage.discard(file.blobId, session.files_fs, file.key, session.id);
      throw err;
    }
    await this.removeGarbage(session.id);
    await this.Events.final(await this.Store.requireSession(session.id));
    this.Log.info({ uploadId: session.id, owner: session.owner, code: mismatch.code }, 'Upload ${uploadId} failed: ${code}');
    throw new UploadError(mismatch.code, mismatch.message);
  }

  private async commitCompleted(session: UploadSession, token: string, file: AssembledFile, detectedMime: string | null): Promise<UploadSession> {
    const now = DateTime.utc();
    try {
      await this.Store.transaction(async () => {
        if (!(await this.Store.complete(session.id, token, { sha256: file.sha256, file_key: file.key, detected_mime: detectedMime }, now))) throw lostClaim(session.id);
        // The sweeper reclaims a blob that stayed 'writing' too long; file_key must not point at an object it removed.
        if (!(await this.Store.setBlobState(file.blobId, 'writing', 'live', now))) {
          throw new UploadError('upload.file_lost', `assembled file of upload ${session.id} was reclaimed before it committed`);
        }
      });
    } catch (err) {
      await this.Storage.discard(file.blobId, session.files_fs, file.key, session.id);
      throw err;
    }
    const completed = await this.Store.requireSession(session.id);
    await this.Events.final(completed);
    this.Log.info({ uploadId: session.id, owner: session.owner, size: file.size, sha256: file.sha256 }, 'Upload ${uploadId} completed');
    return completed;
  }

  private async finishCompleted(session: UploadSession, options: CompleteOptions): Promise<UploadStateView> {
    const view = toStateView(session, await this.Store.listParts(session.id));
    if (session.handled_at === null) await this.runCompletion(session, view, options);
    return view;
  }

  /** At least once: a rejected handler or before hook leaves handled_at null for the next complete (spec §5). */
  private async runCompletion(session: UploadSession, view: UploadStateView, options: CompleteOptions): Promise<void> {
    const hooks = await DI.resolve<Hooks>(Hooks);
    const input: UploadCompleteHookInput = { upload: view, owner: session.owner, metadata: session.metadata, filesFs: session.files_fs, fileKey: session.file_key ?? '' };
    await hooks.run('upload.complete', input, async () => (options.onCompleted ? options.onCompleted(session) : undefined), { mutable: [], refusable: true });
    if (!(await this.Store.markHandled(session.id, DateTime.utc()))) this.Log.debug({ uploadId: session.id }, 'Upload ${uploadId}: a concurrent complete already recorded the handler');
  }

  /** Any failure releases the claim (spec §5); a claim this request no longer holds is left alone. */
  private async releaseAfterError(id: string, token: string, err: unknown): Promise<void> {
    let released = false;
    try {
      released = await this.Store.release(id, token, DateTime.utc());
    } catch (releaseError) {
      this.Log.error({ uploadId: id, error: releaseError }, 'Upload ${uploadId}: the claim was not released and goes stale');
    }
    if (!released) return;
    if (isUploadError(err)) this.Log.warn({ uploadId: id, code: err.code }, 'Upload ${uploadId}: assembly stopped: ${code}');
    else this.Log.error({ uploadId: id, error: err }, 'Upload ${uploadId}: assembly failed; the claim was released');
    try {
      await this.Events.stage(new UploadAssemblyReleased(await this.Store.requireSession(id), { Reason: 'error' }));
    } catch (eventError) {
      this.Log.warn({ uploadId: id, error: eventError }, 'Upload ${uploadId}: the release event was not built');
    }
  }

  private async dropParts(session: UploadSession): Promise<void> {
    const now = DateTime.utc();
    await this.Store.transaction(async () => {
      await this.Store.setSessionBlobsState(session.id, 'part', 'garbage', now);
      await this.Store.deleteAllParts(session.id);
    });
    await this.removeGarbage(session.id);
  }
}
