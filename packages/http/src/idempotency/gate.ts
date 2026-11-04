import type Express from 'express';
import type { IContainer } from '@spinajs/di';
import type { Log } from '@spinajs/log';
import { InvalidConfiguration, registerConfigurationSchema } from '@spinajs/configuration';
import { CodedHttpException } from '@spinajs/exceptions';
import { principalKey } from '@spinajs/principal';
import type { Principal } from '@spinajs/principal';
import type * as Idempotency from '@spinajs/idempotency';
import type { IRoute, Request } from '../interfaces.js';
import { RouteRegistrationException } from '../exceptions.js';
import { markStage } from '../errors/on-error.js';
import { attachResponseCapture } from '../response-capture.js';
import type { CapturedJsonReply } from '../response-capture.js';
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_REPLAYED_HEADER, parseIdempotencyKey } from './options.js';
import type { ResolvedIdempotentOptions } from './options.js';

type ErrorClass = abstract new (...args: never[]) => Error;

interface StoredReply {
  kind: string;
  body: unknown;
}

/**
 * The part of IdempotencyService the gate calls, declared here: these declarations must type-check for an app that
 * does not install the optional peer @spinajs/idempotency.
 */
export interface IdempotencyGateService {
  run<T>(
    scope: { namespace: string; principal?: string },
    key: string,
    fn: (signal: AbortSignal) => Promise<T>,
    opts: { fingerprint?: string; ttl: string | number; toReply(value: T): StoredReply | undefined; fromReply(reply: StoredReply): T },
  ): Promise<{ replayed: boolean; value: T }>;
}

export interface IdempotencyGateOptions {
  /** `http:<METHOD> <path>` */
  namespace: string;
  options: ResolvedIdempotentOptions;
  ttlMs: number;
  service: IdempotencyGateService;
  inFlight: ErrorClass;
  keyReuse: ErrorClass;
  /** A claim inside a transaction lost a deadlock or serialization check: retryable, like a key in flight. */
  claimConflict: ErrorClass;
  /** Thrown by the route run when the client went away before the reply: the service keeps the claim. */
  outcomeUnknown: new (message: string) => Error;
  fingerprint: (data: string | Uint8Array) => string;
  log: Log;
}

const ANONYMOUS = 'anonymous';

const CLAIM_CONFLICT_RETRY_AFTER_S = 1;

const ROUTE_ERROR = Symbol('idempotentRouteError');

/** Crash contract: an error with `crash: true` stands for a dead process, whose claim is neither stored nor released. */
const isCrash = (error: unknown): error is Error => (error as { crash?: unknown } | null | undefined)?.crash === true;

/**
 * Error handler placed before the error handlers of an `@Idempotent` route and before `__handle_error__`: the error
 * reaches the client as a 500 reply, and only this record tells the gate that the route crashed rather than answered.
 */
export function recordIdempotentRouteError(err: unknown, _req: Express.Request, res: Express.Response, next: Express.NextFunction): void {
  // placed twice in the chain; an error handler that turned a crash into another error must not hide it
  if (!isCrash(routeErrorOf(res))) {
    (res.locals as Record<symbol, unknown>)[ROUTE_ERROR] = err;
  }
  next(err);
}

function routeErrorOf(res: Express.Response): unknown {
  return (res.locals as Record<symbol, unknown>)[ROUTE_ERROR];
}

function principalOf(req: Express.Request): string {
  const principal = ((req as Request).storage as { Principal?: Principal } | undefined)?.Principal;
  return principal?.authenticated ? principalKey(principal) : ANONYMOUS;
}

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

function toReply(captured: CapturedJsonReply | null, gate: IdempotencyGateOptions): StoredReply | undefined {
  if (!captured) {
    gate.log.warn({ route: gate.namespace }, 'Idempotent route ${route} answered without a JSON reply, which cannot be replayed; its key is released');
    return undefined;
  }
  if (!storable(captured.status)) {
    return undefined;
  }
  const bytes = captured.body === null ? 0 : Buffer.byteLength(captured.body);
  if (bytes > gate.options.maxReplyBytes) {
    gate.log.warn({ route: gate.namespace, bytes, max: gate.options.maxReplyBytes }, 'Idempotent route ${route}: its reply of ${bytes} bytes is above maxReplyBytes ${max}; it is not stored and its key is released');
    return undefined;
  }
  return { kind: 'http', body: captured };
}

