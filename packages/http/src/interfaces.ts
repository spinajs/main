import * as express from 'express';
import type { ResolvedIdempotentOptions } from './idempotency/options.js';
import { Constructor, AsyncService, Class, DI, isPromise } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { fs, IFileInfo } from '@spinajs/fs';
import type formidable from 'formidable';
import { loadXmlBuilder } from './lazy-modules.js';
import { CookieOptions } from 'express';
import { IPerfScope } from '@spinajs/log';
import type { ProxyTrust } from './middlewares/RealIp.js';
import type { IBodyLimitRule } from './body-limits.js';
import type { ErrorClass, ErrorStage, OnErrorHandler } from './errors/on-error.js';
import type { CapturedJsonReply } from './response-capture.js';

/**
 * Accept header enum
 */
export enum HttpAcceptHeaders {
  /**
   * Accept header for JSON
   */
  JSON = 1,

  /**
   * Accept header for HTML
   */
  HTML = 2,

  /**
   * Accept header for XML
   */
  XML = 4,

  /**
   * Plain text
   */
  TEXT = 8,

  /**
   * Image response
   */
  IMAGE = 16,

  PDF = 32,

  /**
   * Accept other request type ( let server decide )
   */
  OTHER = 64,

  /**
   * Accept all accept headers shorcut
   */
  ALL = 1 | 2 | 4,
}

/**
 * Lifecycle state of the HttpServer. Drives start() / stop() / dispose() and is
 * emitted on the DI bus as `http.server.listening` / `.closing` / `.closed`.
 */
export enum LifecycleState {
  Created,
  Listening,
  Closing,
  Closed,
}

export interface IHttpServerConfiguration {
  /**
   * Https server configuration
   */
  ssl: {
    key: string;
    cert: string;
  };

  /**
   * Http server port
   */
  port: number;

  /**
   * Middlewares used by server
   */
  middlewares: express.RequestHandler[];

  /**
   * Per-path body size limits, applied before `middlewares`. The first prefix match wins; other paths keep the
   * limits of the `middlewares` parsers ( 5mb JSON by default ).
   */
  bodyLimits?: IBodyLimitRule[];

  /**
   * Static files folder. Feel free to override this per app
   */
  Static: IHttpStaticFileConfiguration[];

  /**
   * Whitch accept headers we support (default JSON & HTML)
   */
  AcceptHeaders: HttpAcceptHeaders;

  FatalTemplate: string;

  /**
   * Grace period ( ms ) for a graceful shutdown before still-open connections
   * are force-closed. Idle keep-alive sockets are released immediately; only
   * genuinely in-flight requests use this window. Default 10000.
   */
  shutdownTimeout?: number;
}

/**
 * Config options for static files
 */
export interface IHttpStaticFileConfiguration {
  /**
   * virtual prefix in url eg. http://localhost:3000/static/images/kitten.jpg
   */
  Route: string;

  /**
   * full path to folder with static content
   */
  Path: string;
}

export enum FileTypeEnum {
  jpeg = 'image/jpeg',
  jpg = 'image/jpeg',
  png = 'image/png',
  gif = 'image/gif',
  webp = 'image/webp',
  svg = 'image/svg+xml',
  mp4 = 'video/mp4',
  mov = 'video/quicktime',
  avi = 'video/x-msvideo',
  webm = 'video/webm',
  mp3 = 'audio/mpeg',
  wav = 'audio/wav',
  ogg = 'audio/ogg',
  pdf = 'application/pdf',
  doc = 'application/msword',
  docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls = 'application/vnd.ms-excel',
  xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt = 'application/vnd.ms-powerpoint',
  pptx = 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt = 'text/plain',
  csv = 'text/csv',
  json = 'application/json',
  xml = 'application/xml',
  html = 'text/html',
  css = 'text/css',
  js = 'application/javascript',
  zip = 'application/zip',
  rar = 'application/x-rar-compressed',
  tar = 'application/x-tar',
  gz = 'application/gzip',
  any = '*/*',
}

