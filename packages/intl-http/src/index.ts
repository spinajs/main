import { Config } from '@spinajs/configuration';
import { Injectable } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { _check_arg, _is_string, _between } from '@spinajs/util';
import { ServerMiddleware, Request as sRequest, Route, Parameter, RouteArgs, IRouteCall, IRouteParameter } from '@spinajs/http';
import type { IMiddlewareContext, IReplyContext } from '@spinajs/http';

export * from './schema.js';

declare module '@spinajs/http' {
  interface IActionLocalStoregeContext {
    language: string;
  }
}

function extractLanguageFromRequest(req: sRequest, param: string) {
  if (req.query[param]) {
    return req.query[param] as string;
  } else if (req.cookies?.[param]) {
    return req.cookies[param];
  }

  const header = `x-${param}`.toLowerCase();
  if (req.headers[header]) {
    return req.headers[header] as string;
  }

  return null;
}

// RFC 5646 in its common shape: a 2-3 letter language, then subtags. `_` is taken for `-` (`pt_BR`).
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;

/** The language as a `Content-Language` value, or undefined when it is no language tag (a header must never fail). */
function contentLanguageOf(language: string | undefined): string | undefined {
  const tag = language?.replace(/_/g, '-');
  return tag !== undefined && LANGUAGE_TAG.test(tag) ? tag : undefined;
}

export function Lang(allowedLanguages?: string[]) {
  return Route(Parameter('LangArgument', null, { allowedLanguages }));
}

function _validate(param: unknown) {
  
  // lang param is optional
  if (param === null || param === undefined) return;

  _check_arg(_is_string(), _between(2, 5))(param, 'lang parameter');
}

@Injectable()
export class LangArgument extends RouteArgs {
  @Config('intl.queryParameter')
  protected LangQueryParameter!: string;

  @Config('intl.defaultLocale')
  protected defaultLocale!: string;

  get SupportedType(): string {
    return 'LangArgument';
  }

  public async extract(callData: IRouteCall, _args: unknown[], param: IRouteParameter, req: sRequest) {
    const lang = extractLanguageFromRequest(req, this.LangQueryParameter);

    _validate(lang);

    const language = lang || this.defaultLocale;
    const allowed = param.Options?.allowedLanguages as string[] | undefined;

    if (allowed && allowed.indexOf(language) === -1) {
      throw new InvalidArgument(`Language not supported, allowed languages are ${allowed.join(',')}`);
    }

    return { CallData: callData, Args: language };
  }
}

@Injectable(ServerMiddleware)
export class IntlHttpMiddleware extends ServerMiddleware {
  @Config('intl.queryParameter')
  protected LangQueryParameter!: string;

  @Config('intl.defaultLocale')
  protected defaultLocale!: string;

  @Config('intl.http.vary', { defaultValue: true })
  protected Vary!: boolean;

  protected varyFields?: string[];

  constructor() {
    super();
    this.Order = 1;
  }

  public onBefore({ req, storage }: IMiddlewareContext): void {
    storage.language = this.detectLanguage(req as sRequest);
  }

  /**
   * `Content-Language` when the language is a language tag and the answer set none, and, unless `intl.http.vary` is
   * false, `Vary` on the request headers {@link varyHeaders} names.
   */
  public onAfter({ res, response, storage }: IReplyContext): void {
    const contentLanguage = contentLanguageOf(storage.language);
    if (contentLanguage && !res.hasHeader('Content-Language') && !response.headers.some((h) => h.Name.toLowerCase() === 'content-language')) {
      res.setHeader('Content-Language', contentLanguage);
    }
    if (!this.Vary) {
      return;
    }
    const fields = (this.varyFields ??= this.varyHeaders());
    // a hook's header replaces the answer's own one of the same name, so a Vary the answer set is joined here
    const own = response.headers.find((h) => h.Name.toLowerCase() === 'vary');
    if (own) {
      const listed = String(own.Value).split(',').map((f) => f.trim()).filter(Boolean);
      if (listed.includes('*')) {
        return;
      }
      const missing = fields.filter((f) => !listed.some((l) => l.toLowerCase() === f.toLowerCase()));
      response.setHeader('Vary', [...listed, ...missing].join(', '));
    } else {
      res.vary(fields.join(', '));
    }
  }

  /**
   * The request headers {@link detectLanguage} reads, for `Vary`: the cookie and the `x-<name>` header. A subclass that
   * reads more (`Accept-Language`) adds them here. Called once, on the first reply.
   */
  protected varyHeaders(): string[] {
    return ['Cookie', `X-${this.LangQueryParameter.charAt(0).toUpperCase()}${this.LangQueryParameter.slice(1)}`];
  }

  /**
   * The language of the request: query, cookie, then `x-<name>` header, else `intl.defaultLocale`. Throws
   * InvalidArgument for an explicit value that is not 2 to 5 characters.
   */
  protected detectLanguage(req: sRequest): string {
    const lang = extractLanguageFromRequest(req, this.LangQueryParameter) as string | null;
    _validate(lang);
    return lang ?? this.defaultLocale;
  }
}

/** @deprecated misspelled name, use IntlHttpMiddleware */
export const IntHttpMiddleware = IntlHttpMiddleware;
/** @deprecated misspelled name, use IntlHttpMiddleware */
export type IntHttpMiddleware = IntlHttpMiddleware;
