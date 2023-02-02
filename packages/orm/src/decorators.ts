import { IValueConverterDescriptor, JsonValueConverter } from './interfaces.js';
/* eslint-disable prettier/prettier */
import { UuidConverter } from './converters.js';
import { Constructor, DI, IContainer } from '@spinajs/di';
import { IModelDescriptor, IMigrationDescriptor, RelationType, IRelationDescriptor, IDiscriminationEntry, DatetimeValueConverter, SetValueConverter } from './interfaces.js';
import 'reflect-metadata';
import { ModelBase, extractModelDescriptor } from './model.js';
import { InvalidOperation, InvalidArgument } from '@spinajs/exceptions';
import { Relation } from './relations.js';

export const MODEL_DESCTRIPTION_SYMBOL = Symbol.for('MODEL_DESCRIPTOR');
export const MIGRATION_DESCRIPTION_SYMBOL = Symbol.for('MIGRATION_DESCRIPTOR');

/**
 * Helper func to create model metadata
 */
export function extractDecoratorDescriptor(callback: (model: IModelDescriptor, target: any, propertyKey: symbol | string, indexOrDescriptor: number | PropertyDescriptor) => void, base = false): any {
  return (target: any, propertyKey: string | symbol, indexOrDescriptor: number | PropertyDescriptor) => {
    let metadata: IModelDescriptor = null;
    if (!base) {
      metadata = target.constructor[MODEL_DESCTRIPTION_SYMBOL];
    } else {
      metadata = target[MODEL_DESCTRIPTION_SYMBOL];
    }

    if (!metadata) {
      metadata = {
        Driver: null,
        Converters: new Map<string, IValueConverterDescriptor>(),
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
        Relations: new Map<string, IRelationDescriptor>(),
        Name: target.constructor.name,
        JunctionModelProperties: [],
        DiscriminationMap: {
          Field: '',
          Models: null,
        },
        Schema: {},
      };

      if (!base) {
        target.constructor[MODEL_DESCTRIPTION_SYMBOL] = metadata;
      } else {
        target[MODEL_DESCTRIPTION_SYMBOL] = metadata;
      }
    }

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
  }, true);
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
  }, true);
}

/**
 * Set create timestamps feature to model. Proper columns must be avaible in database table.
 * It allow to track creation times & changes to model
 */