export enum FileProportions {
  '16:9' = '16:9',
  '4:3' = '4:3',
  '1:1' = '1:1',
  '3:4' = '3:4',
  '9:16' = '9:16',
  'Free' = 'Free',
}

export interface FileValidationRules {
  resolution? : {
    minWidth?: number;
    maxWidth?: number;
    minHeight?: number;
    maxHeight?: number;
  }
  proportions?: FileProportions[];
  types?: FileTypeEnum[];

  /**
   * File size bounds in bytes. `min`/`max` are inclusive.
   */
  size?: {
    min?: number;
    max?: number;
  };
}

export type UploadFileMiddlewareDescriptor = string | Class<FileUploadMiddleware> | { options: any; service: string | Class<FileUploadMiddleware> };

/**
 * Uploaded file fields
 */
export interface IUploadedFile<T = any> {
  /**
   * File size in bytes
   */
  Size: number;

  /**
   * Original file name
   */
  Name: string;

  /**
   * Filename without path
   */
  BaseName: string;

  /**
   * Mime type of file
   */
  Type: string;
  LastModifiedDate?: Date;
  Hash?: string;

  /**
   * File system provider used to store this file eg. could be local, or aws s3 etc
   */
  Provider?: fs | null;

  /**
   * Additional data filled by middlewares if needed
   */
  Data?: T;

  /**
   *  File info obtained during upload when fileInfo option is set
   */
  Info?: IFileInfo;

  /**
   * Formidable original file data
   */
  OriginalFile: formidable.File;
}

export interface Request extends express.Request {
  storage: IActionLocalStoregeContext;

  /**
   * Raw request body bytes, captured by the express.json `verify` hook for
   * JSON requests. Consumed by the {@link ParameterType.RawBody} route arg for
   * webhook signature verification. Undefined for non-JSON requests.
   */
  rawBody?: Buffer;
}

/**
 * File upload provider, used to copy incoming formidable
 * file to desired location eg. local, aws s3 etc.
 */
export abstract class FormFileUploader {
  public abstract upload(file: IUploadedFile): Promise<IUploadedFile>;
}

export abstract class FileUploadMiddleware {
  public abstract beforeUpload(file: IUploadedFile, options?: IUploadOptions): Promise<IUploadedFile>;
}

export interface IServerTimingEntry {
  name: string;
  /** duration in ms */
  dur?: number;
  /** optional description */
  desc?: string;
}

export interface IActionLocalStoregeContext {
  requestId: string;
  /**
   * W3C trace id shared across services for one distributed trace. Seeded by
   * {@link RequestId} from an inbound `traceparent` header ( or freshly minted )
   * and merged into every log line by the ambient log context.
   */
  traceId?: string;
  /**
   * W3C span id identifying this service's span within the trace.
   */
  spanId?: string;
  responseStart: Date;
  responseEnd: Date;
  responseTime: number;
  realIp: string | undefined;
  /** The proxy trust `RealIp` resolved `realIp` with; read it with `requestProxyTrust(req)`. */
  proxyTrust?: ProxyTrust;
  /**
   * Phase markers contributed by middlewares / controllers, surfaced as the
   * `Server-Timing` response header when {@link ServerTiming} is enabled.
   */
  serverTiming?: IServerTimingEntry[];
  /**
   * Per-request perf accumulator ( query counts, span totals ) populated by the
   * Perf facade during the action and flushed by {@link PerfRollup} at finish.
   */
  perf?: IPerfScope;
  /**
   * Aborted when the request's deadline passed ({@link RequestDeadline}, `@Deadline`; reason a `TimeoutError`) or its
   * client went away (an `AbortError`). Pass it to the I/O of the action. Set only while a deadline applies.
   */
  signal?: AbortSignal;
  /** When the request's deadline passes, in epoch milliseconds. */
  deadline?: number;
}

export interface IResponseHeader {
  Name: string;
  Value: string | number | readonly string[];
}

export interface ICookie {
  Name: string;
  Value: string;
  Options: CookieOptions;
}

