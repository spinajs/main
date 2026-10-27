import { getTypeName, isFactory } from '@spinajs/di';
import type { Class, Factory, IContainer } from '@spinajs/di';
import { quote as q } from '@spinajs/util';

import { AuthzConfigError } from '../contracts/errors.js';
import { AuthorizationModel } from '../contracts/model.js';
import { isObject } from '../engine/internal/util.js';

/** A class goes by its class name, a factory by its function name; an anonymous factory cannot be listed. */
function catalogName(type: Class<unknown> | Factory<unknown>): string | undefined {
  return isFactory(type) ? type.name || undefined : getTypeName(type);
}

/**
 * What `container` and its ancestors register under AuthorizationModel, by catalog name. As getTypesChain does for
 * classes, a name registered lower in the lineage replaces the ancestor's; a name registered twice in one container keeps both.
 */
export function modelCatalog(container: IContainer): Map<string, (Class<unknown> | Factory<unknown>)[]> {
  const catalog = new Map<string, { owner: IContainer; types: (Class<unknown> | Factory<unknown>)[] }>();
  for (const { type, container: owner } of container.Registry.getTypesChain(AuthorizationModel)) {
    const name = catalogName(type);
    if (name === undefined) continue;
    const entry = catalog.get(name);
    if (entry?.owner === owner) entry.types.push(type);
    else catalog.set(name, { owner, types: [type] });
  }
  return new Map([...catalog].map(([name, { types }]) => [name, types]));
}

/**
 * The models `names` lists, each from the registration under AuthorizationModel whose class (or factory function)
 * has that name, resolved in `container`: a class with its DI lifetime, a factory called with `container`.
 */
export async function resolveListedModels(container: IContainer, names: readonly string[], key: string, where: string): Promise<AuthorizationModel[]> {
  const catalog = modelCatalog(container);
  const known = (): string => [...catalog.keys()].sort().join(', ') || 'none';
  const out: AuthorizationModel[] = [];
  for (const name of names) {
    const lists = `${where}: ${key} lists ${q(name)}`;
    const types = catalog.get(name) ?? [];
    if (types.length === 0) throw new AuthzConfigError(`${lists}, but no class or named factory of that name is registered under AuthorizationModel (registered: ${known()}); is the package that provides it loaded?`);
    // Two registrations would make the pick depend on import order.
    if (types.length > 1) throw new AuthzConfigError(`${lists}, which is registered ${types.length} times`);
    const type = types[0];
    const model: unknown = isFactory(type) ? await type(container) : await container.resolve(type);
    // Duck-typed like the boot's own check: a second copy of @spinajs/authz breaks instanceof.
    if (!isObject(model) || typeof model.init !== 'function' || typeof model.evaluate !== 'function') {
      throw new AuthzConfigError(`${lists}, which resolves to ${isObject(model) ? getTypeName(model) : typeof model}, not an AuthorizationModel`);
    }
    out.push(model as unknown as AuthorizationModel);
  }
  return out;
}
