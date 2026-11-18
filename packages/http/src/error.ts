
import Express from 'express';
import _ from 'lodash';
import { DI, Constructor } from '@spinajs/di';
import { ResponseFunction, HTTP_STATUS_CODE, HttpAcceptHeaders, Response as HttpResponse } from './interfaces.js';
import { ServerError } from './response-methods/serverError.js';
import { BadRequestResponse } from './response-methods/badRequest.js';
import { BadRequest, Forbidden, ResourceNotFound } from '@spinajs/exceptions';
import randomstring from 'randomstring';
import { Log } from '@spinajs/log';
import { Configuration } from '@spinajs/configuration';
import { redactUrl } from './util/redact-url.js';
import { EntityTooLargeException, UnsupportedMediaTypeException } from './exceptions.js';

const INTERNAL_ERROR_MESSAGE = 'Internal server error';
const MALFORMED_PATH_MESSAGE = 'request path is not valid percent-encoding';

// Resolved through the error map, so an app that remaps these exceptions answers refusals with its own response too.
const REFUSAL_EXCEPTIONS = new Map<number, new (message: string) => Error>([
    [400, BadRequest],
    [403, Forbidden],
    [404, ResourceNotFound],
    [413, EntityTooLargeException],
    [415, UnsupportedMediaTypeException],
]);

interface IRefusal {
    status: number;
    message: string;
    errorType: string;
}

/**
 * The response registered for an exception, or for the nearest MAPPED class it inherits from.
 *
 * The map is keyed by class NAME (that is what `@HandleException` registers), so an exact hit is
 * the common case. The walk up the prototype chain is what makes DOMAIN exceptions work: a
 * feature that declares `class GroupNotOwned extends Forbidden` to say WHICH rule refused the
 * request is the documented way to use these base classes, and without the walk every such
 * subclass fell through to a 500 - the framework answering "internal error" to an error it fully
 * understands, and leaking the domain message into the wrong status.
 *
 * An exact registration always wins over an inherited one, because the chain is walked from the
 * concrete class up.
 */
export function __resolve_error_response__(errorMap: Map<string, Constructor<HttpResponse>>, err: any): Constructor<HttpResponse> | null {
    for (let ctor = err?.constructor; typeof ctor === 'function' && ctor !== Object; ctor = Object.getPrototypeOf(ctor)) {
        if (ctor.name && errorMap.has(ctor.name)) {
            return errorMap.get(ctor.name)!;
        }
    }

    return null;
}

// body-parser forwards its errors with a string `type` and, on parse and verify failures, the raw request
// text as `body`. A parse failure's message quotes the input too.
function isBodyParserError(err: any): boolean {
    return typeof err === 'object' && err !== null && typeof err.type === 'string' && Object.prototype.hasOwnProperty.call(err, 'body');
}

/**
 * The fixed 400 message for a body-parser failure that answers without its own text, or null.
 *
 * A verify hook's throw arrives as the thrown error itself, with body-parser's 403 `status`, `type` and `body`
 * set on it. An app exception the error map knows (a `Forbidden` for a bad webhook signature) keeps its
 * mapped answer; anything else (a plain `Error`) would answer 500 with the hook's message.
 */
function bodyFailureMessage(err: any, errorMap: Map<string, Constructor<HttpResponse>> | null): string | null {
    if (!isBodyParserError(err)) {
        return null;
    }

    switch (err.type) {
        case 'entity.parse.failed':
            return 'request body is not valid JSON';
        case 'entity.verify.failed':
            return errorMap && __resolve_error_response__(errorMap, err) ? null : 'request body was refused';
        default:
            return null;
    }
}

/**
 * The 4xx answer an error raised before routing carries, or null.
 *
 * Only Express's router (the `URIError` of a malformed path) and http-errors (`expose`, set by body-parser and
 * raw-body) mean their status for the caller. Any other error's `status` may be someone else's, such as the answer
 * of an outgoing call made in an action.
 */
function refusalOf(err: unknown): IRefusal | null {
    if (!(err instanceof Error)) {
        return null;
    }

    // the router's message quotes the undecodable path segment
    const malformedPath = err instanceof URIError;
    const { message, constructor } = err;
    if (!malformedPath && !('expose' in err && err.expose === true)) {
        return null;
    }

    const status = ('status' in err ? err.status : undefined) ?? ('statusCode' in err ? err.statusCode : undefined);
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 499) {
        return null;
    }

    return { status, message: malformedPath ? MALFORMED_PATH_MESSAGE : message, errorType: constructor.name };
}

function refusalResponse(refusal: IRefusal, errorMap: Map<string, Constructor<HttpResponse>> | null): HttpResponse {
    const exception = REFUSAL_EXCEPTIONS.get(refusal.status);
    const mapped = errorMap && exception ? __resolve_error_response__(errorMap, new exception(refusal.message)) : null;
    const ResponseClass: Constructor<HttpResponse> = mapped ?? BadRequestResponse;
    return new ResponseClass({ message: refusal.message }, { StatusCode: refusal.status });
}