export interface IResponseOptions {
  Headers?: IResponseHeader[];
  Coockies?: ICookie[];
  StatusCode?: HTTP_STATUS_CODE;
}

/**
 * HTTP response statuses
 */
export enum HTTP_STATUS_CODE {
  /**
   * All ok with content
   */
  OK = 200,

  /**
   * Request is OK and new resource has been created.
   */
  CREATED = 201,

  /**
   * Request is accepted, but has not been completed yet.
   */
  ACCEPTED = 202,

  /**
   * ALl is ok & no content to return
   */
  NO_CONTENT = 204,

  /**
   * The server is delivering only part of the resource (byte serving) due to a range header
   * sent by the client. The range header is used by HTTP clients to enable resuming of
   * interrupted downloads, or split a download into multiple simultaneous streams.
   */
  PARTIAL_CONTENT = 206,

  /**
   * Resource has moved permanently to a new URL.
   */
  MOVED_PERMANENTLY = 301,

  /**
   * Resource found at a different URL (temporary redirect, method may change).
   */
  FOUND = 302,

  /**
   * Response to the request can be found at another URL using GET.
   */
  SEE_OTHER = 303,

  /**
   * Resource is not modified
   */
  NOT_MODIFIED = 304,

  /**
   * Temporary redirect preserving the request method and body.
   */
  TEMPORARY_REDIRECT = 307,

  /**
   * Permanent redirect preserving the request method and body.
   */
  PERMANENT_REDIRECT = 308,

  /**
   * Invalid request, eg. invalid parameters
   */
  BAD_REQUEST = 400,

  /**
   * Auth required
   */
  UNAUTHORIZED = 401,

  /**
   * No permission
   */
  FORBIDDEN = 403,

  /**
   * Resource not found
   */
  NOT_FOUND = 404,

  /**
   * Not acceptable request headers (Accept header)
   */
  NOT_ACCEPTABLE = 406,

  /**
   * Method not allowed eg. DELETE not allowed on resource, or login second time
   */
  NOT_ALLOWED = 405,

  /**
   * Conflict
   */
  CONFLICT = 409,

  /**
   * Eg. too big file
   */
  ENTITY_TOO_LARGE = 413,

  /**
   * The route does not take the request's content type
   */
  UNSUPPORTED_MEDIA_TYPE = 415,

  /**
   * Rate limit exceeded ( see ThrottleMiddleware )
   */
  TOO_MANY_REQUESTS = 429,

  /**
   * Internal server error.
   */
  INTERNAL_ERROR = 500,

  /**
   * Method not implemented
   */
  NOT_IMPLEMENTED = 501,

  /**
   * The server is not ready to handle the request — a dependency is down or the
   * app is still starting up. Used by the telemetry readiness endpoint.
   */
  SERVICE_UNAVAILABLE = 503,

  /**
   * Nothing answered the request by its deadline ( see RequestDeadline )
   */
  GATEWAY_TIMEOUT = 504,
}

/**
 * Avaible route types, match HTTP methods
 */
export enum RouteType {
  /**
   * POST method - used to create new resource or send data to server
   */
  POST = 'post',

  /**
   * GET method - used to retrieve data from server
   */
  GET = 'get',

  /**
   * PUT method - used to updates resource
   */
  PUT = 'put',

  /**
   * DELETE method - used to delete resource
   */
  DELETE = 'delete',

  /**
   * PATCH method - used to partially update resource eg. one field
   */
  PATCH = 'patch',

  /**
   * HEAD method - same as get, but returns no data. usefull for checking if resource exists etc.
   */
  HEAD = 'head',

  /**
   * FILE method - spine special route type. Internall its simple GET method, but informs that specified route returns binary file
   */
  FILE = 'file',

  UNKNOWN = 'unknown',
}

export enum UuidVersion {
  v1,
  v3,
  v4,
  v5,
}

/**
 * Avaible route parameters type
 */
