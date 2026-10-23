import { randomUUID } from 'node:crypto';
import { Config } from '@spinajs/configuration';
import { Autoinject, DI, Injectable, Singleton } from '@spinajs/di';
import { Hooks } from '@spinajs/hooks';
import { Log, Logger } from '@spinajs/log';
import { DateTime } from 'luxon';

import { ContentTypeCheck, allowsType } from './content/check.js';
import { parseDuration } from './duration.js';
import { UploadError } from './errors.js';
import { UploadEvents } from './events/emitter.js';
import { UploadCreated } from './events/events.js';
import type { UploadCreateHookInput } from './hooks.js';
import { effectiveLimits, planParts } from './limits.js';
import type { UploadSession } from './models/UploadSession.js';
import { UploadStorage, assertFsProviders } from './storage.js';
import { UploadStore } from './store.js';
import type { NewSessionRow } from './store.js';
import type { CreateUploadInput, UploadConfig, UploadLimits, UploadStateView } from './types.js';
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
}
