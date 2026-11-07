import { performance } from 'node:perf_hooks';
import { Autoinject, Injectable, NewInstance } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { Logger, Log } from '@spinajs/log';
import type { Principal, PrincipalRef } from '@spinajs/principal';
import type * as express from 'express';

import { RouteMiddleware, RouteType } from '../interfaces.js';
import type { IActionLocalStoregeContext, IFinishContext, IMiddlewareContext, IReplyContext, IRoute, MiddlewareStage } from '../interfaces.js';
import { answeredAsServerError } from '../error.js';
import { redactUrl, urlPath } from '../util/redact-url.js';
import { REDACTED, redactFields, sensitiveKeyMatcher } from '../util/redact.js';

/** `http.audit`, and the options of `@Middleware(Audit, options)`. */
export interface IAuditOptions {
  /** HTTP methods audited; unset audits every method. */
  methods?: string[];
  /** Keys whose values are never recorded, matched as case-insensitive substrings. Route options add to the configured list. */
  redact?: string[];
  /** Whether the request body is recorded. Default `true`. */
  includeBody?: boolean;
  /** A body larger than this, as JSON after redaction, is left out and only its size recorded. Default 16384. */
  maxBodyBytes?: number;
}

export interface IAuditPrincipal extends PrincipalRef {
  readonly impersonator?: PrincipalRef;
}

/** One audited request, handed to the {@link AuditSink} once the response finished. */
export interface IAuditRecord {
  /** When the request reached the middleware. */
  at: Date;
  /** `http:<METHOD> <mounted path>` */
  route: string;
  method: string;
  /** The requested URL: every query value, and every path segment holding a sensitive route parameter, replaced by `[redacted]`. */
  url: string;
  /** Unset when the client went away before the headers were sent. */
  status?: number;
  ms: number;
  aborted: boolean;
  requestId?: string;
  ip?: string;
  principal?: IAuditPrincipal;
  query?: unknown;
  body?: unknown;
  /** Size in bytes of a body over `maxBodyBytes`, which is then not recorded. */
  bodyTruncated?: number;
  /** The error an error reply answered; `message` only for an error not answered as a 500, cut to 200 characters. */
  error?: IAuditError;
}

export interface IAuditError {
  name: string;
  message?: string;
}

/**
 * Where {@link Audit} writes its records. The default, {@link LogAuditSink}, writes them on the `audit` logger.
 * Register an own implementation as `AuditSink` to store them elsewhere; one sink serves every route, so a sink that
 * fans out to several stores does so itself.
 */
export abstract class AuditSink {
  public abstract write(record: IAuditRecord): void | Promise<void>;
}

@Injectable(AuditSink)
export class LogAuditSink extends AuditSink {
  @Logger('audit')
  protected Log!: Log;

  public write(record: IAuditRecord): void {
    this.Log.info(record, record.aborted ? 'audit ${route} aborted after ${ms}ms' : 'audit ${route} ${status} ${ms}ms');
  }
}

interface IAuditSettings {
  methods?: Set<string>;
  redact: string[];
  sensitive: (key: string) => boolean;
  includeBody: boolean;
  maxBodyBytes: number;
}

interface IAuditState {
  started: number;
  at: Date;
  // req.params is the route layer's: an error handler mounted outside the route may see other params by onFinish
  params: Record<string, unknown>;
  query?: unknown;
  body?: unknown;
  bodyTruncated?: number;
  error?: IAuditError;
}

export const DEFAULT_AUDIT_REDACT = ['password', 'token', 'secret', 'authorization', 'cookie', 'card'];
const DEFAULT_MAX_BODY_BYTES = 16384;
const MAX_ERROR_MESSAGE = 200;
const STATE = Symbol('audit');

const HTTP_METHOD_TYPES: ReadonlySet<string> = new Set([RouteType.GET, RouteType.POST, RouteType.PUT, RouteType.PATCH, RouteType.DELETE, RouteType.HEAD]);

type PrincipalStorage = IActionLocalStoregeContext & { Principal?: Principal | null; AuthnPrincipal?: Principal | null };

const isRef = (v: unknown): v is PrincipalRef => v !== null && typeof v === 'object' && 'type' in v && 'id' in v;

const isEmptyObject = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v) && Object.keys(v).length === 0;

function stringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new InvalidOption(`Audit: ${name} must be an array of strings`);
  }
  return value as string[];
}

/**
 * Records who did what on a route: the redacted body and query, the status, the error, the principal and the time,
 * written to the {@link AuditSink} once the response finished. A failing sink is logged on the `http` logger and
 * never fails the request.
 *
 * ```ts
 * @Post()
 * @Middleware(Audit, { redact: ['pin'] })
 * public pay() { ... }
 * ```
 *
 * Registered as `RouteMiddleware`, so `http.routes.middlewares: ['Audit']` audits every route.
 */
@NewInstance()
@Injectable(RouteMiddleware)
export class Audit extends RouteMiddleware {
  // before the policy gate, so a policy refusal is recorded too
  public override readonly Stage: MiddlewareStage = 'beforePolicy';

  @Config('http.audit', { defaultValue: {} })
  protected Config!: IAuditOptions | null;

  @Autoinject(AuditSink)
  protected Sink!: AuditSink;

  @Logger('http')
  protected Log!: Log;

  private settings?: IAuditSettings;

  constructor(protected Options: IAuditOptions = {}) {
    super();
  }

