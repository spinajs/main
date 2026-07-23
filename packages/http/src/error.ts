
import Express from 'express';
import _ from 'lodash';
import { DI, Constructor } from '@spinajs/di';
import { ResponseFunction, HTTP_STATUS_CODE, HttpAcceptHeaders, Response as HttpResponse } from './interfaces.js';
import { ServerError } from './response-methods/serverError.js';
import randomstring from 'randomstring';
import { Log } from '@spinajs/log';
import { Configuration } from '@spinajs/configuration';
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

        const error: any = {
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

        logger.error(err, `Error in controller ${req.method} at path ${req.originalUrl}`);


        let response: HttpResponse | null = null;
        if (errorMap && errorMap.has(err.constructor.name)) {
            const httpResponse = errorMap.get(err.constructor.name);
            response = new httpResponse!(error);
        } else {
            logger.warn(`Error type ${err.constructor?.name} dont have assigned http response. Map error to response via _http_error_map__ in DI container`);
            response = new ServerError(error);
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