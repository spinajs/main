import { Constructor, Container, DI } from '@spinajs/di';
import { ManyToManyRelationList, OneToManyRelationList } from './relation-objects.js';
import { NullOrmMetricsSink, OrmMetricsSink } from './metrics.js';

/**
 * Default pool-telemetry sink: discards everything, so an app that wants no metrics pays nothing.
 * Register `PromOrmMetricsSink` from `@spinajs/metrics` over it to publish to prometheus.
 *
 * The dependency deliberately runs metrics -> orm and never the other way: `@spinajs/metrics`
 * depends on `@spinajs/http`, and putting the HTTP stack underneath the ORM inverts the graph.
 */
DI.register(NullOrmMetricsSink).as(OrmMetricsSink);

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
