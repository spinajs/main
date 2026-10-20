
import Express from 'express';

import _ from 'lodash';

import { ResponseFunction } from './interfaces.js';
import { ResourceNotFound } from '@spinajs/exceptions';
import { redactUrl } from './util/redact-url.js';

/**
 * Express middleware that handles responses set in res.locals.response
 *
 * @returns Express middleware that handles responses set in res.locals.response
 */
export function __handle_response__() {
    return (req: Express.Request, res: Express.Response, next: Express.NextFunction) => {
        if (!res.locals.response) {
            next(new ResourceNotFound(`Resource not found ${req.method}:${redactUrl(req.originalUrl)}`));
            return;
        }

        res.locals.response
            .execute(req, res)
            .then((callback: ResponseFunction) => {
                if (callback) {
                    return callback(req, res);
                }
            })
            .catch((err: Error) => {
                next(err);
            });
    };
}

