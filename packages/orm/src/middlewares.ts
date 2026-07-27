/* eslint-disable prettier/prettier */
import { IRelationDescriptor, IModelDescriptor, RelationType, IBuilderMiddleware, ISelectQueryBuilder } from './interfaces.js';
import { ModelBase } from './model.js';
import _ from 'lodash';
import { ManyQueryRelationList, ManyToManyRelationList, OneToManyRelationList, SingleQueryRelation } from './relation-objects.js';
import { BelongsToRelation, NativeOrmRelation } from './relations.js';
import { DI } from '@spinajs/di';
import { OrmException } from './exceptions.js';
import { DiscriminationMapMiddleware } from './discrimination-middleware.js';

export { DiscriminationMapMiddleware } from './discrimination-middleware.js';

export class HasManyRelationMiddleware implements IBuilderMiddleware {
  constructor(protected _relationQuery: ISelectQueryBuilder, protected _description: IRelationDescriptor, protected _path: string) { }

  public afterQuery(data: any[]): any[] {
    return data;
  }

  public modelCreation(_: any): ModelBase | null {
    return null;
  }

  public async afterHydration(data: ModelBase[]): Promise<any[]> {
    const self = this;
    const pks = data.map((d: any) => {
      return d[this._description.PrimaryKey];
    });

    const hydrateMiddleware = {
      afterQuery(data: any[]) {
        return data;
      },
      modelCreation(): ModelBase | null {
        return null;
      },
      async afterHydration(relationData: ModelBase[]) {
        relationData.forEach((d) => ((d as any).__relationKey__ = self._description.Name));
        data.forEach((d: any) => {
          const relData = relationData.filter((rd) => {
            return d[self._description.PrimaryKey] === (rd as any)[self._description.ForeignKey];
          });

          if (self._description.Factory) {
            d[self._description.Name] = self._description.Factory(d, self._description, d.Container, relData);
          } else {
            if (!self._description.RelationClass) {
              throw new OrmException(`Relation class not defined for ${self._description.Name} in ${self._description.SourceModel?.name}`);
            }

            if (_.isFunction(self._description.RelationClass)) {
              d[self._description.Name] = DI.resolve(self._description.RelationClass(), [d, self._description, relData]);
            } else {
              d[self._description.Name] = DI.resolve(self._description.RelationClass, [d, self._description, relData]);
            }
          }

          // The contents came from the database, so this relation is populated — even when
          // the batched query returned no rows for this particular owner. `Populated` is what
          // tells "loaded and empty" from "never loaded", and unit-of-work `save()` skips the
          // latter entirely ( the empty-array anti-footgun ).
          d[self._description.Name].Populated = true;
          d.snapshotRelation(self._description.Name);
        });
      },
    };

    if (pks.length !== 0) {
      this._relationQuery.whereIn(this._description.ForeignKey, pks);
      this._relationQuery.middleware(hydrateMiddleware);
      return (await this._relationQuery) as any;
    }

    return [];
  }
}

export class BelongsToRelationRecursiveMiddleware implements IBuilderMiddleware {
  constructor(protected _relationQuery: ISelectQueryBuilder, protected _description: IRelationDescriptor, protected _targetModelDescriptor: IModelDescriptor) { }

  public afterQuery(data: any[]): any[] {
    return data;
  }

  public modelCreation(_: any): ModelBase | null {
    return null;
  }

  public async afterHydration(data: ModelBase[]): Promise<any[]> {
    const self = this;
    const pks = data.map((d) => (d as any)[this._description.PrimaryKey]);
    const fKey = this._description.ForeignKey;
    const key = this._description.PrimaryKey;
    const name = this._description.Name;

    const hydrateMiddleware = {
      afterQuery(data: any[]) {
        return data;
      },
      modelCreation(_: any): ModelBase | null {
        return null;
      },
      async afterHydration(relationData: ModelBase[]) {
        relationData.forEach((d) => ((d as any).__relationKey__ = self._description.Name));

        function buildRelationTree(_d: any[], parent?: any): unknown[] {
          const branch: unknown[] = [];

          _d.forEach((d) => {
            if (d[fKey] === parent) {
              const children = buildRelationTree(_d, d[key]);
              if (children) {
                // TODO:
                // implement RecursiveRelation list to allow for
                // manipulation of the recursive data
                d[name] = new OneToManyRelationList(
                  d,
                  {
                    Name: name,
                    Type: RelationType.Many,
                    TargetModelType: d.Model,
                    TargetModel: d.Model,
                    SourceModel: d.Model,
                    ForeignKey: fKey,
                    PrimaryKey: key,
                    Recursive: false,
                  },
                  children as ModelBase<unknown>[],
                );
              }
              branch.push(d);
            }
          });
          return branch;
        }

        const result = buildRelationTree(relationData, null);
        data.forEach((d: any) => {
          d[name] = (result.find((r: any) => r[key] === d[key]) as any)[name];
        });
      },
    };

    this._relationQuery.whereIn(this._description.PrimaryKey, pks);
    this._relationQuery.middleware(new DiscriminationMapMiddleware(this._targetModelDescriptor));
    this._relationQuery.middleware(hydrateMiddleware);
    return (await this._relationQuery) as any;
  }
}