function replay(res: Express.Response, reply: CapturedJsonReply): void {
  res.status(reply.status);
  for (const [name, value] of Object.entries(reply.headers)) {
    res.setHeader(name, value);
  }
  res.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
  if (reply.body === null) {
    res.json();
  } else {
    res.send(reply.body);
  }
}

function toHttpError(err: unknown, gate: IdempotencyGateOptions, res: Express.Response): unknown {
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

/** Released, not kept: the route never ran. */
class ClientGoneBeforeRoute extends Error {}

/** Watched from the gate's entry: a client that leaves during the claim fires no later close. */
interface ClientWatch {
  gone: boolean;
  onGone?: () => void;
}

function watchClient(res: Express.Response): ClientWatch {
  const watch: ClientWatch = { gone: false };
  res.once('close', () => {
    watch.gone = true;
    watch.onGone?.();
  });
  return watch;
}

/** Runs the rest of the route chain and settles with what `jsonResponse` captured, once the response finished. */
function runRoute(gate: IdempotencyGateOptions, res: Express.Response, next: Express.NextFunction, watch: ClientWatch): Promise<CapturedJsonReply | null> {
  return new Promise<CapturedJsonReply | null>((resolve, reject) => {
    if (watch.gone) {
      reject(new ClientGoneBeforeRoute(`the client of ${gate.namespace} went away during the claim`));
      return;
    }
    let captured: CapturedJsonReply | null = null;
    attachResponseCapture(res, { capture: (reply) => (captured = reply) });
    res.once('finish', () => {
      const error = routeErrorOf(res);
      if (isCrash(error)) {
        reject(error);
      } else {
        resolve(captured);
      }
    });
    // close before finish: the client went away while the handler may still commit, so the claim holds until its lease ends
    watch.onGone = () => reject(new gate.outcomeUnknown(`the client of ${gate.namespace} went away before the route answered`));
    next();
  });
}

function afterAnswer(err: unknown, gate: IdempotencyGateOptions): void {
  if (err instanceof ClientGoneBeforeRoute) {
    gate.log.warn({ route: gate.namespace }, 'Idempotent route ${route}: the client went away during the claim; the route did not run and its key is released');
  } else if (err instanceof gate.outcomeUnknown) {
    gate.log.warn({ route: gate.namespace }, 'Idempotent route ${route}: the client went away before the reply; its key stays claimed until the lease ends');
  } else if (isCrash(err)) {
    gate.log.warn({ route: gate.namespace }, 'Idempotent route ${route} crashed; its key stays claimed until the lease ends');
  } else {
    gate.log.error({ error: err, route: gate.namespace }, 'Idempotent route ${route}: recording its reply failed after it answered');
  }
}

/** Claims the key, then runs the route once or replays its reply; a refused claim reaches the error handlers. */
async function claimAndRun(gate: IdempotencyGateOptions, key: string, req: Express.Request, res: Express.Response, next: Express.NextFunction): Promise<void> {
  const watch = watchClient(res);
  // the target is part of the fingerprint: the namespace holds the route template, not the resource
  const target = Buffer.from(`${req.method} ${req.originalUrl}\n`);
  const fingerprint = gate.fingerprint(gate.options.fingerprint === 'body' ? Buffer.concat([target, Buffer.from(bodyBytes(req))]) : target);
  let continued = false;
  const route = () => {
    continued = true;
    return runRoute(gate, res, next, watch);
  };

  let outcome: { replayed: boolean; value: CapturedJsonReply | null };
  try {
    outcome = await gate.service.run({ namespace: gate.namespace, principal: principalOf(req) }, key, route, {
      fingerprint,
      ttl: gate.ttlMs,
      toReply: (captured) => toReply(captured, gate),
      fromReply: (reply) => reply.body as CapturedJsonReply,
    });
  } catch (err) {
    if (continued) {
      // the route chain answered, or the client is gone: nothing is left to send
      afterAnswer(err, gate);
    } else {
      next(toHttpError(err, gate, res));
    }
    return;
  }
  if (outcome.replayed && outcome.value) {
    replay(res, outcome.value);
  }
}

/**
 * Express handler running the rest of the route chain at most once per Idempotency-Key, principal and route. Used
 * alone, outside a controller, it sees no crash of the route: only the controller chain records route errors for it.
 */
export function createIdempotencyGate(gate: IdempotencyGateOptions): Express.RequestHandler {
  return (req: Express.Request, res: Express.Response, next: Express.NextFunction) => {
    // a replay is the gate's own answer: no route middleware and no action runs for it
    markStage(res, 'middleware');
    const header = req.headers[IDEMPOTENCY_KEY_HEADER];

    if (header === undefined) {
      next(gate.options.required ? new CodedHttpException(400, 'idempotency.key-required', 'This route needs an Idempotency-Key header') : undefined);
      return;
    }

    const key = parseIdempotencyKey(header);
    if (key === undefined) {
      next(new CodedHttpException(400, 'idempotency.key-malformed', 'The Idempotency-Key header must be one key of 1 to 255 characters, bare visible ASCII or a quoted string'));
      return;
    }

    if (res.destroyed || res.closed) {
      return;
    }

    claimAndRun(gate, key, req, res, next).catch((err: unknown) => {
      if (res.headersSent) {
        gate.log.error({ error: err, route: gate.namespace }, 'Idempotent route ${route} failed after its reply was sent');
      } else {
        next(err);
      }
    });
  };
}

/**
 * The gate of an `@Idempotent` route, or undefined for any other route. `@spinajs/idempotency` is an optional peer,
 * loaded only here, so an app without `@Idempotent` routes loads neither it nor its table. An app on the ORM store
 * imports the package itself, before the boot: the Orm reads its models when it resolves.
 */
export async function createRouteIdempotencyGate(route: IRoute, path: string, container: IContainer, log: Log): Promise<Express.RequestHandler | undefined> {
  if (!route.Idempotency) {
    return undefined;
  }

  const namespace = `http:${String(route.Type).toUpperCase()} ${path}`;
  let idempotency: typeof Idempotency;
  try {
    idempotency = await import('@spinajs/idempotency');
  } catch (err) {
    throw new RouteRegistrationException(`${namespace} is @Idempotent, which needs the @spinajs/idempotency package installed`, err);
  }

  // registerConfigurationSchemaAtImport only logs on this lazy path, where the Configuration is resolved: a wrong
  // idempotency.* value must fail the registration, not the first request
  try {
    registerConfigurationSchema(idempotency.IDEMPOTENCY_CONFIGURATION_SCHEMA, container);
  } catch (err) {
    if (!(err instanceof InvalidConfiguration)) {
      throw err;
    }
    throw new RouteRegistrationException(`${namespace} is @Idempotent, and the idempotency configuration is invalid: ${err.message}`, err);
  }

  const service = await container.resolve(idempotency.IdempotencyService);
  if (service.Store instanceof idempotency.OrmIdempotencyStore && idempotency.ormModelRegistered(container) === false) {
    throw new RouteRegistrationException(
      `${namespace} is @Idempotent on OrmIdempotencyStore, but the Orm resolved before @spinajs/idempotency was imported, so __idempotency has neither a model nor a migration. Add import '@spinajs/idempotency' to the app entry, before the boot`,
    );
  }

  return createIdempotencyGate({
    namespace,
    options: route.Idempotency,
    ttlMs: service.ttlOf(route.Idempotency.ttl, `@Idempotent ttl of ${namespace}`),
    service,
    inFlight: idempotency.IdempotencyInFlight,
    keyReuse: idempotency.IdempotencyKeyReuse,
    claimConflict: idempotency.IdempotencyClaimConflict,
    outcomeUnknown: idempotency.IdempotencyOutcomeUnknown,
    fingerprint: idempotency.fingerprintOf,
    log,
  });
}
