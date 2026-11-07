import type Express from 'express';
import _ from 'lodash';
import { Autoinject, Container, Injectable, NewInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Logger } from '@spinajs/log';
import type { Log } from '@spinajs/log';
import { InvalidConfiguration, registerConfigurationSchema } from '@spinajs/configuration';
import { CodedHttpException, InvalidArgument } from '@spinajs/exceptions';
import type { Principal } from '@spinajs/principal';
import type * as Idempotency from '@spinajs/idempotency';
import { Response, RouteMiddleware } from '../interfaces.js';
import type { ResponseFunction } from '../interfaces.js';
import { REPLAY_BEFORE_POLICY, sendReply } from '../reply-pipeline.js';
import type { IReplaysBeforePolicy } from '../reply-pipeline.js';
import { _setHeaders } from '../responses.js';
import type { IRoute, IRouteInvocation, IRouteOutcome, MiddlewareStage, Request } from '../interfaces.js';
import { RouteClientGone, RouteRegistrationException } from '../exceptions.js';
import type { CapturedJsonReply } from '../response-capture.js';
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_REPLAYED_HEADER, parseIdempotencyKey } from './options.js';
import type { ResolvedIdempotentOptions } from './options.js';

type ErrorClass = abstract new (...args: never[]) => Error;

interface StoredReply {
  kind: string;
  body: unknown;
}

/**
 * The part of IdempotencyService the middleware calls, declared here: these declarations must type-check for an app
 * that does not install the optional peer @spinajs/idempotency.
 */
interface IdempotencyGateService {
  run<T>(
    scope: { namespace: string; principal?: string },
    key: string,
    fn: (signal: AbortSignal) => Promise<T>,
    opts: { fingerprint?: string; ttl: string | number; toReply(value: T): StoredReply | undefined; fromReply(reply: StoredReply): T },
  ): Promise<{ replayed: boolean; value: T }>;
  peek(scope: { namespace: string; principal?: string }, key: string): Promise<{ state: 'running' | 'done'; reply?: StoredReply; fingerprint?: string } | undefined>;
}

/** What onRegister takes from @spinajs/idempotency for the route. */
interface IdempotencyGate {
  /** `http:<METHOD> <path>` */
  namespace: string;
  ttlMs: number;
  service: IdempotencyGateService;
  inFlight: ErrorClass;
  keyReuse: ErrorClass;
  /** A claim inside a transaction lost a deadlock or serialization check: retryable, like a key in flight. */
  claimConflict: ErrorClass;
  /** Thrown by the route run when the client went away before the reply: the service keeps the claim. */
  outcomeUnknown: new (message: string) => Error;
  fingerprint: (data: string | Uint8Array) => string;
  /** Crash contract: an error with `crash: true` stands for a dead process, whose claim is neither stored nor released. */
  isCrash: (error: unknown) => boolean;
  /** The principal part of the scope: the principal's key, plus its authority when it is restricted. */
  scopeOf: (principal: Principal) => string;
  isRestricted: (principal: Principal) => boolean;
}

const ANONYMOUS = 'anonymous';

const CLAIM_CONFLICT_RETRY_AFTER_S = 1;

const clientGone = (res: Express.Response): boolean => res.destroyed || res.closed;

const principalOf = (req: Express.Request): Principal | undefined => ((req as Request).storage as { Principal?: Principal } | undefined)?.Principal;

const scopeOf = (req: Express.Request, gate: IdempotencyGate): string => {
  const principal = principalOf(req);
  return principal?.authenticated ? gate.scopeOf(principal) : ANONYMOUS;
};

function bodyBytes(req: Express.Request): string | Uint8Array {
  const raw = (req as Request).rawBody;
  if (raw) {
    return raw;
  }
  const body: unknown = req.body;
  if (typeof body === 'string') {
    return body;
  }
  if (body !== undefined && body !== null) {
    return JSON.stringify(body);
  }
  // no parser read the body (multipart, octet-stream): its type and size are all the gate can compare without
  // consuming the stream; the boundary parameter is left out, since a client draws a new one for every retry
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  return `${type}\n${req.headers['content-length'] ?? ''}`;
}

