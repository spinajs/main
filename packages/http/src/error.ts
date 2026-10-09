
import Express from 'express';
import _ from 'lodash';
import { DI, Constructor } from '@spinajs/di';
import { ResponseFunction, HTTP_STATUS_CODE, HttpAcceptHeaders, Response as HttpResponse } from './interfaces.js';
import { ServerError } from './response-methods/serverError.js';
import { BadRequestResponse } from './response-methods/badRequest.js';
import { BadRequest } from '@spinajs/exceptions';
import randomstring from 'randomstring';
import { Log } from '@spinajs/log';
import { Configuration } from '@spinajs/configuration';
import { redactUrl } from './util/redact-url.js';
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

const BODY_PARSE_FAILED_MESSAGE = 'request body is not valid JSON';

// body-parser forwards its errors with a string `type` and, on parse and verify failures, the raw request
// text as `body`. A parse failure's message quotes the input too.
function isBodyParserError(err: any): boolean {
    return typeof err === 'object' && err !== null && typeof err.type === 'string' && Object.prototype.hasOwnProperty.call(err, 'body');
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
        let response: HttpResponse | null = null;

        if (isBodyParserError(err) && err.type === 'entity.parse.failed') {
            logger.warn(`Request body parse failure (${err.type}) at ${req.method} ${req.path}`);

            error = { message: BODY_PARSE_FAILED_MESSAGE };
            const httpResponse = errorMap ? __resolve_error_response__(errorMap, new BadRequest(BODY_PARSE_FAILED_MESSAGE)) : null;
            response = httpResponse ? new httpResponse(error) : new BadRequestResponse(error);
        } else {
            error = {
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

            logger.error(err, `Error in controller ${req.method} at path ${redactUrl(req.originalUrl)}`);

            const httpResponse = errorMap ? __resolve_error_response__(errorMap, err) : null;
            if (httpResponse) {
                response = new httpResponse(error);
            } else {
                logger.warn(`Error type ${err.constructor?.name} dont have assigned http response. Map error to response via _http_error_map__ in DI container`);
                response = new ServerError(error);
            }
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