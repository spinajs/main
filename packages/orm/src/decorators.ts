/* eslint-disable prettier/prettier */
import { JsonValueConverter, UniversalValueConverter, UuidConverter } from './converters.js';
import { Constructor, DI, IContainer, getInheritedDescriptor } from '@spinajs/di';
import { IModelDescriptor, IMigrationDescriptor, IMigrationOptions, RelationType, IRelationDescriptor, IDiscriminationEntry, BooleanValueConverter, DatetimeValueConverter, SetValueConverter, ISelectQueryBuilder, IColumnDescriptor, IPrimaryKeyOptions, OrphanPolicy } from './interfaces.js';
import 'reflect-metadata';
import { ModelBase } from './model.js';
import { InvalidOperation, InvalidArgument } from '@spinajs/exceptions';
import { ManyQueryRelationList, Relation } from './relation-objects.js';
import { Orm } from './orm.js';
import { MODEL_DESCTRIPTION_SYMBOL, MIGRATION_DESCRIPTION_SYMBOL } from './symbols.js';
import { extractModelDescriptor, createDefaultModelDescriptor } from './descriptor.js';
import { captureSourceFile } from './source-file.js';

export { MODEL_DESCTRIPTION_SYMBOL, MIGRATION_DESCRIPTION_SYMBOL } from './symbols.js';

export function _prepareColumnDesc(initialize: Partial<IColumnDescriptor>): IColumnDescriptor {
  return Object.assign({
    Type: '',
    MaxLength: 0,
    Comment: '',
    DefaultValue: null,
    NativeType: '',
    Unsigned: false,
    Nullable: false,
    PrimaryKey: false,
    AutoIncrement: false,
    Name: '',
    Converter: null,
    Schema: null,
    Unique: false,
    Uuid: false,
    Ignore: false,
    Aggregate: false,
    IsForeignKey: false,
    ForeignKeyDescription: null,
    Virtual: false
  }, initialize);
}

/**
 * Resolves the single column a relation joins on. A relation's PrimaryKey / ForeignKey each
 * name exactly one column ( the JOIN compiler emits a one-column ON predicate ), so a composite
 * primary key has no defensible default and must be named explicitly by the developer.
 */
export function _relationDefaultKey(descriptor: IModelDescriptor, relationName: string, optionName: string): string {
  const keys = descriptor.PrimaryKey ?? [];

  if (keys.length > 1) {
    throw new InvalidOperation(`relation ${relationName} cannot default its join column: model ${descriptor.Name} has a composite primary key (${keys.join(', ')}). Pass ${optionName} explicitly.`);
  }

  return keys[0];
}

function _getMetadataFrom(target: any) {
  // Sampled BEFORE getInheritedDescriptor, which stores own metadata as a side
  // effect - so this is only true on the very first decorator to touch `target`.
  const isFirstDecorator = !Reflect.getOwnMetadata(MODEL_DESCTRIPTION_SYMBOL, target);

  // Own metadata per class - see @spinajs/di getInheritedDescriptor. Replaces
  // the previous name-keyed container, which collapsed two classes sharing a
  // name into a single slot.
  const descriptor = getInheritedDescriptor<IModelDescriptor>(target, MODEL_DESCTRIPTION_SYMBOL, createDefaultModelDescriptor);

  // Name is this class's own, never inherited from the base
  descriptor.Name = target.name;

  if (isFirstDecorator) {
    detachInheritedModelMembers(descriptor);
  }

  return descriptor;
}

/**
 * The collapse merger ( @spinajs/di ) rebuilds Columns / Relations and the
 * option objects one level deep, but their ELEMENTS stay shared by reference
 * with the parent model. Decorators such as @Ignore / @Uuid ( `columnDesc.Ignore = true` ),
 * @Recursive ( `relation.Recursive = true` ) and @CreatedAt / @SoftDelete /
 * @DiscriminationMap ( `model.<option>.<field> = ...` ) mutate a found element
 * in place - on an INHERITED member that would write straight through to the
 * base model's descriptor. Give this class its own shallow copies of exactly
 * the structures that get mutated in place. ( same hazard @spinajs/http closes
 * with detachInheritedRoutes; Converters / JunctionModelProperties are only
 * ever set/pushed with fresh values, so they need no copy. )
 */
