import { AuthenticationFailed } from '@spinajs/exceptions';
import type { TriggeredBy } from '@spinajs/scheduler';

export interface IPrincipalStorage {
  User?: { Uuid?: string; Id?: number | string; Login?: string; Email?: string } | null;
  // set by @spinajs/rbac-http-token, which this package does not depend on
  TokenAuth?: { Uuid: string };
}

export function triggeredByFrom(storage: IPrincipalStorage | undefined): TriggeredBy {
  const user = storage?.User;

  if (!user) {
    throw new AuthenticationFailed('no authenticated principal for a scheduler action');
  }

  const name = user.Login ?? user.Email;

  return {
    kind: storage?.TokenAuth ? 'token' : 'user',
    id: String(user.Uuid ?? user.Id),
    ...(name ? { name } : {}),
  };
}