// 408, 425 and 429 say "try again later", and a retry with other credentials may pass a 401 or 403: stored, the
// refusal would replay for the whole ttl.
const UNSTORED_4XX = new Set([401, 403, 408, 425, 429]);

const storable = (status: number): boolean => (status >= 200 && status < 300) || (status >= 400 && status < 500 && !UNSTORED_4XX.has(status));

/**
 * The reply `@Idempotent` sends for a repeated key: the stored status, headers and JSON body, plus
 * `Idempotent-Replayed: true`. Its `data` is the stored body, as the outer `onAfter` hooks already shaped it on the first
 * answer: a hook that changes data checks `ctx.response instanceof ReplayedResponse` so it does not apply itself twice.
 * The stored bytes are sent unless a hook changed `data`; then the stored ETag is dropped and express computes one.
 */
export class ReplayedResponse extends Response<unknown> {
  public readonly replayed = true;

  private readonly stored: CapturedJsonReply;

  // a second parse, compared with data: a hook may change the parsed body in place
  private readonly pristine: unknown;

  constructor(reply: CapturedJsonReply) {
    const parse = () => (reply.body === null ? null : (JSON.parse(reply.body) as unknown));
    super(parse(), { StatusCode: reply.status, Headers: Object.entries(reply.headers).map(([Name, Value]) => ({ Name, Value })) });
    this.stored = reply;
    this.pristine = parse();
  }

  public override async execute(): Promise<ResponseFunction> {
    const data = await this.prepareResponse();
    const changed = !_.isEqual(data, this.pristine);
    // the stored ETag names the stored body; a hook's own ETag stays
    const storedEtag = this.stored.headers.etag;
    const headers = changed ? this.headers.filter((h) => h.Name.toLowerCase() !== 'etag' || h.Value !== storedEtag) : this.headers;
    return (_req, res) => {
      res.status(this.statusCode);
      _setHeaders(res, { Headers: [...headers] });
      res.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
      if (changed) {
        res.json(data);
      } else if (this.stored.body === null) {
        res.json();
      } else {
        res.send(this.stored.body);
      }
    };
  }
}

/**
 * Runs the rest of the route chain at most once per Idempotency-Key, principal and route, and replays the stored reply
 * of a repeat. `@Idempotent` mounts it; `@spinajs/idempotency` is an optional peer, loaded only by onRegister, so an app
 * without `@Idempotent` routes loads neither it nor its table. An app on the ORM store imports the package itself,
 * before the boot: the Orm reads its models when it resolves.
 */
@Injectable()
@NewInstance()
export class IdempotencyMiddleware extends RouteMiddleware implements IReplaysBeforePolicy {
  // a replay is the middleware's own answer: no other route middleware and no action runs for it
  public override readonly Stage: MiddlewareStage = 'outer';

  @Autoinject(Container)
  protected _container!: IContainer;

  @Logger('http')
  protected _log!: Log;

  protected gate?: IdempotencyGate;

  constructor(protected readonly options: ResolvedIdempotentOptions) {
    super();
  }

  public async onRegister(route: IRoute, path: string): Promise<void> {
    if (!this.options) {
      throw new InvalidArgument('IdempotencyMiddleware is mounted by @Idempotent(), not by @Middleware()');
    }
    const namespace = `http:${String(route.Type).toUpperCase()} ${path}`;
    let idempotency: typeof Idempotency;
    try {
      idempotency = await import('@spinajs/idempotency');
    } catch (err) {
      throw new RouteRegistrationException('@Idempotent needs the @spinajs/idempotency package installed', err);
    }

    // registerConfigurationSchemaAtImport only logs on this lazy path, where the Configuration is resolved: a wrong
    // idempotency.* value must fail the registration, not the first request
    try {
      registerConfigurationSchema(idempotency.IDEMPOTENCY_CONFIGURATION_SCHEMA, this._container);
    } catch (err) {
      if (!(err instanceof InvalidConfiguration)) {
        throw err;
      }
      throw new RouteRegistrationException(`@Idempotent needs a valid idempotency configuration: ${err.message}`, err);
    }

    const service = await this._container.resolve(idempotency.IdempotencyService);
    if (service.Store instanceof idempotency.OrmIdempotencyStore && idempotency.ormModelRegistered(this._container) === false) {
      throw new RouteRegistrationException(
        `@Idempotent on OrmIdempotencyStore: the Orm resolved before @spinajs/idempotency was imported, so __idempotency has neither a model nor a migration. Add import '@spinajs/idempotency' to the app entry, before the boot`,
      );
    }

    this.gate = {
      namespace,
      ttlMs: service.ttlOf(this.options.ttl, '@Idempotent ttl'),
      service,
      inFlight: idempotency.IdempotencyInFlight,
      keyReuse: idempotency.IdempotencyKeyReuse,
      claimConflict: idempotency.IdempotencyClaimConflict,
      outcomeUnknown: idempotency.IdempotencyOutcomeUnknown,
      fingerprint: idempotency.fingerprintOf,
      isCrash: idempotency.isCrash,
      scopeOf: idempotency.idempotencyPrincipal,
      isRestricted: idempotency.isRestrictedPrincipal,
    };
  }

