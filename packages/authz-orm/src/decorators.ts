import { AuthzConfigError, GLOBAL } from '@spinajs/authz';
import type { ResourceType } from '@spinajs/authz';
import type { Class } from '@spinajs/di';
import type { ModelBase } from '@spinajs/orm';

import { OrmScopePolicy } from './api.js';
import type * as api from './api.js';
import { addScopeColumn, addScopePolicy, register, setOwner } from './registry.js';
import type { ModelClass } from './registry.js';

type AccessResourceOptions = Parameters<typeof api.AccessResource>[1];

const ctorOf = (target: object): ModelClass => (typeof target === 'function' ? target : (target as { constructor: ModelClass }).constructor);

function propertyName(decorator: string, target: object, key: string | symbol): string {
  if (typeof key !== 'string') throw new AuthzConfigError(`${decorator}: ${ctorOf(target).name || '<anonymous class>'} decorates a symbol property; use a named property`);
  return key;
}

export function AccessResource(type: ResourceType, opts?: AccessResourceOptions): ClassDecorator {
  return (target) => {
    register(target, type, opts);
  };
}

export function registerAccessResource(model: Class<ModelBase>, type: ResourceType, opts?: Parameters<typeof AccessResource>[1]): void {
  register(model, type, opts);
}

export function Owner(): PropertyDecorator {
  return (target, key) => {
    setOwner(ctorOf(target), propertyName('@Owner()', target, key));
  };
}

export function ScopeColumn(column: string, scopeType: ResourceType): PropertyDecorator {
  if (typeof column !== 'string' || column.length === 0) throw new AuthzConfigError('@ScopeColumn: the column must be a non-empty string');
  if (typeof scopeType !== 'string' || scopeType.length === 0 || scopeType === GLOBAL.type) throw new AuthzConfigError(`@ScopeColumn('${column}'): the scope type must be a resource type`);
  return (target, key) => {
    addScopeColumn(ctorOf(target), { property: propertyName(`@ScopeColumn('${column}')`, target, key), column, scopeType });
  };
}

export function OrmScope(model: Class<ModelBase>, relation: string): ClassDecorator {
  if (typeof model !== 'function') throw new AuthzConfigError('@OrmScope: the model must be a class');
  if (typeof relation !== 'string' || relation.length === 0) throw new AuthzConfigError(`@OrmScope(${model.name}): the relation must be a non-empty string`);
  return (target) => {
    if (!(target.prototype instanceof OrmScopePolicy)) throw new AuthzConfigError(`@OrmScope(${model.name}, '${relation}'): ${target.name || '<anonymous class>'} must extend OrmScopePolicy`);
    addScopePolicy(model, relation, target);
  };
}