  // @Config is injected after the constructor ran, so the settings are merged on first use.
  protected get Settings(): IAuditSettings {
    if (this.settings) return this.settings;

    const cfg = this.Config ?? {};
    const options = this.Options ?? {};
    const methods = stringArray(options.methods, 'methods') ?? stringArray(cfg.methods, 'http.audit.methods');
    const maxBodyBytes = options.maxBodyBytes ?? cfg.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    if (typeof maxBodyBytes !== 'number' || !(maxBodyBytes >= 0)) {
      throw new InvalidOption('Audit: maxBodyBytes must be a number of bytes, 0 or more');
    }

    const redact = [...(stringArray(cfg.redact, 'http.audit.redact') ?? DEFAULT_AUDIT_REDACT), ...(stringArray(options.redact, 'redact') ?? [])];
    return (this.settings = {
      methods: methods ? new Set(methods.map((m) => m.toUpperCase())) : undefined,
      redact,
      sensitive: sensitiveKeyMatcher(redact),
      includeBody: options.includeBody ?? cfg.includeBody ?? true,
      maxBodyBytes,
    });
  }

  public override isEnabled(route: IRoute): boolean {
    const { methods } = this.Settings;
    return !methods || !HTTP_METHOD_TYPES.has(route.Type) || methods.has(route.Type.toUpperCase());
  }

  public onBefore({ req, res }: IMiddlewareContext): void {
    const settings = this.Settings;
    if (settings.methods && !settings.methods.has(req.method.toUpperCase())) return;

    const state: IAuditState = { started: performance.now(), at: new Date(), params: { ...req.params } };
    try {
      if (!isEmptyObject(req.query)) state.query = redactFields(req.query, settings.redact);
      if (settings.includeBody) this.captureBody(req, state, settings);
    } catch (err) {
      this.Log.warn(err as Error, 'audit: the request could not be recorded in full');
      if (settings.includeBody) state.body = REDACTED;
    }
    (res.locals as Record<symbol, IAuditState>)[STATE] = state;
  }

  public onAfter({ res, error }: IReplyContext): void {
    const state = (res.locals as Record<symbol, IAuditState | undefined>)[STATE];
    if (state && error !== undefined) {
      state.error = describeError(error);
    }
  }

  public async onFinish({ req, res, storage, path, aborted }: IFinishContext): Promise<void> {
    const state = (res.locals as Record<symbol, IAuditState | undefined>)[STATE];
    if (!state) return;

    const record: IAuditRecord = {
      at: state.at,
      route: path ?? '',
      method: req.method,
      url: redactPathParams(redactUrl(req.originalUrl), state.params, this.Settings.sensitive),
      status: !aborted || res.headersSent ? res.statusCode : undefined,
      ms: Math.round((performance.now() - state.started) * 100) / 100,
      aborted,
      requestId: storage?.requestId,
      ip: storage?.realIp,
      principal: principalOf(storage),
      query: state.query,
      body: state.body,
      bodyTruncated: state.bodyTruncated,
      error: state.error,
    };
    for (const key of Object.keys(record) as (keyof IAuditRecord)[]) {
      if (record[key] === undefined) delete record[key];
    }

    try {
      await this.Sink.write(record);
    } catch (err) {
      this.Log.error(err as Error, `audit: the sink failed to write the record of ${record.route}`);
    }
  }

  protected captureBody(req: express.Request, state: IAuditState, settings: IAuditSettings): void {
    const body: unknown = req.body;
    if (body === undefined || body === null || isEmptyObject(body)) return;

    // A text body has no keys to redact by, so none of it is recorded.
    if (typeof body !== 'object') {
      state.body = REDACTED;
      return;
    }

    const declared = Number(req.headers['content-length']);
    if (declared > settings.maxBodyBytes) {
      state.bodyTruncated = declared;
      return;
    }

    const redacted = redactFields(body, settings.redact);
    const bytes = Buffer.byteLength(JSON.stringify(redacted) ?? '');
    if (bytes > settings.maxBodyBytes) {
      state.bodyTruncated = bytes;
    } else {
      state.body = redacted;
    }
  }
}

// A message of an error answered as a 500 can carry internals or quote input (a SyntaxError, a driver error with bound values).
function describeError(error: unknown): IAuditError {
  const name = error instanceof Error ? (error.name !== 'Error' ? error.name : error.constructor.name) : typeof error;
  if (answeredAsServerError(error)) return { name };
  const message = error instanceof Error ? error.message : String(error);
  return { name, message: message.length > MAX_ERROR_MESSAGE ? `${message.slice(0, MAX_ERROR_MESSAGE)}...` : message };
}

function redactPathParams(url: string, params: Record<string, unknown> | undefined, sensitive: (key: string) => boolean): string {
  const values = Object.entries(params ?? {})
    .filter(([key, value]) => sensitive(key) && typeof value === 'string' && value !== '')
    .map(([, value]) => value as string);
  if (values.length === 0) return url;

  const path = urlPath(url);
  const redacted = path
    .split('/')
    .map((segment) => (values.includes(decodeSegment(segment)) ? REDACTED : segment))
    .join('/');
  return redacted + url.slice(path.length);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function principalOf(storage: IActionLocalStoregeContext | undefined): IAuditPrincipal | undefined {
  const s = storage as PrincipalStorage | undefined;
  const p = s?.Principal ?? s?.AuthnPrincipal;
  if (!isRef(p)) return undefined;

  const impersonator = p.authn?.impersonator;
  return { type: String(p.type), id: String(p.id), ...(isRef(impersonator) ? { impersonator: { type: String(impersonator.type), id: String(impersonator.id) } } : {}) };
}