export function CreatedAt() {
  return extractDecoratorDescriptor((model: IModelDescriptor, target: any, propertyKey: string) => {
    const type = Reflect.getMetadata('design:type', target, propertyKey);
    if (type.name !== 'DateTime') {
      throw Error('Proprety CreatedAt must be DateTime type');
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
  return extractDecoratorDescriptor((model: IModelDescriptor, target: any, propertyKey: string) => {
    const type = Reflect.getMetadata('design:type', target, propertyKey);
    if (type.name !== 'DateTime') {
      throw Error('Proprety UpdatedAt must be DateTime type');
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
  return extractDecoratorDescriptor((model: IModelDescriptor, target: any, propertyKey: string) => {
    const type = Reflect.getMetadata('design:type', target, propertyKey);
    if (type.name !== 'DateTime') {
      throw Error('Proprety DeletedAt must be DateTime type');
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
  return extractDecoratorDescriptor((model: IModelDescriptor, target: any, propertyKey: string) => {
    const type = Reflect.getMetadata('design:type', target, propertyKey);
    if (type.name !== 'DateTime') {
      throw Error('Proprety DeletedAt must be Date type');
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
  return extractDecoratorDescriptor((model: IModelDescriptor, _target: any, propertyKey: string) => {
    model.PrimaryKey = propertyKey;
  });
}

/**
 * Marks columns as UUID. Column will be generated ad creation
 */
export function Ignore() {
  return extractDecoratorDescriptor((model: IModelDescriptor, _target: any, propertyKey: string) => {
    const columnDesc = model.Columns.find((c) => c.Name === propertyKey);
    if (!columnDesc) {
      // we dont want to fill all props, they will be loaded from db and mergeg with this
      model.Columns.push({ Name: propertyKey, Ignore: true } as any);
    } else {
      columnDesc.Ignore = true;
    }
  }, true);
}

/**
 * Marks columns as UUID. Column will be generated ad creation
 */
export function Uuid() {
  return extractDecoratorDescriptor((model: IModelDescriptor, _target: any, propertyKey: string) => {
    const columnDesc = model.Columns.find((c) => c.Name === propertyKey);
    if (!columnDesc) {
      // we dont want to fill all props, they will be loaded from db and mergeg with this
      model.Columns.push({ Name: propertyKey, Uuid: true } as any);
    } else {
      columnDesc.Uuid = true;
    }

    model.Converters.set(propertyKey, {
      Class: UuidConverter,
    });
  }, true);
}

export function JunctionTable() {
  return extractDecoratorDescriptor((model: IModelDescriptor, target: any, propertyKey: string) => {
    model.JunctionModelProperties.push({
      Name: propertyKey,
      Model: Reflect.getMetadata('design:type', target, propertyKey),
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
  }, true);
}

/**
 * Marks relation as recursive. When relation is populated it loads all to the top
 *
 */
export function Recursive() {
  return extractDecoratorDescriptor((model: IModelDescriptor, _target: any, propertyKey: string) => {
    if (!model.Relations.has(propertyKey)) {
      throw new InvalidOperation(`cannot set recursive on not existing relation ( relation ${propertyKey} on model ${model.Name} )`);
    }

    const relation = model.Relations.get(propertyKey);

    if (relation.Type !== RelationType.One) {
      throw new InvalidOperation(`cannot set recursive on non one-to-one relation ( relation ${propertyKey} on model ${model.Name} )`);
    }

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
  return extractDecoratorDescriptor((model: IModelDescriptor, target: any, propertyKey: string) => {
    model.Relations.set(propertyKey, {
      Name: propertyKey,
      Type: RelationType.One,
      SourceModel: target.constructor,
      TargetModelType: targetModel,
      TargetModel: null,
      ForeignKey: foreignKey ?? `${propertyKey.toLowerCase()}_id`,
      PrimaryKey: primaryKey ?? model.PrimaryKey,
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
  return extractDecoratorDescriptor((model: IModelDescriptor, target: any, propertyKey: string) => {
    model.Relations.set(propertyKey, {
      Name: propertyKey,
      Type: RelationType.One,
      SourceModel: target.constructor,
      TargetModelType: forwardRef.forwardRef,
      TargetModel: null,
      ForeignKey: foreignKey ?? `${propertyKey.toLowerCase()}_id`,
      PrimaryKey: primaryKey ?? model.PrimaryKey,
      Recursive: false,
    });
  });
}

export interface IHasManyDecoratorOptions {
  foreignKey?: string;
  primaryKey?: string;

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

/**
 * Creates one to many relation with target model.
 *
 * @param targetModel - due to limitations of metadata reflection api in typescript target model mus be set explicitly
 * @param foreignKey - foreign key name in db, defaults to lowercase property name with _id suffix eg. owner_id
 * @param primaryKey - primary key in source table defaults to lowercase property name with _id suffix eg. owner_id
 *
 */
export function HasMany(targetModel: Constructor<ModelBase> | string, options?: IHasManyDecoratorOptions) {
  return extractDecoratorDescriptor((model: IModelDescriptor, target: any, propertyKey: string) => {
    model.Relations.set(propertyKey, {
      Name: propertyKey,
      Type: RelationType.Many,
      SourceModel: target.constructor,
      TargetModelType: targetModel,
      TargetModel: null,
      ForeignKey: options ? options.foreignKey ?? `${model.Name.toLowerCase()}_id` : `${model.Name.toLowerCase()}_id`,
      PrimaryKey: options ? options.primaryKey ?? model.PrimaryKey : model.PrimaryKey,
      Recursive: false,
      Factory: options ? options.factory : null,
      RelationClass: options ? options.type : null,
    });
  });
}

export function Historical(targetModel: Constructor<ModelBase>) {
  return extractDecoratorDescriptor((model: IModelDescriptor, target: any, propertyKey: string) => {
    model.Relations.set(propertyKey, {
      Name: propertyKey,
      Type: RelationType.Many,
      SourceModel: target.constructor,
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
 * @param targetModelPKey - target model primary key name
 * @param sourceModelPKey - source model primary key name
 * @param junctionModelTargetPk - junction table target primary key name ( foreign key for target model )
 * @param junctionModelSourcePk - junction table source primary key name ( foreign key for source model )
 */
export function HasManyToMany(junctionModel: Constructor<ModelBase>, targetModel: Constructor<ModelBase> | string, targetModelPKey?: string, sourceModelPKey?: string, junctionModelTargetPk?: string, junctionModelSourcePk?: string) {
  return extractDecoratorDescriptor((model: IModelDescriptor, target: any, propertyKey: string) => {
    const targetModelDescriptor = extractModelDescriptor(targetModel);

    model.Relations.set(propertyKey, {
      Name: propertyKey,
      Recursive: false,
      Type: RelationType.ManyToMany,
      SourceModel: target.constructor,
      TargetModelType: targetModel,
      TargetModel: null,
      ForeignKey: targetModelPKey ?? targetModelDescriptor.PrimaryKey,
      PrimaryKey: sourceModelPKey ?? model.PrimaryKey,
      JunctionModel: junctionModel,
      JunctionModelTargetModelFKey_Name: junctionModelTargetPk ?? `${targetModelDescriptor.Name.toLowerCase()}_id`,
      JunctionModelSourceModelFKey_Name: junctionModelSourcePk ?? `${model.Name.toLowerCase()}_id`,
    });
  });
}

/**
 * Mark field as datetime type. It will ensure that conversion to & from DB is valid, eg. sqlite DB
 * saves datetime as TEXT and ISO8601 strings
 */
export function DateTime() {
  return extractDecoratorDescriptor((model: IModelDescriptor, target: any, propertyKey: string) => {
    const type = Reflect.getMetadata('design:type', target, propertyKey);
    if (type.name !== 'DateTime') {
      throw Error(`Proprety  ${propertyKey} must be DateTime type`);
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
  return extractDecoratorDescriptor((model: IModelDescriptor, _: any, propertyKey: string) => {
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
export function UniversalConverter(typeColumn: string) {
  return extractDecoratorDescriptor((model: IModelDescriptor, _: any, propertyKey: string) => {
    // add converter for this field
    model.Converters.set(propertyKey, {
      Class: JsonValueConverter,
      Options: {
        TypeColumn: typeColumn,
      },
    });
  });
}

/**
 * Mark field as SET type. It will ensure that conversion to & from DB is valid, eg. to emulate field type SET in sqlite
 */
export function Set() {
  return extractDecoratorDescriptor((model: IModelDescriptor, target: any, propertyKey: string) => {
    const type = Reflect.getMetadata('design:type', target, propertyKey);
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
