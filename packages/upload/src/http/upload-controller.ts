import type { Readable } from 'node:stream';
import { Config, Configuration } from '@spinajs/configuration';
import { Autoinject } from '@spinajs/di';
import { ActionRefused } from '@spinajs/hooks';
import { Log, Logger } from '@spinajs/log';
import { BaseController, Body, ContentDigest, Del, Get, HTTP_STATUS_CODE, Head, Json, OnError, Param, Post, Put, Req, RequestStream } from '@spinajs/http';
import type { ErrorContext, IResponseHeader, Request } from '@spinajs/http';

import { UPLOAD_MAX_PART_BYTES } from '../constants.js';
import { UploadError } from '../errors.js';
import type { UploadSession } from '../models/UploadSession.js';
import { expectedPartSize } from '../parts.js';
import { UploadService } from '../service.js';
import type { AllowedTypes, CompleteInput, UploadConfig, UploadLimits, UploadStateView } from '../types.js';
import { CompleteUploadDto, CreateUploadDto } from './dto.js';
import { hookRefusalResponse, uploadErrorResponse } from './error-responses.js';
import { declaredLength, settleUnreadBody } from './request-body.js';

export type UploadAction = 'create' | 'read' | 'putPart' | 'complete' | 'abort';

/** Provider names (`fs.providers`) of a new session. */
export interface UploadProviders {
  readonly temp: string;
  readonly files: string;
}

// Drain bound of a refused part: its expected size once putPart knows it, else the configured maximum part size.
const partBounds = new WeakMap<object, number>();

/** Route-level handler of putPart: every refusal, from the policy stage on, drains or closes the unread body first. */
async function settleRefusedPart(_err: Error, ctx: ErrorContext): Promise<void> {
  const configured = ctx.container.get(Configuration)?.get<number>('upload.limits.maxPartSize') ?? 0;
  await settleUnreadBody(ctx.req, ctx.res, partBounds.get(ctx.req) ?? configured);
}

const stateHeaders = (view: UploadStateView): IResponseHeader[] => [
  { Name: 'Upload-Offset', Value: view.offset },
  { Name: 'Upload-Length', Value: view.size },
  { Name: 'Upload-Part-Size', Value: view.partSize },
];

const locationOf = (req: Request, id: string): string => `${req.originalUrl.split('?')[0].replace(/\/+$/, '')}/${encodeURIComponent(id)}`;

// FromBody passes null when the request has no body (http/src/route-args/FromBody.ts:39-44).
const completeInputOf = (dto: CompleteUploadDto | null): CompleteInput => (dto?.sha256 === undefined ? {} : { sha256: dto.sha256 });

/**
 * The upload routes of spec §3 (spec §6.5). An app subclasses this with its own `@BasePath`, in its own controllers
 * dir; the package lists none and this file is in none (http/src/controller-sources.ts:25-41), so it is never mounted
 * by itself. `authorize` is abstract, so a subclass that leaves it out does not compile (fail closed, spec D7).
 * A subclass's own class-level `@OnError` runs before these two (http/src/decorators.ts:184-200).
 */
@OnError(UploadError, uploadErrorResponse)
@OnError(ActionRefused, hookRefusalResponse)
export abstract class UploadController extends BaseController {
  @Autoinject(UploadService)
  protected Uploads: UploadService;

  @Config('upload')
  protected UploadOptions: UploadConfig;

  @Logger('upload')
  protected Log: Log;

  // Neither create nor complete runs inside a caller's transaction: the service emits its events after its own
  // commit (spec §6.6), and an outer transaction would let them out before the data they report is committed.
  @Post('/')
  public async create(@Body({ required: true }) dto: CreateUploadDto, @Req() req: Request) {
    await this.authorize('create', req);
    const view = await this.Uploads.create({
      name: dto.name,
      size: dto.size,
      sha256: dto.sha256,
      partSize: dto.partSize,
      metadata: await this.metadataFor(req, dto),
      owner: await this.ownerOf(req),
      limits: await this.limitsFor(req),
      allowedTypes: await this.allowedTypes(req),
      allowUnknownType: await this.allowUnknownType(req),
      fs: await this.fsFor(req, dto),
    });
    return new Json(view, { StatusCode: HTTP_STATUS_CODE.CREATED, Headers: [{ Name: 'Location', Value: locationOf(req, view.id) }] });
  }

  // Declared before GET: a GET route also answers HEAD (router 2.2.0, lib/route.js:64).
  @Head(':upload')
  public async offset(@Param() upload: string, @Req() req: Request) {
    const view = await this.Uploads.state(await this.sessionFor('read', upload, req));
    return new Json(null, { Headers: stateHeaders(view) });
  }

