/* eslint-disable prettier/prettier */
import { JsonValueConverter, UniversalValueConverter, UuidConverter } from './converters.js';
import { Constructor, DI, IContainer } from '@spinajs/di';
import { IModelDescriptor, IMigrationDescriptor, RelationType, IRelationDescriptor, IDiscriminationEntry, DatetimeValueConverter, SetValueConverter, ISelectQueryBuilder, IColumnDescriptor } from './interfaces.js';
import 'reflect-metadata';
import { ModelBase, extractModelDescriptor } from './model.js';
import { InvalidOperation, InvalidArgument } from '@spinajs/exceptions';
import { Relation } from './relation-objects.js';
import { Orm } from './orm.js';

export const MODEL_DESCTRIPTION_SYMBOL = Symbol.for('MODEL_DESCRIPTOR');
export const MIGRATION_DESCRIPTION_SYMBOL = Symbol.for('MIGRATION_DESCRIPTOR');

export function _prepareColumnDesc(initialize : Partial<IColumnDescriptor>): IColumnDescriptor {
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

function _getMetadataFrom(target: any) {
  let metadata = Reflect.getMetadata(MODEL_DESCTRIPTION_SYMBOL, target) ?? {};

  /**
   * NOTE:
   * We hold metadata information as poperty of object stored by normal metadata.
   * This way we can avoid overwritting metadata properties by inherited classes.
   *
   * Eg. given class hierarchy:
   *
   *  @Decorator({ a: 1})
   *  class A {}
   *
   *  @Decorator({ a: 2})
   *  class B extends A {}
   *
   *  @Decorator({ a: 3})
   *  class C extends A {}
   *
   *  Normally metadata is created for class A due import order. Reflect.metadata() searches in prototype chain, so
   *  when class B gets decorator executed it will find already defined from class A. Then class C decorator will overwrite
   *  decorator for class A ( B decorator is lost ).
   *
   *  This is becouse decorator is saerched in protype chain of object.
   *
   *  When we need metadata value, we collapse this object with proper inheritance object
   */

  if (!metadata.hasOwnProperty(target.name)) {
    metadata[target.name] = {
      Driver: null,
      Converters: new Map(),
      Columns: [],
      Connection: null,
      PrimaryKey: '',
      SoftDelete: {
        DeletedAt: '',
      },
      Archived: {
        ArchivedAt: '',
      },
      TableName: '',
      Timestamps: {
        CreatedAt: '',
        UpdatedAt: '',
      },
      Relations: new Map(),
      Name: target.name,
      JunctionModelProperties: [],
      DiscriminationMap: {
        Field: '',
        Models: null,
      },
      Schema: {},
    };
  }
  Reflect.defineMetadata(MODEL_DESCTRIPTION_SYMBOL, metadata, target);

  return metadata[target.name];
}

export function extractDecoratorPropertyDescriptor(callback: (model: IModelDescriptor, target: any, propertyKey: symbol | string, indexOrDescriptor: number | PropertyDescriptor) => void): any {
  return (target: any, propertyKey: string | symbol, indexOrDescriptor: number | PropertyDescriptor) => {
    const metadata = _getMetadataFrom(target.constructor);
    if (callback) {
      callback(metadata, target.constructor, propertyKey, indexOrDescriptor);
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
 * Sets migration option
 *
 * @param connection - connection name, must exists in configuration file
 */
export function Migration(connection: string) {
  return (target: any) => {
    let metadata = target[MIGRATION_DESCRIPTION_SYMBOL] as IMigrationDescriptor;

    if (!metadata) {
      metadata = {
        Connection: '',
      };
      target[MIGRATION_DESCRIPTION_SYMBOL] = metadata;
    }

    metadata.Connection = connection;

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
 * Makrs field as primary key
 */
export function Primary() {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, _target: any, propertyKey: string) => {
    model.PrimaryKey = propertyKey;
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
      model.DiscriminationMap.Models.set(d.Key, d.Value);
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
    const relation = model.Relations.get(propertyKey);
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
    const targetModelDesc = extractModelDescriptor(target);

    model.Relations.set(propertyKey, {
      Name: propertyKey,
      Type: RelationType.One,
      SourceModel: target,
      TargetModelType: targetModel,
      TargetModel: null,
      ForeignKey: foreignKey ?? `${propertyKey.toLowerCase()}_id`,
      PrimaryKey: primaryKey ?? targetModelDesc.PrimaryKey,
      Recursive: false,
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
export function Query<T extends ModelBase<unknown>, D extends ModelBase<unknown>>(callback: (data: T[]) => Promise<ISelectQueryBuilder>, mapper: (owner: T, data: D[]) => D | D[]) {
  return extractDecoratorPropertyDescriptor((model: IModelDescriptor, _: any, propertyKey: string) => {
    model.Relations.set(propertyKey, {
      Name: propertyKey,
      Type: RelationType.Query,
      Callback: callback,
      Mapper: mapper,
      SourceModel: null,
      TargetModelType: null,
      TargetModel: null,
      ForeignKey: '',
      PrimaryKey: '',
      Recursive: false,
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
    model.Relations.set(propertyKey, {
      Name: propertyKey,
      Type: RelationType.One,
      SourceModel: target,
      TargetModelType: forwardRef.forwardRef,
      TargetModel: null,
      ForeignKey: foreignKey ?? `${propertyKey.toLowerCase()}_id`,
      PrimaryKey: primaryKey ?? model.PrimaryKey,
      Recursive: false,
    });
  });
}

export interface IRelationDecoratorOptions {
  /**
   * Relation factory, sometimes we dont want to create standard relation object.
   * When creating object and specific relation is created via this factory
   */
  factory?: (owner: ModelBase, relation: IRelationDescriptor, container: IContainer) => Relation<ModelBase<unknown>, ModelBase<unknown>>;

  /**
   *  sometimes we dont want to create standard relation object, so we create type
   *  that is passed in this property
   */
  type?: Constructor<Relation<ModelBase<unknown>, ModelBase<unknown>>>;
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
}

export interface IHasManyDecoratorOptions extends IRelationDecoratorOptions {
  foreignKey?: string;
  primaryKey?: string;
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
    let type: Constructor<Relation<ModelBase<unknown>, ModelBase<unknown>>> = Reflect.getMetadata('design:type', target.prototype, propertyKey);

    model.Relations.set(propertyKey, {
      Name: propertyKey,
      Type: RelationType.Many,
      SourceModel: target,
      TargetModelType: targetModel,
      TargetModel: null,
      ForeignKey: options ? options.foreignKey ?? `${model.Name.toLowerCase()}_id` : `${model.Name.toLowerCase()}_id`,
      PrimaryKey: options ? options.primaryKey ?? model.PrimaryKey : model.PrimaryKey,
      Recursive: false,
      Factory: options?.factory ? options.factory : null,
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
      TargetModel: null,
      ForeignKey: model.PrimaryKey,
      PrimaryKey: model.PrimaryKey,
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
      Type: RelationType.ManyToMany,
      SourceModel: target,
      TargetModelType: targetModel,
      TargetModel: null,
      ForeignKey: '',
      // ForeignKey: options?.targetModelPKey ?? targetModelDescriptor.PrimaryKey,
      PrimaryKey: options?.sourceModelPKey ?? model.PrimaryKey,
      JunctionModel: junctionModel,
      // JunctionModelTargetModelFKey_Name: options?.junctionModelTargetPk ?? `${targetModelDescriptor.Name.toLowerCase()}_id`,
      JunctionModelTargetModelFKey_Name: '',
      JunctionModelSourceModelFKey_Name: options?.junctionModelSourcePk ?? `${model.Name.toLowerCase()}_id`,
      RelationClass: options?.type ? options.type : () => DI.resolve('__orm_relation_has_many_to_many_factory__', [type]),
      Factory: options ? options.factory : null,
      JoinMode: options ? options.joinMode : null,
    };

    // HACK:
    // we should use ForwardRefFunction as targetModel type
    // and lazy resolve foreginKey and JunctionModelTargetModelFKey_Name at runtime
    // using of getters is temporary ??? too much code change for now
    if (typeof targetModel === 'string') {
      const getModel = function () {
        return extractModelDescriptor(DI.get(Orm).Models.find((x) => x.name === targetModel).type);
      };

      Object.defineProperty(descriptor, 'ForeignKey', {
        get: function () {
          return options?.targetModelPKey ?? getModel().PrimaryKey;
        },
      });

      Object.defineProperty(descriptor, 'JunctionModelTargetModelFKey_Name', {
        get: function () {
          return options?.junctionModelTargetPk ?? `${getModel().Name.toLowerCase()}_id`;
        },
      });
    } else {
      const targetModelDescriptor = extractModelDescriptor(targetModel);
      descriptor.ForeignKey = options?.targetModelPKey ?? targetModelDescriptor.PrimaryKey;
      descriptor.JunctionModelTargetModelFKey_Name = options?.junctionModelTargetPk ?? `${targetModelDescriptor.Name.toLowerCase()}_id`;
    }

    let type: Constructor<Relation<ModelBase<unknown>, ModelBase<unknown>>> = Reflect.getMetadata('design:type', target.prototype, propertyKey);

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