export enum ParameterType {
  /**
   * Standard request whole fields
   */
  BodyField = 'BodyFieldRouteArgs',
  QueryField = 'QueryFieldRouteArgs',
  ParamField = 'ParamFieldRouteArgs',
  Headers = 'HeadersFieldRouteArgs',

  /**
   * Request type from request header
   */
  RequestType = 'RequestTypeRouteArgs',

  /**
   * Parameter is injected from DI container & resolved
   */
  FromDi = 'FromDi',

  /**
   * Parameter value is taken from query string eg. `?name=flavio`
   */
  FromQuery = 'FromQuery',

  /**
   * From message body, eg. POST json object
   */
  FromBody = 'FromBody',

  /**
   * From url params eg: `/:id`
   */
  FromParams = 'FromParams',

  /**
   * From form file field
   */
  FromFile = 'FromFile',

  /**
   * From form
   */
  FromForm = 'FromForm',

  /**
   * From cvs file
   */
  FromCSV = 'FromCSV',

  /**
   * From JSON file
   */
  FromJSONFile = 'FromJSONFile',

  /**
   * From user session
   */
  FromSession = 'FromSession',

  /**
   * From form field
   */
  FormField = 'FromFormField',

  /**
   * From model object
   */
  FromModel = 'FromModel',

  /**
   * Data from coockie
   */
  FromCookie = 'FromCookie',

  /**
   * From http header
   */
  FromHeader = 'FromHeader',

  /**
   * Client IP resolved by the RealIp middleware (X-Forwarded-For through http.trustProxy only)
   */
  Ip = 'IpRouteArgs',

  /**
   * Per-request id (matches the x-request-id response header)
   */
  RequestId = 'RequestIdRouteArgs',

  /**
   * User-Agent request header
   */
  UserAgent = 'UserAgentRouteArgs',

  /**
   * Referer / Referrer request header
   */
  Referer = 'RefererRouteArgs',

  /**
   * Raw request body Buffer (captured for JSON requests)
   */
  RawBody = 'RawBodyRouteArgs',

  /**
   * Parsed XML request body
   */
  FromXml = 'FromXmlRouteArgs',

  /**
   * Req from express
   */
  Req = 'ArgAsRequest',

  // Res from express
  Res = 'ArgAsResponse',

  /**
   * Other custom arguments
   */
  Other = 'Other',
}

export interface IFormOptions {
  multiples: boolean;
}

export interface IFormOptions {
  /**
   * default 1000; limit the number of fields that the Querystring parser will decode, set 0 for unlimited
   */
  maxFields?: number;

  /**
   *  default 20 * 1024 * 1024 (20mb); limit the amount of memory all fields together (except files) can allocate in bytes.
   */
  maxFieldsSize?: number;

  /**
   * default 'utf-8'; sets encoding for incoming form fields,
   */
  encoding?: string;
}
export interface IUploadOptions {
  /**
   * default false; include checksums calculated for incoming files, set this to some hash algorithm, see crypto.createHash for available algorithms
   */
  hashAlgorithm?: false | 'sha1' | 'md5' | 'sha256';

  encoding?: string;

  /**
   * File provider name used to upload files
   * Defaults to default provider set is copy immediately to fs
   *
   * Set this for eg. if lazy copying is needed eg. to aws s3 to not stall main thread
   */
  uploader?: string | Class<FormFileUploader> | { options: any; service: string | Class<FormFileUploader> };

  /**
   * File middlewares, eg. after upload file can be transformed to other format or zipped.
   * Middlewares are executed before file is uploaded to final destination by uploader
   */
  middlewares?: UploadFileMiddlewareDescriptor[];

  /**
   * File system provider used to upload files. Default is taken from configuration - __file_upload_default_provider__
   */
  fs?: string;

  /**
   * default false; when you call the .parse method, the files argument (of the callback) will contain arrays of files for inputs which submit multiple files using the HTML5 multiple attribute. Also, the fields argument will contain arrays of values for fields that have names ending with '[]'.
   */
  multiples?: boolean;

  enabledPlugins?: string[];

  /**
   *  default 200 * 1024 * 1024 (200mb); limit the size of uploaded file.
   */
  maxFileSize?: number;

