import { DateTime } from 'luxon';
import { Primary, UniversalConverter } from './decorators.js';
import { OrmException } from './exceptions.js';
import { IRelationDescriptor } from './interfaces.js';
import { ModelBase } from './model.js';
import { OneToManyRelationList } from './relation-objects.js';

/**
 * Relation object for user metadata
 * Base class for all metadata related models.
 *
 * Metadata is used to store additional information about particular model, that we dont know at design time.
 */
export abstract class MetadataModel<T> extends ModelBase<MetadataModel<T>> {
  protected _value: any;

  @Primary()
  public Id: number;

  public Key: string;

  public Type: 'number' | 'float' | 'string' | 'json' | 'boolean' | 'datetime';

  @UniversalConverter()
  public get Value() {
    return this._value;
  }

  public set Value(value: any) {
    this._value = value;
    this.Type = this.getType(value);
  }

  protected getType(val: any) {
    if (val instanceof DateTime) {
      return 'datetime';
    }

    if (typeof val === 'number') {
      return 'number';
    }

    if (typeof val === 'boolean') {
      return 'boolean';
    }

    if (typeof val === 'string') {
      return 'string';
    }

    if (typeof val === 'object') {
      return 'json';
    }

    throw new OrmException(`Cannot guess type for ${val}`);
  }
}

/**
 *
 * Base class for all metadata related relations.
 * It allows to access metadata as relation object properties. use it for example like this:
 *
 * ```typescript
 * const user = await User.find(1);
 * user.Metadata['test:test'] = 'test';
 * await user.Metadata.sync();
 * ```
 */
export class MetadataRelation<R extends MetadataModel<R>, O extends ModelBase<O>> extends OneToManyRelationList<R, O> {
  [key: string]: any;

  constructor(owner: O, relation: IRelationDescriptor, objects?: R[]) {
    super(owner, relation, objects);

    return new Proxy(this, {
      set: (target: OneToManyRelationList<MetadataModel<unknown>, ModelBase<unknown>>, prop: string, value: any) => {
        if (prop in target || !isNaN(prop as any)) {
          (target as any)[prop] = value;
        } else {
          const isRegEx = (prop: string) => prop.startsWith('/') && prop.endsWith('/');
          let test: (model: MetadataModel<unknown>) => boolean = null;

          if (isRegEx(prop)) {
            const exprr = new RegExp(prop.substring(1, prop.length - 1));
            test = (model: MetadataModel<unknown>) => exprr.test(model.Key);
          } else {
            test = (model: MetadataModel<unknown>) => model.Key === prop;
          }

          if (value === null || value === undefined) {
            target.remove(test);
          } else {
            const found = target.filter(test);

            if (found.length === 0 && !isRegEx(prop)) {
              const userMeta = new this.Relation.TargetModel() as R;
              userMeta.Key = prop;
              userMeta.Value = value;

              this.Owner.attach(userMeta);
            } else {
              found.forEach((x) => (x.Value = value));
            }
          }
        }

        return true;
      },

      get: (target: OneToManyRelationList<R, ModelBase<unknown>>, prop: string) => {
        if (prop in target || !isNaN(prop as any)) {
          return (target as any)[prop];
        }

        const found = target.find((x: R) => x.Key === prop);

        if (found) {
          return found.Value;
        }

        return null;
      },
    }) as any;
  }
}