function detachInheritedModelMembers(descriptor: IModelDescriptor) {
  descriptor.Columns = descriptor.Columns.map((c) => ({ ...c }));
  // NOT `{ ...relation }`. A relation descriptor may carry a lazily-defined `PrimaryKey`
  // accessor ( @BelongsTo / @HasManyToMany with a string target model, which cannot be
  // resolved until the Orm is up ). Spreading INVOKES that getter — here, at decoration
  // time, when DI.get(Orm) is still undefined — and then freezes whatever it returned into
  // a plain value, defeating the laziness even when it does not throw. Copying property
  // descriptors detaches the mutable data properties ( Recursive, etc. ) while leaving
  // accessors as accessors.
  descriptor.Relations = new Map([...descriptor.Relations].map(([name, relation]) => [name, Object.create(Object.getPrototypeOf(relation) as object, Object.getOwnPropertyDescriptors(relation)) as IRelationDescriptor]));
  descriptor.Timestamps = { ...descriptor.Timestamps };
  descriptor.SoftDelete = { ...descriptor.SoftDelete };
  descriptor.Archived = { ...descriptor.Archived };
  descriptor.DiscriminationMap = { ...descriptor.DiscriminationMap };
}

export function extractDecoratorPropertyDescriptor(callback: (model: IModelDescriptor, target: any, propertyKey: string, indexOrDescriptor: number | PropertyDescriptor) => void): any {
  return (target: any, propertyKey: string | symbol, indexOrDescriptor: number | PropertyDescriptor) => {
    const metadata = _getMetadataFrom(target.constructor);
    if (callback) {
      callback(metadata, target.constructor, propertyKey as string, indexOrDescriptor);
    }
  };
}

/**
 * Helper func to create model metadata
 */
export function extractDecoratorDescriptor(callback: (model: IModelDescriptor, target: any, propertyKey: symbol | string, indexOrDescriptor: number | PropertyDescriptor) => void): any {
  return (target: any, propertyKey: string | symbol, indexOrDescriptor: number | PropertyDescriptor) => {
    const metadata = _getMetadataFrom(target);
    if (callback) {
      callback(metadata, target, propertyKey, indexOrDescriptor);
    }
  };
}

/**
 * The frames that sit between `@Migration()` and the migration's own file: this module, and the
 * transpiler / metadata helpers that call into it.
 */
const MIGRATION_SOURCE_SKIP_MARKERS = ['decorators.ts', 'decorators.js', 'source-file.ts', 'source-file.js', 'tslib', 'reflect-metadata', '__decorate', '__esDecorate', 'node:internal'];

/**
 * Sets migration option
 *
 * @param connection - connection name, must exists in configuration file
 * @param options - optional migration options, eg. the environment it belongs to
 */
export function Migration(connection: string, options?: IMigrationOptions) {
  // captured OUTSIDE the returned function on purpose: this is the frame the user's file called,
  // so the stack still points at their migration source rather than at the decorator application
  const sourceFile = captureSourceFile(MIGRATION_SOURCE_SKIP_MARKERS);

  return (target: any) => {
    // Static properties are inherited through the constructor's prototype chain. A plain
    // truthiness check would find the parent's descriptor and mutate it in place, silently
    // rewriting the parent migration's connection, environment, and source file. Only create a
    // new descriptor if the target does NOT own this symbol already.
    const hasOwnDescriptor = Object.prototype.hasOwnProperty.call(target, MIGRATION_DESCRIPTION_SYMBOL);
    let metadata = target[MIGRATION_DESCRIPTION_SYMBOL] as IMigrationDescriptor;

    if (!hasOwnDescriptor) {
      metadata = {
        Connection: '',
      };
      target[MIGRATION_DESCRIPTION_SYMBOL] = metadata;
    }

    metadata.Connection = connection;
    metadata.Env = options?.Env;
    metadata.SourceFile = sourceFile;

    DI.register(target).as('__migrations__');
  };
}

