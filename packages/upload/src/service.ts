import { randomUUID } from 'node:crypto';
import { Config } from '@spinajs/configuration';
import { Autoinject, DI, Injectable, Singleton } from '@spinajs/di';
import { Hooks } from '@spinajs/hooks';
import { Log, Logger } from '@spinajs/log';
import { DateTime } from 'luxon';

import { ContentTypeCheck, allowsType } from './content/check.js';
import type { ContentCheckResult } from './content/check.js';
import { parseDuration } from './duration.js';
import { UploadError, isUploadError } from './errors.js';
import { UploadEvents } from './events/emitter.js';
import { UploadContentChecked, UploadCreated, UploadPartRejected, UploadPartStored } from './events/events.js';
import type { UploadCreateHookInput } from './hooks.js';
import { effectiveLimits, planParts } from './limits.js';
import type { UploadPart } from './models/UploadPart.js';
import type { UploadSession } from './models/UploadSession.js';
import { expectedPartSize } from './parts.js';
import { UploadStorage, assertFsProviders } from './storage.js';
import type { WrittenPart } from './storage.js';
import { UploadStore } from './store.js';
import type { NewSessionRow } from './store.js';
import type { AllowedTypes, CreateUploadInput, PartStoredView, PutPartOptions, UploadConfig, UploadLimits, UploadStateView } from './types.js';
import { isoOf, toStateView } from './view.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;

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
      ttlMs: parseDuration(limits.sessionTtl, 'upload.limits.sessionTtl'),
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
    return expected;
  }

  private async receivePart(session: UploadSession, part: number, body: NodeJS.ReadableStream, expected: number, digest: Buffer | undefined): Promise<WrittenPart> {
    const declared = digest === undefined ? undefined : digest.toString('hex');
    const written = await this.Storage.writePart(session, part, body, expected, declared);
    let refusal: UploadError | null = null;
    if (written.size !== expected) refusal = new UploadError('upload.part_size', `part ${part} ended after ${written.size} of ${expected} bytes`);
    else if (declared !== undefined && written.sha256 !== declared) refusal = new UploadError('upload.part_digest_mismatch', `part ${part} does not match its Content-Digest`);
    if (refusal !== null) {
      await this.Storage.discard(written.blobId, session.temp_fs, written.key);
      throw refusal;
    }
    return written;
  }

  private async checkContent(session: UploadSession, written: WrittenPart, allowedTypes: AllowedTypes): Promise<CheckedContent> {
    const result = await this.Content.check({ head: written.head, declaredMime: session.declared_mime, allowedTypes });
    this.Log.debug({ uploadId: session.id, part: 1, detectedMime: result.detectedMime, detectorId: result.detectorId, accepted: result.accepted }, 'Upload ${uploadId} content checked');
    const event = new UploadContentChecked(session, {
      DeclaredMime: session.declared_mime,
      ...(result.detectedMime !== null ? { DetectedMime: result.detectedMime } : {}),
      ...(result.detectorId !== null ? { DetectorId: result.detectorId } : {}),
      Accepted: result.accepted,
    });
    if (!result.accepted) {
      await this.Storage.discard(written.blobId, session.temp_fs, written.key);
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
        if (!(await this.Store.touchOpen(session.id, now))) throw new UploadError('upload.not_open', `upload ${session.id} is no longer open`);
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
      await this.Storage.discard(written.blobId, session.temp_fs, written.key);
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
}
