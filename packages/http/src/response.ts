
import Express from 'express';

import { ResourceNotFound } from '@spinajs/exceptions';
import { redactUrl } from './util/redact-url.js';
import { guardResponseContract } from './contract.js';
import type { ContractRoute } from './contract.js';
import type { IContainer } from '@spinajs/di';
import { replyErrorOf, sendReply } from './reply-pipeline.js';

/**
 * Express middleware sending the reply set in res.locals.response (the action's, an `onBefore` answer or an `@OnError`
 * answer) through the reply pipeline.
 */
export function __handle_response__(container: IContainer, route?: ContractRoute) {
    return (req: Express.Request, res: Express.Response, next: Express.NextFunction) => {
        const response = res.locals.response;
        if (!response) {
            // the action answered res itself
            if (res.headersSent) {
                return;
            }
            next(new ResourceNotFound(`Resource not found ${req.method}:${redactUrl(req.originalUrl)}`));
            return;
        }

        if (typeof response.execute !== 'function') {
            next(new TypeError('res.locals.response.execute is not a function'));
            return;
        }

        guardResponseContract(res, container, route);

        const replied = replyErrorOf(res);
        sendReply(req, res, response, replied ? { error: replied.error } : {}).catch((err: Error) => {
            next(err);
        });
    };
}