  /**
   * Minimum file size, default 1 byte
   */
  minFileSize?: number;

  /**
   * default false; to include the extensions of the original files or not
   */
  keepExtensions?: boolean;

  /**
   * Should obtain fileInfo when uploading ?
   */
  fileInfo?: boolean;

  /**
   * Is this file / files required ?
   */
  required?: boolean;
}

/**
 * Describes parameters passed to route.
 */
export interface IRouteParameter<T = any> {
  /**
   * Parameter index in function args
   */
  Index: number;

  /**
   * Is value taken from query string, url params or message body
   */
  Type: ParameterType | string;

  /**
   * Schema for validation parameter ( raw value eg. to check if matches string / number constrain)
   */
  RouteParamSchema?: any;

  /**
   * Schema for paramater
   */
  Schema?: any;

  /**
   * Additional options
   */
  Options?: T;

  /**
   * Parameter runtime type eg. number or class
   */
  RuntimeType: any;

  /**
   * Name of parameter eg. `id`
   */
  Name: string;
}

/**
 * Route action call spefici data. Used to pass data / arguments when parsing
 * action parameters for specific call. Eg. to parse form data, and extract it
 * as different arguments.
 */
export interface IRouteCall {
  Payload: any;
}

export interface ICookieOptions {
  maxAge?: number | undefined;
  signed?: boolean | undefined;
  expires?: Date | undefined;
  httpOnly?: boolean | undefined;
  path?: string | undefined;
  domain?: string | undefined;
  secure?: boolean | undefined;
  sameSite?: boolean | 'lax' | 'strict' | 'none' | undefined;
}

export interface IRoute {
  /**
   * url path eg. /foo/bar/:id
   */
  Path: string | undefined;

  /**
   * HTTP request method, used internally. Not visible to others.
   */
  InternalType: RouteType;

  /**
   * SPINAJS API method type, mostly same as HTTP type, but can be non standard type eg. FILE
   * This type is visible outside in api discovery.
   */
  Type: RouteType;

  /**
   * Method name assigned to this route eg. `findUsers`
   */
  Method: string | symbol;

  /**
   * Custom route parameters taken from query string or message body
   */
  Parameters: Map<number, IRouteParameter>;

  /**
   * Assigned middlewares to route
   */
  Middlewares: IMiddlewareDescriptor[];

  /**
   * Assigned policies to route, one group per `@Policy()` call. AND inside a
   * group, OR between groups.
   */
  Policies: IPolicyGroup[];

  /**
   * Additional route options eg. file size etc.
   */
  Options: any;

  Schema: any;

  /**
   * `@OnError` handlers of this route, in declaration order.
   */
  ErrorHandlers?: IOnErrorDescriptor[];

  /**
   * Why the route is public on purpose (`@Public`). Metadata only: it does not change request handling.
   */
  Public?: string;

  /** `@Idempotent()` options; the route runs behind the Idempotency-Key gate. */
  Idempotency?: ResolvedIdempotentOptions;
}

export interface IOnErrorDescriptor {
  readonly On: readonly ErrorClass[];
  readonly Handler: OnErrorHandler;
  readonly Stages?: readonly ErrorStage[];
}

export interface IMiddlewareDescriptor {
  Type: Constructor<RouteMiddleware>;

  Options: any[];
}

export interface IController {
  /**
   * Express router with middleware stack
   */
  Router: express.Router;

  /**
   * Controller descriptor
   */
  Descriptor: IControllerDescriptor;

  /**
   * Base path for all controller routes eg. my/custom/path/
   *
   * It can be defined via `@BasePath` decorator, defaults to controller name without `Controller` part.
   */
  BasePath: string;
}

export type MiddlewareStage = 'beforePolicy' | 'outer' | 'inner';

/**
 * What every middleware hook gets. `route`, `controller` and `path` are set for a route middleware. A server middleware
 * has none in `onBefore` and `onAround`; in `onAfter` and `onFinish` it has them when the request matched a route.
 */
