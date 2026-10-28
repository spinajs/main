import { Class, Constructor, token } from '@spinajs/di';
import type { ModelBase } from './model.js';
import type { Relation } from './relation-objects.js';
import type { OrmMigration, ValueConverter } from './interfaces.js';

type RelationType = Constructor<Relation<ModelBase<unknown>, ModelBase<unknown>, typeof ModelBase<ModelBase<unknown>>>>;

/** Model classes registered by `@Model`. */
export const MODELS = token<ModelBase>('__models__');

/** Migration classes registered by `@Migration`. */
export const MIGRATIONS = token<OrmMigration>('__migrations__');

/** Resolve with `[ModelClass]` to get the model instance factory result. */
export const ORM_MODEL_FACTORY = token<ModelBase>('__orm_model_factory__');

/** Value converters by the column data type they convert. */
export const ORM_DB_VALUE_CONVERTERS = token<Map<string, Class<ValueConverter>>>('__orm_db_value_converters__');

/** Resolve with `[type]` to get the class used for a hasMany relation. */
export const ORM_RELATION_HAS_MANY_FACTORY = token<RelationType>('__orm_relation_has_many_factory__');
export const ORM_RELATION_HAS_MANY_TO_MANY_FACTORY = token<RelationType>('__orm_relation_has_many_to_many_factory__');
