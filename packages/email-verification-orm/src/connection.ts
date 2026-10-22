import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';

export const DEFAULT_ORM_CONNECTION = 'email-verification-connection';

export function ormConnection(): string {
  const cfg = DI.get(Configuration) as Configuration | undefined;
  return cfg?.get<string>('emailVerification.orm.connection') ?? DEFAULT_ORM_CONNECTION;
}