  public async onAround({ req, res }: IRouteInvocation, proceed: () => Promise<IRouteOutcome>): Promise<void> {
    const header = req.headers[IDEMPOTENCY_KEY_HEADER];

    if (header === undefined) {
      if (this.options.required) {
        if (clientGone(res)) {
          return;
        }
        throw new CodedHttpException(400, 'idempotency.key-required', 'This route needs an Idempotency-Key header');
      }
      await proceed().catch((err: unknown) => {
        if (!(err instanceof RouteClientGone)) {
          throw err;
        }
      });
      return;
    }

    const key = parseIdempotencyKey(header);
    if (key === undefined) {
      if (clientGone(res)) {
        return;
      }
      throw new CodedHttpException(400, 'idempotency.key-malformed', 'The Idempotency-Key header must be one key of 1 to 255 characters, bare visible ASCII or a quoted string');
    }

    if (clientGone(res)) {
      return;
    }

    try {
      await this.claimAndRun(this.gate!, key, req, res, proceed);
    } catch (err) {
      if (!res.headersSent) {
        throw err;
      }
      this._log.error({ error: err, route: this.gate!.namespace }, 'Idempotent route ${route} failed after its reply was sent');
    }
  }

  /**
   * Runs before the policy gate: the stored reply of a completed key, when the caller is an authenticated, unrestricted
   * principal and the request has the stored fingerprint, so a resend of a committed operation is not refused by
   * policies that now see the changed state. Anything else (an anonymous caller, who shares one scope; a ceiling, a
   * delegation, an impersonation, a link, whose limits only the policies enforce; no record; a key in flight; another
   * request; a failing store) answers undefined and goes through the policies and the claim.
   */
  public async [REPLAY_BEFORE_POLICY]({ req }: IRouteInvocation): Promise<Response | undefined> {
    const gate = this.gate;
    const key = parseIdempotencyKey(req.headers[IDEMPOTENCY_KEY_HEADER]);
    const principal = principalOf(req);
    if (!gate || key === undefined || !principal?.authenticated || gate.isRestricted(principal)) {
      return undefined;
    }

    let held: Awaited<ReturnType<IdempotencyGateService['peek']>>;
    try {
      held = await gate.service.peek({ namespace: gate.namespace, principal: gate.scopeOf(principal) }, key);
    } catch (error) {
      this._log.warn({ error, route: gate.namespace }, 'Idempotent route ${route}: reading its key before the policies failed; the policies and the claim run');
      return undefined;
    }

    // a record without a fingerprint (written before fingerprints) is left to the claim, after the policies
    if (held?.state !== 'done' || held.reply?.kind !== 'http' || held.fingerprint === undefined || held.fingerprint !== this.fingerprintOf(req, gate)) {
      return undefined;
    }
    return new ReplayedResponse(held.reply.body as CapturedJsonReply);
  }

  protected fingerprintOf(req: Express.Request, gate: IdempotencyGate): string {
    // the target is part of the fingerprint: the namespace holds the route template, not the resource
    const target = Buffer.from(`${req.method} ${req.originalUrl}\n`);
    return gate.fingerprint(this.options.fingerprint === 'body' ? Buffer.concat([target, Buffer.from(bodyBytes(req))]) : target);
  }