/**
 * Whether {@link __handle_error__} answers `err` with the generic 500: its response is `ServerError` or none is mapped.
 * That body spreads the error's own properties and its stack, unless `configuration.isProduction` is set: then it is
 * a fixed message only.
 */
export function answeredAsServerError(err: unknown): boolean {
    const errorMap = DI.get<Map<string, Constructor<HttpResponse>>>('__http_error_map__') ?? null;
    if (bodyFailureMessage(err, errorMap)) {
        return false;
    }

    const response = errorMap ? __resolve_error_response__(errorMap, err) : null;
    return response === null ? refusalOf(err) === null : isServerErrorResponse(response);
}

function isServerErrorResponse(response: Constructor<HttpResponse>): boolean {
    return response === ServerError || response.prototype instanceof ServerError;
}

function errorBody(err: any, response: Constructor<HttpResponse>, isProductionEnv: boolean): Record<string, unknown> {
    // a server error's message and properties describe the server (a query, a path, a nested error): only the log keeps them
    if (isProductionEnv && isServerErrorResponse(response)) {
        return { message: INTERNAL_ERROR_MESSAGE };
    }

    const error: Record<string, unknown> = {
        /**
         * By default Error object dont copy values like message ( they are not enumerable )
         * It only copies custom props added to Error ( via inheritance )
         */
        ...err,

        // make sure error message is added
        message: err.message,
    };

    if (isBodyParserError(err)) {
        delete error.body;
    }

    // in dev mode add stack trace for debugging. In production the stack is
    // omitted entirely rather than serialized as an empty object.
    if (!isProductionEnv) {
        error.stack = err.stack ? err.stack : err.parameter && err.parameter.stack;
    }

    return error;
}

export function __handle_error__() {

    const logger = DI.resolve(Log, ['http']);
    const config = DI.get(Configuration);

    if(!config){
        logger.warn('Configuration service is not registered in DI container, error handler will use default values. Register configuration service to use custom configuration');
    }

    const isProductionEnv = config ? config.get<boolean>('configuration.isProduction') : false;
    const errorMap = DI.get<Map<string, Constructor<HttpResponse>>>('__http_error_map__');
    const acceptHeaders = config ? config.get<HttpAcceptHeaders>('http.AcceptHeaders') : null;
    const fatalTemplate = config ? config.get<string>('http.FatalTemplate') : null;


    return (err: any, req: Express.Request, res: Express.Response, next: Express.NextFunction) => {
        if (!err) {
            return next();
        }

        let error: any;
        let response: HttpResponse;

        const bodyFailure = bodyFailureMessage(err, errorMap);
        const httpResponse = bodyFailure || !errorMap ? null : __resolve_error_response__(errorMap, err);
        const refusal = bodyFailure || httpResponse ? null : refusalOf(err);

        if (bodyFailure) {
            logger.warn({ failure: err.type, method: req.method, url: redactUrl(req.originalUrl) }, 'Request body failure (${failure}) at ${method} ${url}');

            error = { message: bodyFailure };
            const badRequest = errorMap ? __resolve_error_response__(errorMap, new BadRequest(bodyFailure)) : null;
            response = badRequest ? new badRequest(error) : new BadRequestResponse(error);
        } else if (refusal) {
            logger.warn({ status: refusal.status, errorType: refusal.errorType, method: req.method, url: redactUrl(req.originalUrl) }, 'Request refused with ${status} (${errorType}) at ${method} ${url}');

            error = { message: refusal.message };
            response = refusalResponse(refusal, errorMap);
        } else {
            logger.error({ error: err, method: req.method, url: redactUrl(req.originalUrl) }, 'Error in controller ${method} at path ${url}');

            if (!httpResponse) {
                logger.warn({ errorType: err.constructor?.name }, 'Error type ${errorType} dont have assigned http response. Map error to response via _http_error_map__ in DI container');
            }

            const ResponseClass: Constructor<HttpResponse> = httpResponse ?? ServerError;
            error = errorBody(err, ResponseClass, isProductionEnv);
            response = new ResponseClass(error);
        }

        response
            .execute(req, res)
            .then((callback?: ResponseFunction | void) => {
                if (callback) {
                    callback(req, res);
                }
            })
            .catch((err: Error) => {
                // last resort error handling

                logger.fatal(err, `Cannot send error response`);
                res.status(HTTP_STATUS_CODE.INTERNAL_ERROR);

                if (acceptHeaders && fatalTemplate && req.accepts('html') && (acceptHeaders & HttpAcceptHeaders.HTML) === HttpAcceptHeaders.HTML) {
                    // final fallback rendering error fails, we render embedded html error page
                    const ticketNo = randomstring.generate(7);
                    res.send(fatalTemplate.replace('{ticket}', ticketNo));
                } else {
                    res.json(error);
                }
            });
    }
};