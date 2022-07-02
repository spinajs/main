/* eslint-disable prettier/prettier */
import { ForwardRefFunction } from './interfaces';
import { ModelBase } from './model';
import { isConstructor } from '@spinajs/di';
import { SingleRelation } from './relations';

export abstract class ModelHydrator {
  public abstract hydrate(target: any, values: any): void;
}

export class OneToOneRelationHydrator extends ModelHydrator {
  public hydrate(target: ModelBase, values: any): void {
    const descriptor = target.ModelDescriptor;
    if (!descriptor) {
      throw new Error(`cannot hydrate model ${target.constructor.name}, no model descriptor found`);
    }

    for (const [key, val] of descriptor.Relations) {
      if (values[key] != null) {
        const entity = target as any;
        const tEntity = !isConstructor(val.TargetModel) ? new ((val.TargetModel as ForwardRefFunction)())() : new (val.TargetModel as any)();
        tEntity.hydrate(values[key]);
        (tEntity as any)['__relationKey__'] = key;
        const rel = new SingleRelation(target, val.TargetModel, val, tEntity);
        entity[key] = new Proxy(rel, {
          get: function (target, name) {
            return name in target.UnderlyingValue ? target.UnderlyingValue[name] : (target as any)[name];
          },
          set: function (obj, prop, newVal) {
            if (prop in obj.UnderlyingValue) {
              obj.UnderlyingValue[prop] = newVal;
              return true;
            }

            return false;
          },
        });
        delete (target as any)[val.ForeignKey];
      }
    }
  }
}

export class DbPropertyHydrator extends ModelHydrator {
  public hydrate(target: ModelBase, values: any): void {
    const descriptor = target.ModelDescriptor;
    if (!descriptor) {
      throw new Error(`cannot hydrate model ${target.constructor.name}, no model descriptor found`);
    }

    // filter out model joined properties
    // we handle it in later
    const keys = Object.keys(values).filter((k) => descriptor.Columns?.find((c) => c.Name === k));
    keys.forEach((k) => {
      // skip if column is primary key & is null
      // we dont want to override pkey of target model
      if (k === descriptor.PrimaryKey && !values[k]) {
        return;
      }

      const column = descriptor.Columns?.find((c) => c.Name === k);
      (target as any)[k] = column.Converter ? column.Converter.fromDB(values[k]) : values[k];
    });
  }
}

export class NonDbPropertyHydrator extends ModelHydrator {
  public hydrate(target: ModelBase, values: any): void {
    const descriptor = target.ModelDescriptor;
    if (!descriptor) {
      throw new Error(`cannot hydrate model ${target.constructor.name}, no model descriptor found`);
    }

    // get only properties that are not in DB
    const keys = Object.keys(values).filter((k) => descriptor.Columns?.find((c) => c.Name === k) === undefined);
    keys.forEach((k) => {
      (target as any)[k] = values[k];
    });
  }
}

export class JunctionModelPropertyHydrator extends ModelHydrator {
  public hydrate(target: ModelBase, values: any): void {
    const descriptor = target.ModelDescriptor;
    if (!descriptor) {
      throw new Error(`cannot hydrate model ${target.constructor.name}, no model descriptor found`);
    }

    for (const jt of descriptor.JunctionModelProperties) {
      const entity = new jt.Model();
      entity.hydrate(values.JunctionModel);

      (target as any)[jt.Name] = entity;
    }
  }
}
