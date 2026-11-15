import type { Constructor } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { extractModelDescriptor, ModelBase, RelationType, type IRelationDescriptor, type ModelData } from '@spinajs/orm';

export interface FactoryContext {
  /** 1 for the first model a factory makes after `createTestDatabase()`, then 2, 3, … */
  seq: number;
}

export type FactoryValues<M> = Partial<ModelData<M>>;

export interface Factory<M> {
  /** A new, unsaved model. Only a saved model given to `for()` sets its key here; a factory owner needs `create()`. */
  build(overrides?: FactoryValues<M>): M;
  /** A model saved through the unit of work ( `save()` ). */
  create(overrides?: FactoryValues<M>): Promise<M>;
  createMany(n: number, overrides?: FactoryValues<M>): Promise<M[]>;
  /**
   * A factory whose models belong to `owner` through the belongs-to relation `relation`. A factory owner is created
   * once, on the first `create()`, and shared by every model of the returned factory.
   * `relation` becomes `K extends RelationName<M>` once lane O ( O5 ) exports `RelationName`.
   */
  for(relation: string, owner: ModelBase | Factory<ModelBase>): Factory<M>;
}

interface Sequence {
  seq: number;
}

interface Owner {
  // Kept whole: ForeignKey and PrimaryKey of a string-target BelongsTo resolve lazily, once the target model is registered.
  readonly descriptor: IRelationDescriptor;
  readonly owner: ModelBase | Factory<ModelBase>;
  created?: Promise<ModelBase>;
}

const sequences = new Set<Sequence>();
const owners = new Set<Owner>();
const definitions = new Map<Constructor<ModelBase>, unknown>();

/**
 * Called by `createTestDatabase()`: every new database starts the sequence numbers at 1, and every owner a `for()`
 * factory created is forgotten, since its row lives in the previous database.
 */
export function resetFactorySequences(): void {
  for (const sequence of sequences) {
    sequence.seq = 0;
  }
  for (const owner of owners) {
    delete owner.created;
  }
}

class ModelFactory<M extends ModelBase> implements Factory<M> {
  public constructor(
    private readonly model: Constructor<M>,
    private readonly definition: (ctx: FactoryContext) => FactoryValues<M>,
    private readonly sequence: Sequence,
    private readonly owners: readonly Owner[],
  ) {}

  public build(overrides?: FactoryValues<M>): M {
    const saved = this.owners.flatMap((o) => (o.owner instanceof ModelBase ? [[o, o.owner] as const] : []));
    return this.make(overrides, saved);
  }

  public async create(overrides?: FactoryValues<M>): Promise<M> {
    const owners = await Promise.all(this.owners.map(async (o) => [o, await this.ownerOf(o)] as const));
    const model = this.make(overrides, owners);
    await model.save();
    return model;
  }

  public async createMany(n: number, overrides?: FactoryValues<M>): Promise<M[]> {
    const created: M[] = [];
    // One by one, so sequence numbers and generated keys follow the same order.
    for (let i = 0; i < n; i++) {
      created.push(await this.create(overrides));
    }
    return created;
  }

  public for(relation: string, owner: ModelBase | Factory<ModelBase>): Factory<M> {
    const descriptor = extractModelDescriptor(this.model)?.Relations.get(relation);
    if (!descriptor || descriptor.Type !== RelationType.One) {
      throw new InvalidArgument(`${this.model.name}.${relation} is not a belongs-to relation; for() sets the foreign key of a single relation`);
    }

    const binding: Owner = { descriptor, owner };
    owners.add(binding);
    return new ModelFactory(this.model, this.definition, this.sequence, [...this.owners, binding]);
  }

  private ownerOf(binding: Owner): Promise<ModelBase> {
    if (binding.owner instanceof ModelBase) {
      return Promise.resolve(binding.owner);
    }

    binding.created ??= binding.owner.create();
    return binding.created;
  }

  private make(overrides: FactoryValues<M> | undefined, owners: ReadonlyArray<readonly [Owner, ModelBase]>): M {
    const keys = Object.fromEntries(owners.map(([binding, owner]) => [binding.descriptor.ForeignKey, Reflect.get(owner, binding.descriptor.PrimaryKey) as unknown]));
    return new this.model({ ...this.definition({ seq: ++this.sequence.seq }), ...keys, ...overrides });
  }
}

export function defineFactory<M extends ModelBase>(model: Constructor<M>, build: (ctx: FactoryContext) => FactoryValues<M>): Factory<M> {
  const sequence: Sequence = { seq: 0 };
  sequences.add(sequence);

  const defined = new ModelFactory(model, build, sequence, []);
  definitions.set(model, defined);
  return defined;
}

export function factory<M extends ModelBase>(model: Constructor<M>): Factory<M> {
  const defined = definitions.get(model);
  if (!defined) {
    throw new InvalidArgument(`no factory defined for ${model.name}: call defineFactory(${model.name}, ...) first`);
  }

  return defined as Factory<M>;
}
