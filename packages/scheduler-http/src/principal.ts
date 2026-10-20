import type { Principal } from '@spinajs/authz';
import { AuthenticationFailed, Forbidden } from '@spinajs/exceptions';
import type { TriggeredBy } from '@spinajs/scheduler';

function by(kind: TriggeredBy['kind'], principal: Principal): TriggeredBy {
  // the user principal carries the user record as `identity`; opaque to authz
  const identity = principal.identity as { Login?: unknown; Email?: unknown } | null | undefined;
  const name = identity?.Login ?? identity?.Email;

  return {
    kind,
    id: principal.id,
    ...(typeof name === 'string' && name !== '' ? { name } : {}),
  };
}

export function triggeredByFrom(principal: Principal | null | undefined): TriggeredBy {
  if (!principal || principal.authenticated !== true) {
    throw new AuthenticationFailed('no authenticated principal for a scheduler action');
  }

  switch (principal.type) {
    case 'user':
      return by(principal.source === 'token' ? 'token' : 'user', principal);
    case 'service':
      return by('service', principal);
    case 'agent':
      // an agent token acts for its user: recorded as that user's token, like the user's own api token
      if (principal.onBehalfOf?.type === 'user') {
        return by('token', principal.onBehalfOf);
      }
      break;
  }

  throw new Forbidden(`a ${principal.type} principal cannot trigger scheduler actions`);
}
