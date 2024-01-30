import { UniversalConverter } from './decorators.js';
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
  public Key: string;

  public Type: 'number' | 'float' | 'string' | 'json' | 'boolean' | 'datetime';

  @UniversalConverter()
  public Value: any;
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
  constructor(owner: O, relation: IRelationDescriptor, objects?: R[]) {
    super(owner, relation, objects);

    return new Proxy(this, {
      set: (target: OneToManyRelationList<MetadataModel<unknown>, ModelBase<unknown>>, prop: string, value: any) => {
        if ((target as any)[prop]) {
          return ((target as any)[prop] = value);
        }

        const found = target.find((x: R) => x.Key === prop);
        if (value === null || value === undefined) {
          target.remove((x: R) => x.Key === prop);
        } else if (found) {
          found.Value = value;
        } else {
          const userMeta = new this.Relation.TargetModel() as R;
          userMeta.Key = prop;
          userMeta.Value = value;

          this.Owner.attach(userMeta);

          target.push(userMeta);
        }
      },

      get: (target: OneToManyRelationList<R, ModelBase<unknown>>, prop: string) => {
        if (prop in target) {
          return (target as any)[prop];
        }

        const found = target.find((x: R) => x.Key === prop);

        if (found) {
          return found.Value;
        }
      },
    }) as any;
  }
}