  @Get(':upload')
  public async state(@Param() upload: string, @Req() req: Request) {
    return new Json(await this.Uploads.state(await this.sessionFor('read', upload, req)));
  }

  @Put(':upload/parts/:part')
  @OnError(Error, settleRefusedPart)
  public async putPart(@Param() upload: string, @Param() part: number, @RequestStream({ maxBytes: UPLOAD_MAX_PART_BYTES }) body: NodeJS.ReadableStream, @ContentDigest() digest: Map<string, Buffer>, @Req() req: Request) {
    try {
      const session = await this.sessionFor('putPart', upload, req);
      if (Number.isInteger(part) && part >= 1 && part <= session.part_count) partBounds.set(req, expectedPartSize(session.size, session.part_size, part));
      return new Json(await this.Uploads.putPart(session, part, body, digest.get('sha-256'), declaredLength(req), { allowedTypes: await this.allowedTypes(req) }));
    } catch (err) {
      // Frees the limiter and its PassThrough, and keeps an over-bound body flowing (discarded) while the
      // Connection: close answer goes out (limit-request-stream.ts:58-68).
      (body as Readable).destroy();
      throw err;
    }
  }

  @Post(':upload/complete')
  public async complete(@Param() upload: string, @Body() dto: CompleteUploadDto, @Req() req: Request) {
    const session = await this.sessionFor('complete', upload, req);
    const view = await this.Uploads.complete(session, completeInputOf(dto), { fileDir: this.fileDir(session), onCompleted: (done) => this.onCompleted(done, req) });
    return new Json(view);
  }

  @Del(':upload')
  public async abort(@Param() upload: string, @Req() req: Request) {
    const session = await this.sessionFor('abort', upload, req);
    if (await this.Uploads.abort(session)) await this.afterAbort(session.id, req);
    return new Json(null, { StatusCode: HTTP_STATUS_CODE.NO_CONTENT });
  }

  /** Owner-scoped, so a missing and a foreign session both answer upload.not_found before authorize runs (spec §6.5). */
  protected async sessionFor(action: Exclude<UploadAction, 'create'>, id: string, req: Request): Promise<UploadSession> {
    const session = await this.Uploads.get(id, await this.ownerOf(req));
    await this.authorize(action, req, session);
    return session;
  }

  /** Fail closed: throw Forbidden or ResourceNotFound to refuse. `session` is absent for 'create'. */
  protected abstract authorize(action: UploadAction, req: Request, session?: UploadSession): Promise<void>;

  /** Owner stamped on new sessions and used to scope every lookup; null leaves both unscoped. */
  protected async ownerOf(_req: Request): Promise<string | null> {
    return null;
  }

  /** Metadata stored with a new session; by default the client's own `metadata`. It reaches the events, so no secrets. */
  protected async metadataFor(_req: Request, dto: CreateUploadDto): Promise<Record<string, unknown>> {
    return dto.metadata ?? {};
  }

  /** Can only tighten the configured limits (src/limits.ts). */
  protected async limitsFor(_req: Request): Promise<Partial<UploadLimits>> {
    return {};
  }

  /** Checked against the name's type at create and against part 1's content. */
  protected async allowedTypes(_req: Request): Promise<AllowedTypes> {
    return '*';
  }

  /** Accept a name whose extension mime-types does not know (spec §4.3). */
  protected async allowUnknownType(_req: Request): Promise<boolean> {
    return false;
  }

  protected async fsFor(_req: Request, _dto: CreateUploadDto): Promise<UploadProviders> {
    return { temp: this.UploadOptions.fs.temp, files: this.UploadOptions.fs.files };
  }

  /** Directory of the merged file on the files provider; the service appends `<uuid><ext>`, so keys stay unique. */
  protected fileDir(_session: UploadSession): string {
    return `${this.UploadOptions.fs.prefix}/files`;
  }

  /** Runs once per completed session (handled_at); a rejection fails this complete and runs again on the next one. */
  protected async onCompleted(_session: UploadSession, _req: Request): Promise<unknown> {
    return undefined;
  }

  /** Runs once, for the DELETE that aborted the session. */
  protected async onAborted(_session: UploadSession, _req: Request): Promise<void> {}

  // The abort is committed and its event emitted, so a failing handler is logged, not answered: a retried DELETE finds
  // the session aborted and would not run it again.
  private async afterAbort(id: string, req: Request): Promise<void> {
    try {
      await this.onAborted(await this.Uploads.get(id), req);
    } catch (err) {
      this.Log.error({ uploadId: id, error: err }, 'Upload ${uploadId}: onAborted failed after the abort');
    }
  }
}
