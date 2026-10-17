import { AuthzConfigError } from '@spinajs/authz';
import type { ResourceType } from '@spinajs/authz';
import type { Class } from '@spinajs/di';
import type { ModelBase } from '@spinajs/orm';

import type { AccessResourceOptions, OwnerOptions, ParentOptions, RelationOptions } from './api.js';
import { addParent, checkRelationName, checkType, ownerColumns, register, setOwner, setRelation, setSelf } from './registry.js';
import type { ModelClass } from './registry.js';

const ctorOf = (target: object): ModelClass => (typeof target === 'function' ? target : (target as { constructor: ModelClass }).constructor);

function propertyName(decorator: string, target: object, key: string | symbol): string {
  if (typeof key !== 'string') throw new AuthzConfigError(`${decorator}: ${ctorOf(target).name || '<anonymous class>'} decorates a symbol property; use a named property`);
  return key;
}

export function AccessResource(type: ResourceType): ClassDecorator {
  checkType(type, '@AccessResource');
  return (target) => {
    register(target, type);
  };
}

export function Parent(type: ResourceType, opts?: ParentOptions): PropertyDecorator {
  checkType(type, '@Parent');
  if (opts !== undefined && (opts === null || typeof opts !== 'object')) throw new AuthzConfigError(`@Parent('${type}'): options must be an object`);
  return (target, key) => {
    const property = propertyName(`@Parent('${type}')`, target, key);
    addParent(ctorOf(target), { property, column: property, type, nullable: opts?.nullable === true });
  };
}

export function Owner(opts?: OwnerOptions): PropertyDecorator {
  if (opts !== undefined && (opts === null || typeof opts !== 'object')) throw new AuthzConfigError('@Owner(): options must be an object');
  return (target, key) => {
    const column = propertyName('@Owner()', target, key);
    setOwner(ctorOf(target), ownerColumns(opts?.typeColumn === undefined ? column : { column, typeColumn: opts.typeColumn }, `${ctorOf(target).name || '<anonymous class>'}: @Owner()`));
  };
}

export function Self(): PropertyDecorator {
  return (target, key) => {
    setSelf(ctorOf(target), propertyName('@Self()', target, key));
  };
}

export function Relation(name: string, opts?: RelationOptions): PropertyDecorator {
  checkRelationName(name, '@Relation');
  if (opts !== undefined && (opts === null || typeof opts !== 'object')) throw new AuthzConfigError(`@Relation('${name}'): options must be an object`);
  return (target, key) => {
    const column = propertyName(`@Relation('${name}')`, target, key);
    const where = `${ctorOf(target).name || '<anonymous class>'}: @Relation('${name}')`;
    setRelation(ctorOf(target), name, ownerColumns(opts?.typeColumn === undefined ? column : { column, typeColumn: opts.typeColumn }, where, `relation '${name}'`));
  };
}

export function registerAccessResource(model: Class<ModelBase>, type: ResourceType, opts?: AccessResourceOptions): void {
  register(model, type, opts);
}