/**
 * Connection model decorator, assigns connection to model
 *
 * @param name - connection name, must be avaible in db config
 */
export function Connection(name: string) {
  return extractDecoratorDescriptor((model: IModelDescriptor) => {
    model.Connection = name;
  });
}

/**
 * TableName model decorator, assigns table from database to model
 *
 * @param name - table name in database that is referred by this model
 */
export function Model(tableName: string) {
  return extractDecoratorDescriptor((model: IModelDescriptor, target: any) => {
    DI.register(target).as('__models__');
    model.TableName = tableName;
    model.Name = target.name;
  });
}

/**
 * Set create timestamps feature to model. Proper columns must be avaible in database table.
 * It allow to track creation times & changes to model
 */
export function CreatedAt() {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, target: any, propertyKey: string) => {
    const type = Reflect.getMetadata('design:type', target.prototype, propertyKey);
    if (type.name !== 'DateTime') {
      throw Error(`Proprety ${propertyKey} marked as CreatedAt must be DateTime type, but is ${type.name}. Type: ${target.name}`);
    }

    model.Timestamps.CreatedAt = propertyKey;

    // add converter for this field
    model.Converters.set(propertyKey, {
      Class: DatetimeValueConverter,
    });
  });
}

/**
 * Set update timestamps feature to model. Proper columns must be avaible in database table.
 * It allow to track creation times & changes to model
 */
export function UpdatedAt() {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, target: any, propertyKey: string) => {
    const type = Reflect.getMetadata('design:type', target.prototype, propertyKey);
    if (type.name !== 'DateTime') {
      throw Error(`Proprety ${propertyKey} marked as UpdatedAt must be DateTime type, but is ${type.name}. Type: ${target.name}`);
    }

    model.Timestamps.UpdatedAt = propertyKey;

    // add converter for this field
    model.Converters.set(propertyKey, {
      Class: DatetimeValueConverter,
    });
  });
}

/**
 * Sets soft delete feature to model. Soft delete dont delete model, but sets deletion date and hides from
 * select result by default.
 */
export function SoftDelete() {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, target: any, propertyKey: string) => {
    const type = Reflect.getMetadata('design:type', target.prototype, propertyKey);
    if (type.name !== 'DateTime') {
      throw Error(`Proprety ${propertyKey} marked as DeletedAt must be DateTime type, but is ${type.name}. Type: ${target.name}`);
    }

    model.SoftDelete.DeletedAt = propertyKey;

    // add converter for this field
    model.Converters.set(propertyKey, {
      Class: DatetimeValueConverter,
    });
  });
}

/**
 * Enable archive mode for model. If enabled all changes creates new instance in DB and old have set archived field
 * and gets attached to new model. It enabled to track changes to model in DB and also preserve data in relations.
 *
 */
export function Archived() {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, target: any, propertyKey: string) => {
    const type = Reflect.getMetadata('design:type', target.prototype, propertyKey);
    if (type.name !== 'DateTime') {
      throw Error(`Proprety ${propertyKey} marked as ArchivedAt must be DateTime type, but is ${type.name}. Type: ${target.name}`);
    }

    model.Archived.ArchivedAt = propertyKey;

    // add converter for this field
    model.Converters.set(propertyKey, {
      Class: DatetimeValueConverter,
    });
  });
}

/**
 * Marks a field as part of the primary key. Applying it to more than one property of the same
 * model declares a composite key; the columns are ordered by decorator evaluation order.
 *
 * NOTE: @Primary() is additive across an inheritance chain. A subclass cannot *replace* a base
 * class's primary key, only extend it. Declare @Primary() on every key column of the concrete model.
 *
 * @param options.generated - key generation strategy, defaults to `auto` ( database identity ).
 */
export function Primary(options?: IPrimaryKeyOptions) {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, _target: any, propertyKey: string) => {
    if (!model.PrimaryKey.includes(propertyKey)) {
      model.PrimaryKey.push(propertyKey);
    }

    model.PrimaryKeyGeneration.set(propertyKey, options?.generated ?? 'auto');
  });
}

