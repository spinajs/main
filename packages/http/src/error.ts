
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
    const isProductionEnv = config.get<boolean>('configuration.isProduction');
    const errorMap = DI.get<Map<string, Constructor<HttpResponse>>>('__http_error_map__');



    return (err: any, req: Express.Request, res: Express.Response, next: Express.NextFunction) => {
        if (!err) {
            return next();
        }

        const error = {
            /**
             * By default Error object dont copy values like message ( they are not enumerable )
             * It only copies custom props added to Error ( via inheritance )
             */
            ...err,

            // make sure error message is added
            message: err.message,
            stack: {},
        };

        // in dev mode add stack trace for debugging
        if (!isProductionEnv) {
            error.stack = err.stack ? err.stack : err.parameter && err.parameter.stack;
        }

        logger.error(err, `Error in controller ${req.method} at path ${req.originalUrl}`);


        let response: HttpResponse = null;
        if (errorMap.has(err.constructor.name)) {
            const httpResponse = errorMap.get(err.constructor.name);
            response = new httpResponse(error);
        } else {
            logger.warn(`Error type ${error.constructor} dont have assigned http response. Map error to response via _http_error_map__ in DI container`);
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

                if (req.accepts('html') && (this.HttpConfig.AcceptHeaders & HttpAcceptHeaders.HTML) === HttpAcceptHeaders.HTML) {
                    // final fallback rendering error fails, we render embedded html error page
                    const ticketNo = randomstring.generate(7);
                    res.send(this.HttpConfig.FatalTemplate.replace('{ticket}', ticketNo));
                } else {
                    res.json(error);
                }
            });
    }
};