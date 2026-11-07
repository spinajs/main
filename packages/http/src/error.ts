
import Express from 'express';
import _ from 'lodash';
import { DI, Constructor } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { HTTP_ERROR_MAP } from './tokens.js';
import { HTTP_STATUS_CODE, HttpAcceptHeaders, Response as HttpResponse } from './interfaces.js';
import { sendReply } from './reply-pipeline.js';
import { ServerError } from './response-methods/serverError.js';
import { BadRequestResponse } from './response-methods/badRequest.js';
import { BadRequest, CodedHttpException } from '@spinajs/exceptions';
import randomstring from 'randomstring';
import { Log } from '@spinajs/log';
import { Configuration, isProduction } from '@spinajs/configuration';
import { redactUrl, urlPath } from './util/redact-url.js';
import { PROBLEM_CONTENT_TYPE, toProblem } from './problem.js';
import { guardResponseContract } from './contract.js';
import type { ProblemDetails, ProblemOptions } from './problem.js';
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

const isErrorStatus = (status: unknown): status is number => Number.isInteger(status) && (status as number) >= 400 && (status as number) <= 599;

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
 * Whether {@link __handle_error__} answers `err` with the generic 500: its response is `ServerError` or none is mapped.
 * That body is a problem document naming the exception's message, so such an error can carry internals.
 */
export function answeredAsServerError(err: unknown): boolean {
    const errorMap = DI.get(HTTP_ERROR_MAP) ?? null;
    if (bodyFailureMessage(err, errorMap)) {
        return false;
    }

    const response = errorMap ? __resolve_error_response__(errorMap, err) : null;
    return response === null || response === ServerError || response.prototype instanceof ServerError;
}

/** The error map's reply for an error, and the problem document a failed send falls back to. */
export interface IMappedErrorReply {
    readonly response: HttpResponse;
    readonly problem: ProblemDetails;
}

/** Builds the error map's reply for an error, logging the error; the route's error handlers do not run here. */
export function errorReplyFactory(): (err: any, req: Express.Request) => IMappedErrorReply {
    const logger = DI.resolve(Log, ['http']);
    const config = DI.get(Configuration);

    if (!config) {
        logger.warn('Configuration service is not registered in DI container, error handler will use default values. Register configuration service to use custom configuration');
    }

    const isProductionEnv = isProduction(config ?? undefined);
    const errorMap = DI.get(HTTP_ERROR_MAP) ?? null;
    const baseProblemOptions: ProblemOptions = {
        includeStack: config ? config.get<boolean>('http.errors.includeStack', false) === true : false,
        includeFields: config ? (config.get<string[]>('http.errors.includeFields', []) ?? []) : [],
        isProduction: isProductionEnv,
    };

    return (err: any, req: Express.Request) => {
        const bodyFailure = bodyFailureMessage(err, errorMap);
        const problemOptions: ProblemOptions = { ...baseProblemOptions, instance: urlPath(req.originalUrl) };

        if (bodyFailure) {
            logger.warn({ failure: err.type, method: req.method, url: redactUrl(req.originalUrl) }, 'Request body failure (${failure}) at ${method} ${url}');

            const badRequest = new BadRequest(bodyFailure);
            const ResponseClass: Constructor<HttpResponse> = (errorMap ? __resolve_error_response__(errorMap, badRequest) : null) ?? BadRequestResponse;
            const problem = toProblem(badRequest, HTTP_STATUS_CODE.BAD_REQUEST, problemOptions);
            const response = new ResponseClass(problem);
            problem.status = response.statusCode;
            return { response, problem };
        }

        logger.error({ error: err, method: req.method, url: redactUrl(req.originalUrl) }, 'Error in controller ${method} at path ${url}');

        const httpResponse = errorMap ? __resolve_error_response__(errorMap, err) : null;
        const ResponseClass: Constructor<HttpResponse> = httpResponse ?? ServerError;
        if (!httpResponse) {
            logger.warn({ errorType: err.constructor?.name }, 'Error type ${errorType} dont have assigned http response. Map error to response via _http_error_map__ in DI container');
        }

        const redact = isProductionEnv && (ResponseClass === ServerError || ResponseClass.prototype instanceof ServerError);
        const fields = err instanceof CodedHttpException ? [...problemOptions.includeFields, 'details'] : problemOptions.includeFields;
        const problem = toProblem(err, HTTP_STATUS_CODE.INTERNAL_ERROR, { ...problemOptions, includeFields: fields, redact });
        const response = new ResponseClass(problem);
        problem.status = err instanceof CodedHttpException && isErrorStatus(err.status) ? err.status : response.statusCode;
        return { response, problem };
    };
}

/** Makes the reply for an error in place of the error map; see `ErrorHandlerMiddleware.reply`. */
export type ErrorReplyFunction = (err: unknown, req: Express.Request) => HttpResponse | Promise<HttpResponse>;

export function __handle_error__(container: IContainer = DI.RootContainer, reply?: ErrorReplyFunction) {

    const logger = DI.resolve(Log, ['http']);
    const config = DI.get(Configuration);
    const acceptHeaders = config ? config.get<HttpAcceptHeaders>('http.AcceptHeaders') : null;
    const fatalTemplate = config ? config.get<string>('http.FatalTemplate') : null;
    const replyFor = errorReplyFactory();

    return (err: any, req: Express.Request, res: Express.Response, next: Express.NextFunction) => {
        if (!err) {
            return next();
        }

        // the reply already started: a second one cannot be sent. As express does, a reply cut short is not ended
        // as if it were whole: the connection is dropped.
        if (res.headersSent) {
            logger.error({ error: err, method: req.method, url: redactUrl(req.originalUrl) }, 'Error in controller ${method} at path ${url} after its reply started');
            if (!res.writableEnded) {
                res.destroy();
            }
            return;
        }

        let mapped: IMappedErrorReply | undefined;
        const send = (response: HttpResponse) => {
            guardResponseContract(res, container);

            return sendReply(req, res, response, {
                error: err,
                errorReply: async (failure) => ({ response: reply ? await reply(failure, req) : replyFor(failure, req).response, error: failure }),
            });
        };

        let sending: Promise<void>;
        if (reply) {
            sending = Promise.resolve().then(() => reply(err, req)).then(send);
        } else {
            mapped = replyFor(err, req);
            sending = send(mapped.response);
        }

        sending.catch((sendError: Error) => {
            // last resort error handling
            logger.fatal(sendError, `Cannot send error response`);
            if (res.headersSent) {
                return;
            }
            res.status(HTTP_STATUS_CODE.INTERNAL_ERROR);

            if (acceptHeaders && fatalTemplate && req.accepts('html') && (acceptHeaders & HttpAcceptHeaders.HTML) === HttpAcceptHeaders.HTML) {
                // final fallback rendering error fails, we render embedded html error page
                const ticketNo = randomstring.generate(7);
                res.send(fatalTemplate.replace('{ticket}', ticketNo));
            } else {
                res.type(PROBLEM_CONTENT_TYPE).json((mapped ?? replyFor(err, req)).problem);
            }
        });
    }
};