/**
 * Marks a property as one the model NEVER hands out: `dehydrate()` and `dehydrateWithRelations()`
 * omit it unconditionally, and it is dropped from the model's response JSON schema
 * ( `descriptor.ResponseSchema` ), so generated API documentation never advertises a field the
 * ORM guarantees is absent. rbac's `User` hides `Password` and `Id` this way.
 *
 * Applies to RELATION properties as well as columns - rbac's `UserMetadata` hides its `User`
 * relation, which never appears in `Columns` at all.
 *
 * The write contract is deliberately untouched: `descriptor.Schema` still carries the property,
 * because hiding a value on the way out says nothing about whether a client may send it in. Use
 * `@Ignore()` instead for a property that is not part of the table.
 *
 * Additive down an inheritance chain, like @Primary(): a subclass starts from everything its
 * ancestors hide and may add to it, without writing back into their descriptors. Declaring the
 * same property again in a subclass is harmless - it is recorded once.
 *
 * Written at class-definition time, which is the point of the decorator: every reader
 * ( response schema, `@spinajs/http-swagger` ) gets the list off the class itself, with no Orm
 * resolved and no database reachable.
 */
export function Hidden() {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, _target: any, propertyKey: string) => {
    if (!model.Hidden.includes(propertyKey)) {
      model.Hidden.push(propertyKey);
    }
  });
}

/**
 * Marks columns as UUID. Column will be generated ad creation
 */
export function Ignore() {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, _target: any, propertyKey: string) => {
    const columnDesc = model.Columns.find((c) => c.Name === propertyKey);
    if (!columnDesc) {
      // we dont want to fill all props, they will be loaded from db and mergeg with this
      model.Columns.push(_prepareColumnDesc({ Name: propertyKey, Ignore: true }));
    } else {
      columnDesc.Ignore = true;
    }
  });
}

/**
 * Marks columns as UUID. Column will be generated ad creation
 */
export function Uuid() {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, _target: any, propertyKey: string) => {
    const columnDesc = model.Columns.find((c) => c.Name === propertyKey);
    if (!columnDesc) {
      // we dont want to fill all props, they will be loaded from db and mergeg with this
      model.Columns.push(_prepareColumnDesc({ Name: propertyKey, Uuid: true }));
    } else {
      columnDesc.Uuid = true;
    }

    model.Converters.set(propertyKey, {
      Class: UuidConverter,
    });
  });
}

export function JunctionTable() {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, target: any, propertyKey: string) => {
    model.JunctionModelProperties.push({
      Name: propertyKey,
      Model: Reflect.getMetadata('design:type', target.prototype, propertyKey),
    });
  });
}

/**
 *
 * Marks model to have discrimination map.
 *
 * @param fieldName - db field name to look for
 * @param discriminationMap - field - model mapping
 */
export function DiscriminationMap(fieldName: string, discriminationMap: IDiscriminationEntry[]) {
  return extractDecoratorDescriptor((model: IModelDescriptor, _target: any, _propertyKey: string) => {
    model.DiscriminationMap.Field = fieldName;
    model.DiscriminationMap.Models = new Map<string, Constructor<ModelBase>>();

    discriminationMap.forEach((d) => {
      model.DiscriminationMap.Models!.set(d.Key, d.Value);
    });
  });
}

/**
 * Marks relation as recursive. When relation is populated it loads all to the top
 *
 */
export function Recursive() {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, _target: any, propertyKey: string) => {
    if (!model.Relations.has(propertyKey)) {
      throw new InvalidOperation(`cannot set recursive on not existing relation ( relation ${propertyKey} on model ${model.Name} )`);
    }
    const relation = model.Relations.get(propertyKey)!;
    relation.Recursive = true;
  });
}

export interface IForwardReference<T = any> {
  forwardRef: T;
}

export const forwardRef = (fn: () => any): IForwardReference => ({
  forwardRef: fn,
});