export interface IMiddlewareContext {
  readonly req: express.Request;
  readonly res: express.Response;
  /** The request's own store: the same object as `req.storage` and the action's AsyncLocalStorage context. */
  readonly storage: IActionLocalStoregeContext;
  readonly route?: IRoute;
  readonly controller?: IController;
  /** `http:<METHOD> <mounted path>` */
  readonly path?: string;
}

/** What `onAfter` gets: the reply about to be sent. */
export interface IReplyContext extends IMiddlewareContext {
  /** The action's reply, an error reply, or the `Response` an `onBefore` answered with. A hook may replace it; the final value is sent. */
  response: Response;
  /** The error the reply answers, when it is an error reply. */
  readonly error?: unknown;
}

/** What `onFinish` gets. */
export interface IFinishContext extends IMiddlewareContext {
  /** The client went away before the response finished. */
  readonly aborted: boolean;
}

/** What an around middleware gets for one request. */
export interface IRouteInvocation extends IMiddlewareContext {
  readonly route: IRoute;
  readonly controller: IController;
  readonly path: string;
}

/** How the rest of the route chain answered, as `proceed()` resolves it. */
export interface IRouteOutcome {
  /** The JSON reply as sent, or null when the answer was not a JSON reply. */
  readonly reply: CapturedJsonReply | null;
  /** The error the chain raised, when the error handlers answered it, or the error of a throwing `onAfter`; the reply is that error's answer. */
  readonly error?: unknown;
}

/**
 * The hooks a middleware may implement; a hook it leaves out is not mounted. Only a middleware the chain entered (its
 * `onBefore` resolved, or it has none, or its `onAround` started) gets `onAfter` and `onFinish`.
 *
 * State is shared, never copied: every hook sees the same `req`, `res` and `storage` for the whole request.
 */
export abstract class HttpMiddleware extends AsyncService {
  /**
   * Before the handler. Returning a `Response` answers the request: nothing after this middleware runs; `onAfter` and
   * `onFinish` still do. May return synchronously: a server middleware chain then goes on in the same tick.
   */
  public onBefore?(ctx: IMiddlewareContext): void | Response | Promise<void | Response>;

  /**
   * In the reply pipeline, for every framework reply (success, error, early answer, replay), before it is sent; inner
   * (last entered) first. Not called when the headers are already sent. A throw turns the reply into the error reply
   * for that error. May return synchronously: the pipeline then goes on without a tick.
   */
  public onAfter?(ctx: IReplyContext): void | Promise<void>;

  /** Once the response finished, or the client went away (`aborted`); not awaited by the next one. A throw is logged. */
  public onFinish?(ctx: IFinishContext): void | Promise<void>;

  /**
   * Wraps everything after this middleware: the later middlewares, the action, the error handlers and the reply.
   * `proceed()` runs that chain once and settles when the response finished; it rejects with RouteClientGone when the
   * client went away first. Not calling it ends the chain: the middleware must then answer, with `sendReply()` (the
   * entered middlewares' `onAfter` see the answer) or on `res` itself, and the answer must be sent, or its sending
   * awaited, before the returned promise settles; otherwise the request is answered 500. A throw before `proceed()`
   * goes to the route's error handlers (a server middleware's to the global error answer).
   */
  public onAround?(invocation: IMiddlewareContext, proceed: () => Promise<IRouteOutcome>): Promise<void>;
}

/**
 * A middleware of one route, or of every route of a controller (`@Middleware`). Typed per-request state goes on
 * `req.storage` (declaration merging on {@link IActionLocalStoregeContext}), untyped per-response state on `res.locals`.
 * `onAfter` and `onFinish` run inside the action's AsyncLocalStorage context; `onBefore` and `onAround` outside it.
 */
export abstract class RouteMiddleware extends HttpMiddleware {
  /**
   * 'beforePolicy' runs before the policy gate, so its onAfter and onFinish see a policy refusal; 'outer' runs right
   * after the gate, before every 'inner' middleware. Within a stage, the global ones (`http.routes.middlewares`) first,
   * then the controller's and the route's in declaration order. Unset means 'inner'.
   */
  public readonly Stage?: MiddlewareStage;

