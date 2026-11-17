import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AUDIT_WIDTHS, AuditConfigError, DEFAULT_TRAIL, audit, auditStore, trailConfig } from '@spinajs/audit';
import type { AuditInput, AuditOutcome, AuditWriteOptions } from '@spinajs/audit';
import { Config } from '@spinajs/configuration';
import { Autoinject, Container, DI, Injectable, NewInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { InvalidOption, UnexpectedServerError } from '@spinajs/exceptions';
import { REDACTED, RouteMiddleware, RouteType, redactFields, redactUrl, sensitiveKeyMatcher, stageOf } from '@spinajs/http';
import type { IFinishContext, IMiddlewareContext, IReplyContext, IRoute, MiddlewareStage } from '@spinajs/http';
import { Log, Logger } from '@spinajs/log-common';
import { isStringArray } from '@spinajs/util';

import { captureBody, describeError, isEmptyObject, redactPathParams } from './capture.js';
import type { IAuditError } from './capture.js';
import { ruleFor, rulesOf } from './match.js';
import { DEFAULT_AUDIT_REDACT, DEFAULT_MAX_BODY_BYTES } from './options.js';
import type { IAuditHttpConfig, IAuditOptions, IAuditRule } from './options.js';

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
  /** Joins the attempt of a rejecting trail to its outcome. */
  invocation?: string;
}

interface IAuditTarget {
  readonly action: string;
  readonly trail: string;
  /** The trail rejects: an attempt is confirmed before the route runs. */
  readonly rejecting: boolean;
}

type Storage = IMiddlewareContext['storage'];

// Resolved on every call, never cached: the one store http fills and the audit context reads.
function requestStore(): AsyncLocalStorage<Storage> {
  const store: AsyncLocalStorage<Storage> = DI.resolve(AsyncLocalStorage);
  return store;
}

type Res = IMiddlewareContext['res'];

const HTTP_METHOD_TYPES: ReadonlySet<string> = new Set([RouteType.GET, RouteType.POST, RouteType.PUT, RouteType.PATCH, RouteType.DELETE, RouteType.HEAD]);

// A HEAD request runs the action of the GET route it matched, so the route's method decides whether it is audited.
const methodOf = (req: IMiddlewareContext['req'], route: IRoute | undefined): string => (route && HTTP_METHOD_TYPES.has(route.Type) ? route.Type : req.method).toUpperCase();

function stringArray(value: unknown, name: string): string[] | undefined {
  if (value !== undefined && !isStringArray(value)) {
    throw new InvalidOption(`Audit: ${name} must be an array of strings`);
  }
  return value;
}

const compact = (data: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));

function checkedAction(action: string): string {
  if (action.trim() === '' || action.length > AUDIT_WIDTHS.action) {
    throw new AuditConfigError(`Audit: action must be 1 to ${AUDIT_WIDTHS.action} characters, got ${JSON.stringify(action)}`);
  }
  return action;
}

/**
 * The declaration first, then the rule, then audit.http, then the route name. An action set for one route, or by a rule,
 * is used as it is; set for several routes at once it is a prefix, so their events stay apart.
 */
function actionOf(declared: string | undefined, own: boolean, rule: IAuditRule | undefined, configured: string | undefined, route: IRoute, name: string): string {
  if (declared !== undefined) return checkedAction(own ? declared : `${declared}.${String(route.Method)}`);
  if (rule?.action !== undefined) return checkedAction(rule.action);
  if (configured !== undefined) return checkedAction(`${configured}.${String(route.Method)}`);
  return name.slice(0, AUDIT_WIDTHS.action);
}

function outcomeOf(aborted: boolean, error: IAuditError | undefined, res: Res): AuditOutcome {
  if (aborted) return 'failed';
  if (error === undefined) return 'ok';
  // the policy gate marks its stage before it refuses (a later stage overwrites the mark); its 500 is a crash, not a refusal
  return stageOf(res) === 'policy' && res.statusCode < 500 ? 'denied' : 'failed';
}

