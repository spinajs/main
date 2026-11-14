import type { Attributes } from '@opentelemetry/api';
import { principalKey } from '@spinajs/principal';
import { SpinaAttr } from '@spinajs/tracing';

import type { AuthenticationResult } from '../contracts/credentials.js';

export const AUTHENTICATE_SPAN = 'authn.authenticate';

export function authenticationAttributes(result: AuthenticationResult, strategy: string): Attributes {
  const attributes: Attributes = { [SpinaAttr.AuthnStrategy]: strategy, [SpinaAttr.AuthnStatus]: result.status };
  if (result.status === 'success') attributes[SpinaAttr.PrincipalId] = principalKey(result.identity);
  if (result.status === 'failure') attributes[SpinaAttr.AuthnReason] = result.reason;
  return attributes;
}
