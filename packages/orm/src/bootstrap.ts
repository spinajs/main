import { Constructor, Container, DI } from '@spinajs/di';
import { ManyToManyRelationList, OneToManyRelationList } from './relation-objects.js';

/**
 * Pool telemetry needs no registration: the ORM publishes into the `Metrics` singleton from
 * `@spinajs/telemetry-common`, which self-registers via its own `@Injectable()` and owns a private
 * prom-client registry. `@spinajs/telemetry` re-exports that very class, so its `/metrics`
 * endpoint renders the same registry the ORM writes to.
 *
 * The dependency runs orm -> telemetry-common and never orm -> telemetry: the latter pulls in
 * `@spinajs/http`, and putting the HTTP stack underneath every database connection inverts the
 * graph. Same reason `configuration-common` and `log-common` exist.
 */

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