/**
 * Records who did what on a route as an `action` event of the audit trail: the redacted url, body and query, the
 * status, the error and the time. The actor, the impersonator, the client address and the trace id are stamped by the
 * audit context. The event is written once the response finished; a failed write never fails the request.
 *
 * ```ts
 * @Post()
 * @Middleware(Audit, { redact: ['pin'], trail: 'payments' })
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

  @Config('audit.http', { defaultValue: {} })
  protected Config!: IAuditHttpConfig | null;

  @Autoinject(Container)
  protected Container!: IContainer;

  @Logger('http')
  protected Log!: Log;

  private settings?: IAuditSettings;
  private target?: IAuditTarget;
  private readonly states = new WeakMap<Res, IAuditState>();

  constructor(protected Options: IAuditOptions = {}) {
    super();
  }

  // @Config is injected after the constructor ran, so the settings are merged on first use.
  protected get Settings(): IAuditSettings {
    if (this.settings) return this.settings;

    const cfg = this.Config ?? {};
    const options = this.Options ?? {};
    const methods = stringArray(options.methods, 'methods') ?? stringArray(cfg.methods, 'audit.http.methods');
    const maxBodyBytes = options.maxBodyBytes ?? cfg.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    if (typeof maxBodyBytes !== 'number' || !(maxBodyBytes >= 0)) {
      throw new InvalidOption('Audit: maxBodyBytes must be a number of bytes, 0 or more');
    }

    const redact = [...(stringArray(cfg.redact, 'audit.http.redact') ?? DEFAULT_AUDIT_REDACT), ...(stringArray(options.redact, 'redact') ?? [])];
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

  /** A throw fails the registration of the route: a trail that does not exist, or whose store is not installed, stops the boot and not every request. */
  public override async onRegister(route: IRoute, path: string): Promise<void> {
    const target = this.targetOf(route, path);
    const trail = trailConfig(target.trail, this.Container);
    await auditStore(trail, this.Container);
    this.target = { ...target, rejecting: trail.onFailure === 'reject' };
  }

  /** On a rejecting trail an attempt that cannot be recorded rejects: no policy and no action runs, and the client gets 503 (`AuditUnavailable`). */
  public override onBefore(ctx: IMiddlewareContext): void | Promise<void> {
    const { req, res, storage, route } = ctx;
    const settings = this.Settings;
    if (settings.methods && !settings.methods.has(methodOf(req, route))) return;

    const state = this.capture(req, settings);
    this.states.set(res, state);

    const target = this.target;
    if (!target?.rejecting) return;

    state.invocation = randomUUID();
    const attempt: AuditInput = { kind: 'action', action: target.action, outcome: 'attempt', at: state.at, data: compact(this.request(ctx, state)) };
    return this.confirm(attempt, target, storage);
  }

  public override onAfter({ res, error }: IReplyContext): void {
    const state = this.states.get(res);
    if (state && error !== undefined) {
      state.error = describeError(error);
    }
  }

  public override async onFinish(ctx: IFinishContext): Promise<void> {
    const { res, aborted } = ctx;
    const state = this.states.get(res);
    const target = this.target;
    if (!state || !target) return;

    const data = compact({
      ...this.request(ctx, state),
      status: !aborted || res.headersSent ? res.statusCode : undefined,
      ms: Math.round((performance.now() - state.started) * 100) / 100,
      aborted: aborted ? true : undefined,
      error: state.error,
    });
    const event: AuditInput = { kind: 'action', action: target.action, outcome: outcomeOf(aborted, state.error, res), at: state.at, data };
    // The response is finished, so the outcome can no longer stop anything: a failed write is logged by the audit
    // service, also on a rejecting trail, where it leaves an attempt without an outcome.
    const options: AuditWriteOptions = target.rejecting ? { trail: target.trail, mode: 'confirmed', onFailure: 'continue' } : { trail: target.trail, onFailure: 'continue' };
    await audit(this.Container).record(event, options);
  }

  protected targetOf(route: IRoute, path: string): Omit<IAuditTarget, 'rejecting'> {
    const cfg = this.Config ?? {};
    const options = this.Options ?? {};
    const name = `http:${String(route.Type).toUpperCase()} ${path}`;
    // A route's own @Middleware(Audit, options) built this instance with the very object it declared.
    const own = (route.Middlewares ?? []).some((m) => m.Type === Audit && m.Options[0] === this.Options);
    const rule = ruleFor(rulesOf(cfg.rules), String(route.Type), path);
    return { action: actionOf(options.action, own, rule, cfg.action, route, name), trail: options.trail ?? rule?.trail ?? cfg.trail ?? DEFAULT_TRAIL };
  }

  // onBefore runs outside the request's AsyncLocalStorage context, where the audit context finds the actor, the trace id and the origin.
  protected async confirm(attempt: AuditInput, target: IAuditTarget, storage: Storage): Promise<void> {
    try {
      await requestStore().run(storage, () => audit(this.Container).record(attempt, { trail: target.trail, mode: 'confirmed', onFailure: 'reject' }));
    } catch (error) {
      // A trail or a payload the service refuses is a fault of the server: neither the 400 InvalidArgument maps to nor the 503 of an outage.
      if (error instanceof AuditConfigError) throw new UnexpectedServerError(`audit: trail "${target.trail}" refused the attempt of ${target.action} as misconfigured`, error);
      throw error;
    }
  }

  protected capture(req: IMiddlewareContext['req'], settings: IAuditSettings): IAuditState {
    const state: IAuditState = { started: performance.now(), at: new Date(), params: { ...req.params } };
    try {
      if (!isEmptyObject(req.query)) state.query = redactFields(req.query, settings.redact);
      if (settings.includeBody) Object.assign(state, captureBody(req, settings.redact, settings.maxBodyBytes));
    } catch (error) {
      this.Log.warn({ error }, 'audit: the request could not be recorded in full');
      if (settings.includeBody) state.body = REDACTED;
    }
    return state;
  }

  /** What an event says about the request itself, whatever its outcome. */
  protected request({ req, storage, path }: IMiddlewareContext, state: IAuditState): Record<string, unknown> {
    return {
      route: path ?? '',
      method: req.method,
      url: redactPathParams(redactUrl(req.originalUrl), state.params, this.Settings.sensitive),
      requestId: storage?.requestId,
      query: state.query,
      body: state.body,
      bodyTruncated: state.bodyTruncated,
      invocation: state.invocation,
    };
  }
}