/**
 * Creates one to one relation with target model.
 *
 * @param foreignKey - foreign key name in db, defaults to lowercase property name with _id suffix eg. owner_id
 * @param primaryKey - primary key in related model, defaults to primary key taken from db
 */
export function BelongsTo(targetModel: Constructor<ModelBase> | string, foreignKey?: string, primaryKey?: string) {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, target: any, propertyKey: string) => {
    const descriptor: IRelationDescriptor = {
      Name: propertyKey,
      Type: RelationType.One,
      SourceModel: target,
      TargetModelType: targetModel,
      TargetModel: undefined as any,
      ForeignKey: foreignKey ?? `${propertyKey.toLowerCase()}_id`,
      // default PK must come from the TARGET model, not the source ( fixed below )
      PrimaryKey: primaryKey ?? _relationDefaultKey(model, propertyKey, 'primaryKey'),
      Recursive: false,
    };

    if (!primaryKey) {
      if (typeof targetModel === 'string') {
        // target resolved by name at runtime - read its PK lazily ( same pattern as HasManyToMany )
        const getModel = function () {
          return extractModelDescriptor(DI.get(Orm)!.Models.find((x) => x.name === targetModel)!.type);
        };

        Object.defineProperty(descriptor, 'PrimaryKey', {
          get: function () {
            const target = getModel();
            return target ? _relationDefaultKey(target, propertyKey, 'primaryKey') : _relationDefaultKey(model, propertyKey, 'primaryKey');
          },
        });
      } else {
        const targetModelDesc = extractModelDescriptor(targetModel);
        descriptor.PrimaryKey = targetModelDesc ? _relationDefaultKey(targetModelDesc, propertyKey, 'primaryKey') : _relationDefaultKey(model, propertyKey, 'primaryKey');
      }
    }

    model.Relations.set(propertyKey, descriptor);
  });
}

export function Virtual(virtualRelation?: Constructor<Relation<ModelBase<unknown>, ModelBase<unknown>, typeof ModelBase<ModelBase<unknown>>>>) {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, target: any, propertyKey: string) => {
    let type: Constructor<Relation<ModelBase<unknown>, ModelBase<unknown>, typeof ModelBase<ModelBase<unknown>>>> = Reflect.getMetadata('design:type', target.prototype, propertyKey);

    model.Relations.set(propertyKey, {
      Name: propertyKey,
      Type: RelationType.Virtual,
      Callback: undefined,
      Mapper: undefined,
      SourceModel: undefined as any,
      TargetModelType: undefined as any,
      TargetModel: undefined as any,
      ForeignKey: '',
      PrimaryKey: '',
      Recursive: false,
      RelationClass: virtualRelation ?? type,

    });
  });
}


/**
 *
 * Custom relation for executing custom queries to populate data. Use it when relation data dont come from another table
 * but rather from combinations of many tables
 *
 * @param callback
 * @returns
 */
export function Query<T extends ModelBase<unknown>, D extends ModelBase<unknown>>(callback: (data: T[]) => ISelectQueryBuilder, mapper: (owner: T, data: D[]) => D | D[]) {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, _: any, propertyKey: string) => {
    model.Relations.set(propertyKey, {
      Name: propertyKey,
      Type: RelationType.Query,
      Callback: callback as any,
      Mapper: mapper as any,
      SourceModel: undefined as any,
      TargetModelType: undefined as any,
      TargetModel: undefined as any,
      ForeignKey: '',
      PrimaryKey: '',
      Recursive: false,
      RelationClass: ManyQueryRelationList

    });
  });
}

/**
 * Creates one to one relation with target model.
 *
 * @param foreignKey - foreign key name in db, defaults to lowercase property name with _id suffix eg. owner_id
 * @param primaryKey - primary key in related model, defaults to primary key taken from db
 */
