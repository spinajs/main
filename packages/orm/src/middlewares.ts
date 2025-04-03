/* eslint-disable prettier/prettier */
import { IRelationDescriptor, IModelDescriptor, RelationType, IBuilderMiddleware, ISelectQueryBuilder } from './interfaces.js';
import { ModelBase } from './model.js';
import _ from 'lodash';
import { ManyToManyRelationList, OneToManyRelationList } from './relation-objects.js';
import { BelongsToRelation } from './relations.js';
import { DI } from '@spinajs/di';
import { OrmException } from './exceptions.js';

export class HasManyRelationMiddleware implements IBuilderMiddleware {
  constructor(protected _relationQuery: ISelectQueryBuilder, protected _description: IRelationDescriptor, protected _path: string) {}

  public afterQuery(data: any[]): any[] {
    return data;
  }

  public modelCreation(_: any): ModelBase {
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
      modelCreation(): ModelBase {
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
              throw new OrmException(`Relation class not defined for ${self._description.Name} in ${self._description.SourceModel.name}`);
            }

            if (_.isFunction(self._description.RelationClass)) {
              d[self._description.Name] = DI.resolve(self._description.RelationClass(), [d, self._description, relData]);
            } else {
              d[self._description.Name] = DI.resolve(self._description.RelationClass, [d, self._description, relData]);
            }
          }
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
  constructor(protected _relationQuery: ISelectQueryBuilder, protected _description: IRelationDescriptor, protected _targetModelDescriptor: IModelDescriptor) {}

  public afterQuery(data: any[]): any[] {
    return data;
  }

  public modelCreation(_: any): ModelBase {
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
      modelCreation(_: any): ModelBase {
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
  constructor(protected callback: (data: ModelBase[]) => ISelectQueryBuilder) {}

  public afterQuery(data: any[]): any[] {
    return data;
  }
  public modelCreation(_: any): ModelBase {
    return null;
  }
  public async afterHydration(data: ModelBase[]): Promise<any[] | void> {
    return (await this.callback(data)) as any;
  }
}

export class HasManyToManyRelationMiddleware implements IBuilderMiddleware {
  constructor(protected _relationQuery: ISelectQueryBuilder, protected _description: IRelationDescriptor, protected _targetModelDescriptor: IModelDescriptor) {}

  public afterQuery(data: any[]): any[] {
    return data;
  }

  public modelCreation(_: any): ModelBase {
    return null;
  }

  public async afterHydration(data: ModelBase[]): Promise<any[]> {
    const self = this;
    const pks = data.map((d) => (d as any)[this._description.PrimaryKey]);
    const hydrateMiddleware = {
      afterQuery(data: any[]) {
        return data.map((d) => Object.assign({}, d[self._description.Name], { JunctionModel: self.pickProps(d, [self._description.Name]) }));
      },
      modelCreation(_: any): ModelBase {
        return null;
      },
      async afterHydration(relationData: ModelBase[]) {
        relationData.forEach((d) => ((d as any).__relationKey__ = self._description.Name));

        data.forEach((d) => {
          const relData = relationData.filter((rd) => (rd as any).JunctionModel[self._description.ForeignKey] === (d as any)[self._description.PrimaryKey]);
          (d as any)[self._description.Name] = new ManyToManyRelationList(d, self._description, relData);
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
  constructor(protected _description: IRelationDescriptor, protected relation: BelongsToRelation) {}

  afterQuery(data: any[]): any[] {
    return data;
  }
  modelCreation(_: any): ModelBase<unknown> {
    return null;
  }
  afterHydration(data: ModelBase<unknown>[]): Promise<void | any[]> {
    const relData = data.map((d: any) => d[this._description.Name as any].Value).filter((x) => x !== null && x !== undefined);
    const middlewares = ((this.relation as any)._relationQuery.Relations as any[])
      .map((x) => {
        return x._query._middlewares;
      })
      .reduce((prev, current) => {
        return prev.concat(current);
      }, []);

    // HACK
    // TODO: this is only temporary solution to execute only unique middlewares.
    // Somewhere else in code is bug that causes multiple same middlewares to be added to the query
    //
    // Check hasmanytomany relation with multiple nested belongs to relation to see the bug
    return Promise.all(
      _.uniqBy(middlewares, (x: { _description: { Name: string } }) => x._description.Name).map((x: any) => {
        return x.afterHydration(relData);
      }),
    );
  }
}

export class BelongsToRelationResultTransformMiddleware implements IBuilderMiddleware {
  public afterQuery(data: any[]): any[] {
    return data.map((d) => {
      const transformedData = Object.assign(d);
      for (const key in transformedData) {
        if (key.startsWith('$')) {
          this.setDeep(transformedData, this.keyTransform(key), d[key]);
          delete transformedData[key];
        }
      }

      return transformedData;
    });
  }

  public modelCreation(_: any): ModelBase {
    return null;
  }

  // tslint:disable-next-line: no-empty
  public async afterHydration(_data: Array<ModelBase>) {}

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

export class DiscriminationMapMiddleware implements IBuilderMiddleware {
  constructor(protected _description: IModelDescriptor) {}

  public afterQuery(data: any[]): any[] {
    return data;
  }

  public modelCreation(data: any): ModelBase {
    if (this._description.DiscriminationMap && this._description.DiscriminationMap.Field) {
      const distValue = data[this._description.DiscriminationMap.Field];
      if (distValue && this._description.DiscriminationMap.Models.has(distValue)) {
        const result = new (this._description.DiscriminationMap.Models.get(distValue) as any)();
        result.hydrate(data);

        return result;
      }
    }

    return null;
  }

  // tslint:disable-next-line: no-empty
  public async afterHydration(_data: ModelBase[]) {}
}
