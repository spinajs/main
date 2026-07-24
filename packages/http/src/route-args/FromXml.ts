import { RouteArgs, IRouteArgsResult } from './RouteArgs.js';
import { IRouteParameter, ParameterType, IRouteCall, Request } from '../interfaces.js';
import { Injectable } from '@spinajs/di';
import { BadRequest } from '@spinajs/exceptions';
import { XMLParser, XMLValidator, X2jOptions } from 'fast-xml-parser';

/**
 * Parses an XML request body into a plain object.
 *
 * Relies on the `express.text` body parser (configured for XML content types)
 * having placed the raw XML string in `req.body`. `@FromXml()` may be given
 * fast-xml-parser {@link X2jOptions} to customise parsing.
 *
 * Malformed XML is reported as a 400 BadRequest rather than an unhandled 500.
 */
@Injectable()
export class FromXmlRouteArgs extends RouteArgs {
  public get SupportedType(): ParameterType | string {
    return ParameterType.FromXml;
  }

  public async extract(callData: IRouteCall, _args: unknown[], param: IRouteParameter<Partial<X2jOptions>>, req: Request): Promise<IRouteArgsResult> {
    const body = req.body;

    // No body -> nothing to parse (keep optional params optional).
    if (body === undefined || body === null || body === '') {
      return { CallData: callData, Args: null };
    }

    // Already an object (some upstream parser handled it) -> pass through.
    if (typeof body !== 'string') {
      return { CallData: callData, Args: body };
    }

    const valid = XMLValidator.validate(body);
    if (valid !== true) {
      throw new BadRequest(`Invalid XML body: ${valid.err?.msg ?? 'malformed XML'}`);
    }

    const parser = new XMLParser({ ignoreAttributes: false, ...(param.Options ?? {}) });
    try {
      return { CallData: callData, Args: parser.parse(body) };
    } catch (err) {
      throw new BadRequest(`Invalid XML body: ${(err as Error).message}`);
    }
  }
}