  /** Whether the middleware is mounted on this route at all; every route by default. */
  public isEnabled(_route: IRoute, _controller: IController): boolean {
    return true;
  }

  /**
   * Called once when the route is mounted, for enabled middlewares only, with the mounted path. A throw fails the
   * registration with RouteRegistrationException.
   */
  public onRegister?(route: IRoute, path: string, controller: IController): Promise<void> | void;

  public onAround?(invocation: IRouteInvocation, proceed: () => Promise<IRouteOutcome>): Promise<void>;
}

/**
 * A middleware of every request, mounted by `HttpServer` before static files and routing, in ascending `Order` (ties in
 * DI registration order). Its `onAfter` and `onFinish` run after the route's, in the exact reverse of the order it was
 * entered in. `onBefore` and `onAround` get no route; `onAfter` and `onFinish` get it when the request matched one.
 * Static files and replies an action wrote to `res` itself get `onFinish` only.
 */
export abstract class ServerMiddleware extends HttpMiddleware {
  public Order!: number;

  /** Called once, when `HttpServer` mounts the middleware: false mounts nothing. Settings are parsed here or in `resolve()`, never per request. */
  public isEnabled(): boolean {
    return true;
  }

  /** A third-party Express handler (compression) mounted at `Order` in place of `onBefore`/`onAround`; null mounts the hooks. */
  public handler?(): express.RequestHandler | null;
}

/**
 * Descriptor for policies eg. attached routes, passed options eg. token etc.
 */
export interface IPolicyDescriptor {
  Type: Constructor<BasePolicy> | string;

  Options: any[];
}

/**
 * Policies attached by ONE `@Policy()` call. Every member must resolve for the
 * group to pass ( AND ), while separate groups are alternatives ( OR ) - see
 * `createPolicyGate` in route-builder.ts.
 */
export type IPolicyGroup = IPolicyDescriptor[];

export type ResponseFunction = (req: express.Request, res: express.Response) => void;

export abstract class Response<T = any> {
  protected _errorCode!: number;
  protected _template!: string;

  constructor(protected responseData?: T | Promise<T> | null, protected options?: IResponseOptions) { }

  /** Status code `execute` answers with. Setting it is what `IResponseOptions.StatusCode` does. */
  public get statusCode(): number {
    return this.options?.StatusCode ?? this._errorCode;
  }

  public set statusCode(status: number) {
    this.options = { ...this.options, StatusCode: status };
  }

  /** The data `execute` sends; an `onAfter` hook may replace it. */
  public get data(): T | Promise<T> | null | undefined {
    return this.responseData;
  }

  public set data(data: T | Promise<T> | null | undefined) {
    this.responseData = data;
  }

  /** The headers `execute` sets, from `IResponseOptions.Headers`. */
  public get headers(): readonly IResponseHeader[] {
    return this.options?.Headers ?? [];
  }

  /** Sets a header `execute` sends, replacing one of the same name (case-insensitive) the response already had. */
  public setHeader(name: string, value: IResponseHeader['Value']): this {
    const others = this.headers.filter((h) => h.Name.toLowerCase() !== name.toLowerCase());
    this.options = { ...this.options, Headers: [...others, { Name: name, Value: value }] };
    return this;
  }

  public async execute(_req: express.Request, _res: express.Response, _next?: express.NextFunction): Promise<ResponseFunction | void> {
    const response = await this.prepareResponse();
    const { httpResponse } = await import('./responses.js');
    // the negotiated response function builds XML synchronously
    if (((DI.get(Configuration)?.get<number>('http.AcceptHeaders') ?? 0) & HttpAcceptHeaders.XML) !== 0) {
      await loadXmlBuilder();
    }
    return await httpResponse(response, this._template, {
      ...this.options,
      // Honor an explicit caller-supplied StatusCode; fall back to the
      // response type's semantic default (_errorCode). Previously _errorCode
      // always won, silently ignoring options.StatusCode.
      StatusCode: this.options?.StatusCode ?? this._errorCode,
    });
  }

