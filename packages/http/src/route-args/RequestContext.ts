import { RouteArgs, IRouteArgsResult } from './RouteArgs.js';
import { IRouteParameter, ParameterType, IRouteCall, Request } from '../interfaces.js';
import { Injectable } from '@spinajs/di';

/**
 * Client IP address, as resolved by the RealIp middleware
 * (`req.storage.realIp`, X-Forwarded-For aware with socket fallback).
 */
@Injectable()
export class IpRouteArgs extends RouteArgs {
  public get SupportedType(): ParameterType | string {
    return ParameterType.Ip;
  }

  public async extract(callData: IRouteCall, _args: unknown[], _param: IRouteParameter, req: Request): Promise<IRouteArgsResult> {
    return { CallData: callData, Args: req.storage?.realIp };
  }
}

/**
 * Per-request correlation id set by the RequestId middleware. Same value as
 * the `x-request-id` response header.
 */
@Injectable()
export class RequestIdRouteArgs extends RouteArgs {
  public get SupportedType(): ParameterType | string {
    return ParameterType.RequestId;
  }

  public async extract(callData: IRouteCall, _args: unknown[], _param: IRouteParameter, req: Request): Promise<IRouteArgsResult> {
    return { CallData: callData, Args: req.storage?.requestId };
  }
}

/**
 * `User-Agent` request header.
 */
@Injectable()
export class UserAgentRouteArgs extends RouteArgs {
  public get SupportedType(): ParameterType | string {
    return ParameterType.UserAgent;
  }

  public async extract(callData: IRouteCall, _args: unknown[], _param: IRouteParameter, req: Request): Promise<IRouteArgsResult> {
    return { CallData: callData, Args: req.headers['user-agent'] };
  }
}

/**
 * `Referer` request header, accepting the alternative `Referrer` spelling.
 */
@Injectable()
export class RefererRouteArgs extends RouteArgs {
  public get SupportedType(): ParameterType | string {
    return ParameterType.Referer;
  }

  public async extract(callData: IRouteCall, _args: unknown[], _param: IRouteParameter, req: Request): Promise<IRouteArgsResult> {
    const referer = (req.headers.referer ?? req.headers['referrer']) as string | undefined;
    return { CallData: callData, Args: referer };
  }
}

/**
 * Raw request body as a Buffer, captured by the express.json `verify` hook.
 * Intended for webhook signature verification, where the exact received bytes
 * must be hashed (JSON round-tripping would change them). Available for JSON
 * requests; undefined otherwise.
 */
@Injectable()
export class RawBodyRouteArgs extends RouteArgs {
  public get SupportedType(): ParameterType | string {
    return ParameterType.RawBody;
  }

  public async extract(callData: IRouteCall, _args: unknown[], _param: IRouteParameter, req: Request): Promise<IRouteArgsResult> {
    return { CallData: callData, Args: req.rawBody };
  }
}
