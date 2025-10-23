import { _check_arg, _non_empty, _non_nil } from '@spinajs/util';
import { IRelationDescriptor } from './interfaces.js';
import { ModelBase } from './model.js';
import { Primary, UniversalConverter } from './decorators.js';
import { OneToManyRelationList } from './relation-objects.js';
import GlobToRegExp from 'glob-to-regexp';
import _ from "lodash";
import { DateTime } from 'luxon';

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

  protected getType(val: any): 'number' | 'float' | 'string' | 'json' | 'boolean' | 'datetime' {
    if (val instanceof DateTime) {
      return 'datetime';
    }

    if (typeof val === 'object') {
      return 'json';
    }

    return (typeof val).toLocaleLowerCase() as any;
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

  /**
   * 
   * Delete metadata by key in DB
   * 
   * @param key key of the metadata to get
   * @returns 
   */
  public async delete(key: string) {
    const k = _check_arg(_non_empty())(key, 'key');

    const model = await this.Relation.TargetModel.where({
      Key: k,
      user_id: this.Owner.PrimaryKeyValue,
    }).first();

    if (_.isNil(model)) {
      return;
    }

    await model.destroy();
    this.remove((x) => x.Key === k);
  }


  constructor(owner: O, relation: IRelationDescriptor, objects?: R[]) {
    super(owner, relation, objects);



    return new Proxy(this, {
      set: (target: MetadataRelation<MetadataModel<unknown>, ModelBase<unknown>>, prop: string, value: any) => {
        if (prop in target || !isNaN(Number(prop))) {
          target[prop] = value;
          return true;
        }

        const g = GlobToRegExp(prop);
        const test = (m: MetadataModel<unknown>) => g.test(m.Key);
        if (_.isNil(value)) {
          target.remove(test);
        } else {
          const found = target.filter(test);
          if (found.length === 0) {
            const userMeta = new this.Relation.TargetModel() as R;
            userMeta.Key = prop;
            userMeta.Value = value;
            this.Owner.attach(userMeta);
          } else {
            found.forEach((x) => (x.Value = value));
          }
        }
        return true;
      },

      get: (target: MetadataRelation<MetadataModel<unknown>, ModelBase<unknown>>, prop: string) => {
        if (prop in target) {
          return target[prop];
        }

        const g = GlobToRegExp(prop);
        const test = (m: MetadataModel<unknown>) => g.test(m.Key);
        const found = target.filter(test);

        if (found.length === 0) {
          return null;
        }

        if (found.length === 1) {
          return found[0].Value;
        }

        return found.map(x => x.Value);
      },
    }) as any;
  }
}
