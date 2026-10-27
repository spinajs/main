import { getTypeName } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { quote as q } from '@spinajs/util';

import { AuthzConfigError } from '../contracts/errors.js';
import type { AuthorizationModel } from '../contracts/model.js';
import { isObject } from '../engine/internal/util.js';

/**
 * The models `names` lists, each resolved in `container` from the DI registration under that name: a class keeps its
 * DI lifetime, a factory runs again, in `container`, on every call.
 */
export async function resolveUsedModels(container: IContainer, names: readonly string[], key: string, where: string): Promise<AuthorizationModel[]> {
  const out: AuthorizationModel[] = [];
  for (const name of names) {
    const lists = `${where}: ${key} lists ${q(name)}`;
    const types = container.Registry.getTypes(name) ?? [];
    if (types.length === 0) throw new AuthzConfigError(`${lists}, but nothing is registered under that name; is the package that provides it loaded?`);
    // Two registrations would make the pick depend on import order.
    if (types.length > 1) throw new AuthzConfigError(`${lists}, which is registered ${types.length} times`);
    const model: unknown = await container.resolve(name);
    // Duck-typed like the boot's own check: a second copy of @spinajs/authz breaks instanceof.
    if (!isObject(model) || typeof model.init !== 'function' || typeof model.evaluate !== 'function') {
      throw new AuthzConfigError(`${lists}, which resolves to ${isObject(model) ? getTypeName(model) : typeof model}, not an AuthorizationModel`);
    }
    if (model.name !== name) throw new AuthzConfigError(`${lists}, which resolves to a model named ${q(model.name)}; register a model under its own name`);
    out.push(model as unknown as AuthorizationModel);
  }
  return out;
}