export class QueryRelationMiddleware implements IBuilderMiddleware {
  constructor(protected callback: (data: ModelBase[]) => ISelectQueryBuilder, protected mapper: (owner: ModelBase, data: ModelBase[]) => ModelBase | ModelBase[], protected _description: IRelationDescriptor) { }

  public afterQuery(data: any[]): any[] {
    return data;
  }
  public modelCreation(_: any): ModelBase | null {
    return null;
  }
  public async afterHydration(data: ModelBase[]): Promise<any[] | void> {
    const query = this.callback(data);
    const result = (await query) as ModelBase[];

    data.forEach((d) => {
      const mapped = this.mapper(d, result);
      if (Array.isArray(mapped)) {
        (d as any)[this._description.Name] = new ManyQueryRelationList(d, this._description, mapped);
      } else {
        (d as any)[this._description.Name] = new SingleQueryRelation(d, mapped);
      }
    });
  }
}

export class VirtualRelationMiddleware implements IBuilderMiddleware {
  constructor(protected relationCallback:  (this: ISelectQueryBuilder, relation: NativeOrmRelation) => void, protected callback: (data: ModelBase[]) => ISelectQueryBuilder, protected mapper: (owner: ModelBase, data: ModelBase[]) => ModelBase | ModelBase[], protected _description: IRelationDescriptor) { }
  public afterQuery(data: any[]): any[] {
    return data;
  }
  public modelCreation(_: any): ModelBase | null {
    return null;
  }

  public async afterHydration(data: ModelBase[]): Promise<any[] | void> {
    return Promise.all(data.map(async d => {
      const relationInstance = DI.resolve(this._description.RelationClass!, [d, this._description]);
      await relationInstance.populate(this.relationCallback);

      (d as any)[this._description.Name] = relationInstance;
    }));
  }
}

export class HasManyToManyRelationMiddleware implements IBuilderMiddleware {
  /**
   * @param _relationQuery - the join query through the junction table
   * @param _description - the *synthetic* owner -> junction descriptor built by
   *        `ManyToManyRelation.compile()`. It says `Type: Many` and its `ForeignKey` is the
   *        junction's source column, which is what the row-matching below needs.
   * @param _targetModelDescriptor - descriptor of the model on the far side of the junction
   * @param _relationDescriptor - the model's own `@HasManyToMany` descriptor. Optional so no
   *        existing caller breaks, but without it the `ManyToManyRelationList` handed to the
   *        user carries the synthetic descriptor instead — no `JunctionModel`, no junction
   *        key names — and `sync()` / `update()` / the set operations all fail on it.
   */
  constructor(protected _relationQuery: ISelectQueryBuilder, protected _description: IRelationDescriptor, protected _targetModelDescriptor: IModelDescriptor, protected _relationDescriptor?: IRelationDescriptor) {}

  public afterQuery(data: any[]): any[] {
    return data;
  }

  public modelCreation(_: any): ModelBase | null {
    return null;
  }

  public async afterHydration(data: ModelBase[]): Promise<any[]> {
    const self = this;
    const pks = data.map((d) => (d as any)[this._description.PrimaryKey]);
    const hydrateMiddleware = {
      afterQuery(data: any[]) {
        return data.map((d) => Object.assign({}, d[self._description.Name], { JunctionModel: self.pickProps(d, [self._description.Name]) }));
      },
      modelCreation(_: any): ModelBase | null {
        return null;
      },
      async afterHydration(relationData: ModelBase[]) {
        relationData.forEach((d) => ((d as any).__relationKey__ = self._description.Name));

        data.forEach((d) => {
          const relData = relationData.filter((rd) => (rd as any).JunctionModel[self._description.ForeignKey] === (d as any)[self._description.PrimaryKey]);
          // The real @HasManyToMany descriptor, not the synthetic join one — see the
          // constructor doc. Falls back to the synthetic descriptor so a caller that does
          // not supply it keeps the previous ( broken but unchanged ) behaviour.
          const list = new ManyToManyRelationList(d, self._relationDescriptor ?? self._description, relData);
          // See the note in HasManyRelationMiddleware: loaded-and-empty must be
          // distinguishable from never-loaded.
          list.Populated = true;
          (d as any)[self._description.Name] = list;
          d.snapshotRelation(self._description.Name);
        });

        relationData.forEach((d) => delete (d as any).JunctionModel);
      },
    };

    if (pks.length !== 0) {
      this._relationQuery.whereIn(this._description.ForeignKey, pks);
      this._relationQuery.middleware(new BelongsToRelationResultTransformMiddleware());
      this._relationQuery.middleware(new DiscriminationMapMiddleware(this._targetModelDescriptor));
      this._relationQuery.middleware(hydrateMiddleware);
      return (await this._relationQuery) as any;
    }

    return [];
  }