export function ForwardBelongsTo(forwardRef: IForwardReference, foreignKey?: string, primaryKey?: string) {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, target: any, propertyKey: string) => {
    const descriptor: IRelationDescriptor = {
      Name: propertyKey,
      Type: RelationType.One,
      SourceModel: target,
      TargetModelType: forwardRef.forwardRef,
      TargetModel: undefined as any,
      ForeignKey: foreignKey ?? `${propertyKey.toLowerCase()}_id`,
      // default PK must come from the TARGET model, not the source ( fixed below )
      PrimaryKey: primaryKey ?? _relationDefaultKey(model, propertyKey, 'primaryKey'),
      Recursive: false,
    };

    if (!primaryKey) {
      // The target class does not exist yet - that is the whole reason a forward ref is used -
      // so its descriptor cannot be read here. Read it on first access instead, the same lazy
      // pattern `@BelongsTo` uses for a target named by string. The join column has to be the
      // target's, because that is the column `toSql()`, `diff()` and the unit of work all read
      // off the target model.
      Object.defineProperty(descriptor, 'PrimaryKey', {
        get: function () {
          const targetModelDesc = extractModelDescriptor(forwardRef.forwardRef);
          return targetModelDesc ? _relationDefaultKey(targetModelDesc, propertyKey, 'primaryKey') : _relationDefaultKey(model, propertyKey, 'primaryKey');
        },
      });
    }

    model.Relations.set(propertyKey, descriptor);
  });
}

export interface IRelationDecoratorOptions {
  /**
   * Relation factory, sometimes we dont want to create standard relation object.
   * When creating object and specific relation is created via this factory
   */
  factory?: (owner: ModelBase, relation: IRelationDescriptor, container: IContainer) => Relation<ModelBase<unknown>, ModelBase<unknown>, typeof ModelBase<ModelBase<unknown>>>;

  /**
   *  sometimes we dont want to create standard relation object, so we create type
   *  that is passed in this property
   */
  type?: Constructor<Relation<ModelBase<unknown>, ModelBase<unknown>, typeof ModelBase<ModelBase<unknown>>>>;
}

export interface IHasManyToManyDecoratorOptions extends IRelationDecoratorOptions {
  /**
   *  target model primary key name
   */
  targetModelPKey?: string;

  /**
   * source model primary key name
   */
  sourceModelPKey?: string;

  /**
   * junction table target primary key name ( foreign key for target model )
   */
  junctionModelTargetPk?: string;

  /**
   * junction table source primary key name ( foreign key for source model )
   */
  junctionModelSourcePk?: string;

  /**
   * Join mode on relation
   * Sometimes right side of junction relation not exists and we want to filter it out
   */
  joinMode?: 'LeftJoin' | 'RightJoin';

  /**
   * What `save()` does with a member removed from this relation. For many-to-many this
   * governs the *target* row: the junction row is always deleted. Defaults to `nullify`,
   * which for a junction relation means "unlink only, leave the target row alone".
   */
  orphan?: OrphanPolicy;
}

export interface IHasManyDecoratorOptions extends IRelationDecoratorOptions {
  foreignKey?: string;
  primaryKey?: string;

  /**
   * What `save()` does with a child removed from this relation. Defaults to `nullify`,
   * escalating to `delete` when the foreign key is reflected as NOT NULL.
   */
  orphan?: OrphanPolicy;
}

/**
 * Creates one to many relation with target model.
 *
 * @param targetModel - due to limitations of metadata reflection api in typescript target model mus be set explicitly
 * @param foreignKey - foreign key name in db, defaults to lowercase property name with _id suffix eg. owner_id
 * @param primaryKey - primary key in source table defaults to lowercase property name with _id suffix eg. owner_id
 *
 */
export function HasMany(targetModel: Constructor<ModelBase> | string, options?: IHasManyDecoratorOptions) {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, target: any, propertyKey: string) => {
    let type: Constructor<Relation<ModelBase<unknown>, ModelBase<unknown>, typeof ModelBase<ModelBase<unknown>>>> = Reflect.getMetadata('design:type', target.prototype, propertyKey);

    model.Relations.set(propertyKey, {
      Name: propertyKey,
      Type: RelationType.Many,
      SourceModel: target,
      TargetModelType: targetModel,
      TargetModel: undefined as any,
      ForeignKey: options ? options.foreignKey ?? `${model.Name.toLowerCase()}_id` : `${model.Name.toLowerCase()}_id`,
      PrimaryKey: options?.primaryKey ?? _relationDefaultKey(model, propertyKey, 'options.primaryKey'),
      Recursive: false,
      Orphan: options?.orphan,
      Factory: options?.factory ? options.factory : undefined,
      RelationClass: options?.type ? options.type : () => DI.resolve('__orm_relation_has_many_factory__', [type]),
    });
  });
}

