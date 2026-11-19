
import Express from 'express';
import _ from 'lodash';
import { DI, Constructor } from '@spinajs/di';
import { ResponseFunction, HTTP_STATUS_CODE, HttpAcceptHeaders, Response as HttpResponse } from './interfaces.js';
import { ServerError } from './response-methods/serverError.js';
import randomstring from 'randomstring';
import { Log } from '@spinajs/log';
import { Configuration } from '@spinajs/configuration';
import { redactUrl } from './util/redact-url.js';

const INTERNAL_ERROR_MESSAGE = 'Internal server error';

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

/**
 * Whether {@link __handle_error__} answers `err` with the generic 500: its response is `ServerError` or none is mapped.
 * That body spreads the error's own properties and its stack, unless `configuration.isProduction` is set: then it is
 * a fixed message only.
 */
export function answeredAsServerError(err: unknown): boolean {
    const errorMap = DI.get<Map<string, Constructor<HttpResponse>>>('__http_error_map__');
    const response = errorMap ? __resolve_error_response__(errorMap, err) : null;
    return response === null || isServerErrorResponse(response);
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

        const httpResponse = errorMap ? __resolve_error_response__(errorMap, err) : null;
        const ResponseClass: Constructor<HttpResponse> = httpResponse ?? ServerError;
        const error = errorBody(err, ResponseClass, isProductionEnv);
        const response = new ResponseClass(error);

        const status = response.statusCode;
        const fields = { error: err, status, method: req.method, url: redactUrl(req.originalUrl) };
        if (status === 401 || status === 404) {
            // what scanners and clients polling without credentials produce on every request
            logger.debug(fields, 'Request refused at ${method} ${url}');
        } else if (status >= 400 && status <= 499) {
            logger.warn(fields, 'Request refused at ${method} ${url}');
        } else {
            logger.error(fields, 'Error in controller ${method} at path ${url}');
        }

        if (!httpResponse) {
            logger.warn({ errorType: err.constructor?.name }, 'Error type ${errorType} dont have assigned http response. Map error to response via _http_error_map__ in DI container');
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