  protected async prepareResponse(): Promise<T | T[]> {
    if (Array.isArray(this.responseData)) {
      return Promise.all(this.responseData as any[]) as Promise<T[]>;
    }
    return (isPromise(this.responseData) ? await this.responseData : this.responseData) as T;
  }
}

/**
 * Base class for policies.
 *
 * Policies checks if route can be executed eg. user have proper role
 */
export abstract class BasePolicy {
  /**
   * Checks if policy is enabled for given action & controlle eg. user session exists
   *
   * @param action action that is executed ( route info )
   * @param instance controller instance
   */
  public abstract isEnabled(action: IRoute, instance: IController): boolean;

  /**
   *
   * Executes policy, when throws exception - route is not executed
   *
   * @param req express request object
   */
  public abstract execute(req: express.Request, action: IRoute, instance: IController): Promise<void>;
}

/**
 * Descriptor for controller
 */
export interface IControllerDescriptor {
  /**
   * Controller routes
   */
  Routes: Map<string | symbol, IRoute>;

  /**
   * Controller - wise middlewares
   */
  Middlewares: IMiddlewareDescriptor[];

  /**
   * Controller - wise policies, one group per `@Policy()` call. AND inside a
   * group, OR between groups.
   */
  Policies: IPolicyGroup[];

  /**
   * Base url path for controller ( added for all child url's)
   */
  BasePath: string | null;

  /**
   * Configuration key that overrides `BasePath` when set; `BasePath` then holds the default.
   */
  BasePathConfig?: string | null;

  /**
   * Controller-wide `@OnError` handlers, in declaration order. They run after the route's own.
   */
  ErrorHandlers?: IOnErrorDescriptor[];

  /**
   * Why every route of the controller is public on purpose (`@Public` on the class). Metadata only.
   */
  Public?: string;

  /**
   * Absolute path of the source file that declared the controller, captured
   * from the V8 stack frame the first time a route decorator runs on the
   * class. Used by ControllersCache when a controller is registered through
   * DI rather than the directory scan, so JSDoc / parameter-name extraction
   * still has a real file to parse.
   */
  SourceFile?: string;
}

/**
 * Base class for data transformers.
 *
 * Data formatter helps transforms data for desired format.
 * Eg. we have API function that returns some data, but we want
 * to easily transform data for some client
 * eg. plain array to format that datatables.net can easily read
 */
export abstract class DataTransformer<T = any, U = any> {
  /**
   * Transforms data from one format to another
   *
   * @param data - input data
   */
  public abstract transform(data: T, request: express.Request): U;

  public abstract get Type(): string;
}

export type RouteCallback = (req: express.Request, res: express.Response, next: express.NextFunction) => (req: express.Request, res: express.Response) => void;

export interface IFileResponseOptions {
  /**
   * Path to file
   */
  path: string;

  /**
   * File system provider, default is local
   */
  provider?: string;

  /**
   * File name for the browser, sent in `Content-Disposition`. Defaults to the last segment of `path`
   * ( `ZipResponse`: with `.zip` added ); an inline `FileResponse` without one sends a bare `inline`.
   */
  filename?: string;

  /**
   * If not provided, it will be guessed
   */
  mimeType?: string;

  /**
   * Should delete file after downloaded eg. generated temp file
   */
  deleteAfterDownload?: boolean;

  /**
   * `FileResponse` only. `inline` lets the browser display the file and adds `X-Content-Type-Options: nosniff`.
   * Default `attachment`.
   */
  disposition?: 'attachment' | 'inline';

  /**
   * `FileResponse` only. Headers of the file answer ( 200, 206, 304, HEAD ), e.g. `Cache-Control` or
   * `Content-Security-Policy`. Unlike `IResponseOptions.Headers`, an error answer never carries them.
   */
  headers?: Record<string, string | number | readonly string[]>;
}

export interface ITemplateResponseOptions {
  template: string;
  provider?: string;
}
