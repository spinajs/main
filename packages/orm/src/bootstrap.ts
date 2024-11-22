import { Constructor, Container, DI } from '@spinajs/di';
import { ManyToManyRelationList, OneToManyRelationList } from './relation-objects.js';

/**
 * Register default relation type factory
 * for hasMany & hasManyToMany
 *
 * It can be overriden program-wide
 * by registering new factory that return other type.
 *
 * To change relation type for single use - set relation option
 * `type` property in decorators
 */
DI.register((_: Container, type: Constructor<unknown>) => (type.name.toLowerCase() === 'relation' ? OneToManyRelationList : type)).as('__orm_relation_has_many_factory__');
DI.register((_: Container, type: Constructor<unknown>) => (type.name.toLowerCase() === 'relation' ? ManyToManyRelationList : type)).as('__orm_relation_has_many_to_many_factory__');