export function Historical(targetModel: Constructor<ModelBase>) {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, target: any, propertyKey: string) => {
    model.Relations.set(propertyKey, {
      Name: propertyKey,
      Type: RelationType.Many,
      SourceModel: target,
      TargetModelType: targetModel,
      TargetModel: undefined as any,
      ForeignKey: _relationDefaultKey(model, propertyKey, 'primaryKey'),
      PrimaryKey: _relationDefaultKey(model, propertyKey, 'primaryKey'),
      Recursive: false,
    });
  });
}

/**
 * Creates many to many relation with separate join table
 *
 * @param junctionModel - model for junction table
 * @param targetModel - model for related data
 */
export function HasManyToMany(junctionModel: Constructor<ModelBase>, targetModel: Constructor<ModelBase> | string, options?: IHasManyToManyDecoratorOptions) {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, target: any, propertyKey: string) => {
    const descriptor: IRelationDescriptor = {
      Name: propertyKey,
      Recursive: false,
      Orphan: options?.orphan,
      Type: RelationType.ManyToMany,
      SourceModel: target,
      TargetModelType: targetModel,
      TargetModel: undefined as any,
      ForeignKey: '',
      // ForeignKey: options?.targetModelPKey ?? targetModelDescriptor.PrimaryKey,
      PrimaryKey: options?.sourceModelPKey ?? _relationDefaultKey(model, propertyKey, 'options.sourceModelPKey'),
      JunctionModel: junctionModel,
      // JunctionModelTargetModelFKey_Name: options?.junctionModelTargetPk ?? `${targetModelDescriptor.Name.toLowerCase()}_id`,
      JunctionModelTargetModelFKey_Name: '',
      JunctionModelSourceModelFKey_Name: options?.junctionModelSourcePk ?? `${model.Name.toLowerCase()}_id`,
      RelationClass: options?.type ? options.type : () => DI.resolve('__orm_relation_has_many_to_many_factory__', [type]),
      Factory: options ? options.factory : undefined,
      JoinMode: options ? options.joinMode : undefined,
    };

    // HACK:
    // we should use ForwardRefFunction as targetModel type
    // and lazy resolve foreginKey and JunctionModelTargetModelFKey_Name at runtime
    // using of getters is temporary ??? too much code change for now
    if (typeof targetModel === 'string') {
      const getModel = function () {
        return extractModelDescriptor(DI.get(Orm)!.Models.find((x) => x.name === targetModel)!.type);
      };

      Object.defineProperty(descriptor, 'ForeignKey', {
        get: function () {
          return options?.targetModelPKey ?? getModel()!.PrimaryKey;
        },
      });

      Object.defineProperty(descriptor, 'JunctionModelTargetModelFKey_Name', {
        get: function () {
          return options?.junctionModelTargetPk ?? `${getModel()!.Name.toLowerCase()}_id`;
        },
      });
    } else {
      const targetModelDescriptor = extractModelDescriptor(targetModel);
      descriptor.ForeignKey = options?.targetModelPKey ?? _relationDefaultKey(targetModelDescriptor!, propertyKey, 'options.targetModelPKey');
      descriptor.JunctionModelTargetModelFKey_Name = options?.junctionModelTargetPk ?? `${targetModelDescriptor!.Name.toLowerCase()}_id`;
    }

    let type: Constructor<Relation<ModelBase<unknown>, ModelBase<unknown>, typeof ModelBase<ModelBase<unknown>>>> = Reflect.getMetadata('design:type', target.prototype, propertyKey);

    model.Relations.set(propertyKey, descriptor);
  });
}

