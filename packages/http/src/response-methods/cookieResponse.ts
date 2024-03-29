import * as express from 'express';
import { httpResponse } from '../responses.js';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import * as cs from 'cookie-signature';
import { HTTP_STATUS_CODE, ICookieOptions, Response } from '../interfaces.js';
import { CookieOptions } from 'express';

/**
 * Simpel wrapper for coockie response for api consistency.
 * It also signs cookie with coockie-secure
 *
 * @param cookieLifetime - cookie max age in seconds
 */
export class CookieResponse extends Response {
  constructor(protected name: string, protected coockieValue: string, protected cookieLifetime: number, protected signed?: boolean, protected data?: any, protected options?: ICookieOptions) {
    super(coockieValue);
  }

  public async execute(_req: express.Request, res: express.Response) {
    const cfg: Configuration = DI.get(Configuration);
    const opt = cfg.get<CookieOptions>('http.cookie.options', {});

    if (this.options) {
      Object.assign(opt, this.options);
    }

    if (this.cookieLifetime) {
      Object.assign(opt, { maxAge: this.cookieLifetime * 1000 });
    }

    if (!this.responseData) {
      res.clearCookie(this.name, opt as CookieOptions);
    } else {
      if (this.signed) {
        const secureKey = cfg.get<string>('http.cookie.secret');
        const signed = cs.sign(this.responseData, secureKey);

        res.cookie(this.name, signed, opt as any);
      } else {
        res.cookie(this.name, this.responseData, opt as any);
      }
    }

    return await httpResponse(this.data, HTTP_STATUS_CODE.OK, 'responses/ok');
  }
}
