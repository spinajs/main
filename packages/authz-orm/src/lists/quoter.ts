import { IdentifierQuoter } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

export function quoterOf(driver: OrmDriver): (name: string) => string {
  const q = driver.Container.resolve(IdentifierQuoter) as IdentifierQuoter;
  return (name) => q.quote(name);
}