  private pickProps(source: any, except: string[]) {
    const obj: any = {};
    for (const p in source) {
      if (except.indexOf(p) === -1) {
        obj[p] = source[p];
      }
    }

    return obj;
  }
}

export class BelongsToPopulateDataMiddleware implements IBuilderMiddleware {
  constructor(protected _description: IRelationDescriptor, protected relation: BelongsToRelation) { }

  afterQuery(data: any[]): any[] {
    return data;
  }
  modelCreation(_: any): ModelBase<unknown> | null {
    return null;
  }
  afterHydration(data: ModelBase<unknown>[]): Promise<void | any[]> {
    const relData = data.map((d: any) => d[this._description.Name as any].Value).filter((x) => x !== null && x !== undefined);

    // Every relation created on a builder stores that builder as `_query`
    // ( SelectQueryBuilder._getRelationInstance passes `this` ), so N nested relations under
    // one belongsTo all point at the *same* `_middlewares` array. Concatenating per relation
    // therefore repeated the whole array N times — the duplication a `_.uniqBy` on relation
    // name used to paper over, too coarsely ( it collapsed two genuinely distinct middlewares
    // that happened to share a relation name ) and unsafely
    // ( BelongsToRelationResultTransformMiddleware has no `_description` at all, and
    // DiscriminationMapMiddleware's is an IModelDescriptor, so the key compared a *model*
    // name against a *relation* name ).
    //
    // Collect each distinct middleware object once, in first-seen order.
    const seen = new Set<IBuilderMiddleware>();
    const middlewares: IBuilderMiddleware[] = [];

    for (const relation of (this.relation as any)._relationQuery.Relations as any[]) {
      for (const middleware of (relation._query?._middlewares ?? []) as IBuilderMiddleware[]) {
        if (!seen.has(middleware)) {
          seen.add(middleware);
          middlewares.push(middleware);
        }
      }
    }

    return Promise.all(
      middlewares.map((x) => {
        return x.afterHydration(relData as ModelBase[]);
      }),
    );
  }
}

export class BelongsToRelationResultTransformMiddleware implements IBuilderMiddleware {
  public afterQuery(data: any[]): any[] {
    return data.map((d) => {
      // A real copy. `Object.assign(d)` with one argument returns `d` itself, so this used
      // to nest keys into and delete keys from the caller's own row object. The pipeline
      // writes whatever this returns back into the result array
      // ( builders.ts, `Object.assign(transformedResult, m.afterQuery(...))` ), so returning
      // fresh objects is transparent to everything downstream.
      const transformedData = { ...d };
      for (const key in transformedData) {
        if (key.startsWith('$')) {
          this.setDeep(transformedData, this.keyTransform(key), d[key]);
          delete transformedData[key];
        }
      }

      return transformedData;
    });
  }

  public modelCreation(_: any): ModelBase | null {
    return null;
  }

  // tslint:disable-next-line: no-empty
  public async afterHydration(_data: Array<ModelBase>) { }

  /**
   * Dynamically sets a deeply nested value in an object.
   * Optionally "bores" a path to it if its undefined.
   *
   * @param obj  - The object which contains the value you want to change/set.
   * @param path  - The array representation of path to the value you want to change/set.
   * @param value - The value you want to set it to.
   * @param setrecursively - If true, will set value of non-existing path as well.
   */
  protected setDeep(obj: any, path: any[], value: any, setrecursively = true) {
    path.reduce((a, b, level) => {
      if (setrecursively && typeof a[b] === 'undefined' && level !== path.length - 1) {
        a[b] = {};
        return a[b];
      }

      if (level === path.length - 1) {
        a[b] = value;
        return value;
      }
      return a[b];
    }, obj);
  }

  protected keyTransform(key: string) {
    return key.replace(/\$+/g, '').split('.');
  }
}