/**
 * Mark field as datetime type. It will ensure that conversion to & from DB is valid, eg. sqlite DB
 * saves datetime as TEXT and ISO8601 strings
 */
export function DateTime() {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, target: any, propertyKey: string) => {
    const type = Reflect.getMetadata('design:type', target.prototype, propertyKey);
    if (type.name !== 'DateTime') {
      throw Error(`Proprety  ${propertyKey} must be DateTime type, but is ${type.name}`);
    }

    if (model.Converters.has(propertyKey)) {
      throw new InvalidArgument(`property ${propertyKey} already have data converter attached`);
    }

    model.Converters.set(propertyKey, {
      Class: DatetimeValueConverter,
    });
  });
}

/**
 * Mark field as boolean type.
 *
 * The ORM attaches a boolean converter on its own only when the driver NAMES the column's native
 * type after a boolean: `Orm.reloadTableInfo` looks `DATA_TYPE` up in `__orm_db_value_converters__`,
 * which is keyed by `Boolean` / `bool`. MySQL reports `tinyint(1)` - its own spelling of BOOLEAN -
 * as `tinyint`, so the lookup misses and the column ends up with NO converter at all. Nothing then
 * translates it in either direction, and the two directions disagree: a SELECT leaves the driver's
 * `1` in a property declared `boolean`, while a create/update leaves the caller's `true` there, so
 * an endpoint answering with the model it just wrote returns a different JSON type than the one
 * answering a read.
 *
 * This decorator states the column's type explicitly instead. `BooleanValueConverter` is a lookup
 * key rather than an implementation - each driver binds its own (orm-sql:
 * `register(SqlBooleanValueConverter).as(BooleanValueConverter)`) - so the value is rendered the way
 * that database wants it while the property stays a real boolean.
 *
 * It also fixes the PUBLISHED type: `columnToSchema` maps `tinyint` to `{ type: 'integer' }` on the
 * SQL type alone, and overrides that to `{ type: 'boolean' }` when the column's declared converter
 * is a `BooleanValueConverter`.
 */
export function Bool() {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, target: any, propertyKey: string) => {
    const type = Reflect.getMetadata('design:type', target.prototype, propertyKey);
    if (type?.name !== 'Boolean') {
      throw new InvalidArgument(`property ${propertyKey} must be boolean type, but is ${type?.name}`);
    }

    if (model.Converters.has(propertyKey)) {
      throw new InvalidArgument(`property ${propertyKey} already have data converter attached`);
    }

    model.Converters.set(propertyKey, {
      Class: BooleanValueConverter,
    });
  });
}

/**
 * Converts data in db to json object. Column type in DB should be STRING.
 * DO not use this decorator for use of native DB JSON implementation.
 * ORM will detect automatically if field is native JSON DB type.
 */
export function Json() {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, _: any, propertyKey: string) => {
    // add converter for this field
    model.Converters.set(propertyKey, {
      Class: JsonValueConverter,
    });
  });
}

/**
 *
 * Universal converter that guess whitch type to return. Usefull in tables that holds as text different values
 * eg. metadata table
 *
 * @param typeColumn - type column that defines final type of value
 */
export function UniversalConverter(typeColumn?: string) {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, _: any, propertyKey: string) => {
    // add converter for this field
    model.Converters.set(propertyKey, {
      Class: UniversalValueConverter,
      Options: {
        TypeColumn: typeColumn ?? 'Type',
      },
    });
  });
}

/**
 * Mark field as SET type. It will ensure that conversion to & from DB is valid, eg. to emulate field type SET in sqlite
 */
export function Set() {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, target: any, propertyKey: string) => {
    const type = Reflect.getMetadata('design:type', target.prototype, propertyKey);
    if (type.name !== 'Array') {
      throw Error(`Proprety  ${propertyKey} must be an array type`);
    }

    if (model.Converters.has(propertyKey)) {
      throw new InvalidArgument(`property ${propertyKey} already have data converter attached`);
    }

    model.Converters.set(propertyKey, {
      Class: SetValueConverter,
    });
  });
}