  /** Claims the key, then runs the route once or replays its reply; a refused claim reaches the error handlers. */
  protected async claimAndRun(gate: IdempotencyGate, key: string, req: Express.Request, res: Express.Response, proceed: () => Promise<IRouteOutcome>): Promise<void> {
    const fingerprint = this.fingerprintOf(req, gate);
    let continued = false;
    const route = async (): Promise<CapturedJsonReply | null> => {
      continued = true;
      let outcome: IRouteOutcome;
      try {
        outcome = await proceed();
      } catch (err) {
        // a client gone mid-route leaves a handler that may still commit, so the claim holds until its lease ends
        if (err instanceof RouteClientGone && !err.beforeRoute) {
          throw new gate.outcomeUnknown(`the client of ${gate.namespace} went away before the route answered`);
        }
        throw err;
      }
      if (gate.isCrash(outcome.error)) {
        throw outcome.error;
      }
      return outcome.reply;
    };

    let outcome: { replayed: boolean; value: CapturedJsonReply | null };
    try {
      outcome = await gate.service.run({ namespace: gate.namespace, principal: scopeOf(req, gate) }, key, route, {
        fingerprint,
        ttl: gate.ttlMs,
        toReply: (captured) => this.toReply(captured, gate),
        fromReply: (reply) => reply.body as CapturedJsonReply,
      });
    } catch (err) {
      if (continued) {
        // the route chain answered, or the client is gone: nothing is left to send
        this.afterAnswer(err, gate);
        return;
      }
      const mapped = this.toHttpError(err, gate, res);
      // a refused claim of a client that left is expected: returning keeps around.ts from logging it as a failure
      if (mapped !== err && clientGone(res)) {
        return;
      }
      throw mapped;
    }
    if (outcome.replayed && outcome.value) {
      // a framework reply: the middlewares entered before this one see it in onAfter
      await sendReply(req, res, new ReplayedResponse(outcome.value));
    }
  }

  protected toReply(captured: CapturedJsonReply | null, gate: IdempotencyGate): StoredReply | undefined {
    if (!captured) {
      this._log.warn({ route: gate.namespace }, 'Idempotent route ${route} answered without a JSON reply, which cannot be replayed; its key is released');
      return undefined;
    }
    if (!storable(captured.status)) {
      return undefined;
    }
    const bytes = captured.body === null ? 0 : Buffer.byteLength(captured.body);
    if (bytes > this.options.maxReplyBytes) {
      this._log.warn({ route: gate.namespace, bytes, max: this.options.maxReplyBytes }, 'Idempotent route ${route}: its reply of ${bytes} bytes is above maxReplyBytes ${max}; it is not stored and its key is released');
      return undefined;
    }
    return { kind: 'http', body: captured };
  }

  protected toHttpError(err: unknown, gate: IdempotencyGate, res: Express.Response): unknown {
    if (err instanceof gate.inFlight) {
      const retryAfterMs = (err as Error & { retryAfterMs: number }).retryAfterMs;
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      return new CodedHttpException(409, 'idempotency.in-flight', 'A request with this Idempotency-Key is still being processed');
    }
    if (err instanceof gate.claimConflict) {
      res.setHeader('Retry-After', String(CLAIM_CONFLICT_RETRY_AFTER_S));
      return new CodedHttpException(409, 'idempotency.claim-conflict', 'Claiming this Idempotency-Key conflicted with a concurrent request; retry it');
    }
    if (err instanceof gate.keyReuse) {
      return new CodedHttpException(422, 'idempotency.key-reuse', 'This Idempotency-Key was already used with a different request');
    }
    return err;
  }

  protected afterAnswer(err: unknown, gate: IdempotencyGate): void {
    if (err instanceof RouteClientGone && err.beforeRoute) {
      this._log.warn({ route: gate.namespace }, 'Idempotent route ${route}: the client went away during the claim; the route did not run and its key is released');
    } else if (err instanceof gate.outcomeUnknown) {
      this._log.warn({ route: gate.namespace }, 'Idempotent route ${route}: the client went away before the reply; its key stays claimed until the lease ends');
    } else if (gate.isCrash(err)) {
      this._log.warn({ route: gate.namespace }, 'Idempotent route ${route} crashed; its key stays claimed until the lease ends');
    } else {
      this._log.error({ error: err, route: gate.namespace }, 'Idempotent route ${route}: recording its reply failed after it answered');
    }
  }
}
