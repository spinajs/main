import type { RouteEntry, TypeRef } from '@spinajs/manifest';
import type { ClientModel, ControllerModel } from '../model.js';
import type { RouteModel } from '../routes.js';
import { lastSegment, literal, propertyKey, type TypeContext } from '../ts-type.js';

type Schema = Record<string, unknown>;

export type FormatSlot = 'date-time' | 'date' | 'decimal' | 'int64';

/** A runtime `ConversionPlan` as the generator builds it; `of` is the TS type an object plan is checked against. */
export type PlanNode =
  | { kind: 'format'; format: FormatSlot }
  | { kind: 'ref'; name: string }
  | { kind: 'array'; items: PlanNode }
  | { kind: 'record'; values: PlanNode }
  | { kind: 'object'; closed: boolean; props: [string, PlanNode | null][]; of?: TypePath }
  | { kind: 'union'; discriminator?: Discriminator; members: (PlanNode | null)[] };

export interface Discriminator {
  property: string;
  mapping: [string, string][];
  absent?: string;
}

/** Which type parameters a model type uses: an unused one fails `noUnusedParameters` unless it is named `_F`/`_M`. */
export interface Usage {
  formats: boolean;
  models: boolean;
}

/** The wire TS type of a node: a DTO, a route reply or a route argument, then one index per property, item or value. */
export interface TypePath {
  from: 'dto' | 'reply' | 'arg';
  root: string;
  steps: string[];
}

export type PathHelper = 'Defined' | 'ReplyOf' | 'ArgOf';

/**
 * A schema node's plan, and the schema its model type prints from: every converted node is replaced by a `tsType`, so
 * the printed type and the runtime conversion come from one decision.
 */
export interface Planned {
  plan: PlanNode | null;
  type: unknown;
  uses: Usage;
}

export interface DtoPlan extends Planned {
  id: string;
  plan: PlanNode;
}

/** `undefined` keeps the 4.0 type: the value has no schema, or its type does not come from one (a file, a splat). */
export interface MethodPlan {
  route: RouteModel;
  reply?: Planned;
  args: (Planned | undefined)[];
}

export interface ControllerPlan {
  controller: ControllerModel;
  methods: MethodPlan[];
}

export interface ModelPlans {
  /** By DTO type name, sorted; only DTOs with something to plan. */
  dtos: Map<string, DtoPlan>;
  /** The DTOs an app may register a model for: their values are objects. */
  modelable: Set<string>;
  controllers: ControllerPlan[];
}

const FORMATS = new Set<string>(['date-time', 'date', 'decimal']);
const MODELABLE = new Set<PlanNode['kind']>(['object', 'record', 'union']);

const isSchema = (value: unknown): value is Schema => typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? (value as unknown[]) : []);
const types = (schema: Schema): unknown[] => (Array.isArray(schema.type) ? (schema.type as unknown[]) : schema.type === undefined ? [] : [schema.type]);
const isNullType = (value: unknown): boolean => isSchema(value) && value.type === 'null';
const isPartial = (schema: Schema): boolean => schema['x-explicit'] === 'partial';
const same = (a: PlanNode | null, b: PlanNode | null): boolean => JSON.stringify(a) === JSON.stringify(b);
const NONE: Usage = { formats: false, models: false };
const BOTH: Usage = { formats: true, models: true };
const either = (uses: Usage[]): Usage => ({ formats: uses.some((u) => u.formats), models: uses.some((u) => u.models) });
const wire = (schema: unknown): Planned => ({ plan: null, type: schema, uses: NONE });

// A path lets a nested object plan be checked with `satisfies ObjectPlanOf<…>`.
const child = (path: TypePath | undefined, step: string): TypePath | undefined => path && { ...path, steps: [...path.steps, step] };

/** The type an object plan is checked against; `$Defined` strips the `null` and `undefined` of optional values. */
export function pathType(path: TypePath): string {
  let text = path.root;
  for (const [i, step] of path.steps.entries()) text = `${i === 0 && path.from === 'dto' ? text : `$Defined<${text}>`}[${step}]`;
  return path.from === 'dto' && path.steps.length === 0 ? text : `$Defined<${text}>`;
}

function pathHelpers(path: TypePath): PathHelper[] {
  const helpers: PathHelper[] = path.from === 'dto' && path.steps.length === 0 ? [] : ['Defined'];
  if (path.from === 'reply') helpers.push('ReplyOf');
  if (path.from === 'arg') helpers.push('ArgOf');
  return helpers;
}

function formatSlot(schema: Schema): FormatSlot | undefined {
  const all = types(schema);
  if (!all.includes('string') || all.some((t) => t !== 'string' && t !== 'null')) return undefined;
  if (typeof schema.format === 'string' && FORMATS.has(schema.format)) return schema.format as FormatSlot;
  return schema['x-spinajs-type'] === 'bigint' ? 'int64' : undefined;
}

function baseType(schema: Schema): unknown {
  const all = types(schema).filter((t) => t !== 'null');
  if (all.length === 0 && (isSchema(schema.properties) || isSchema(schema.additionalProperties))) return 'object';
  return all.length === 1 ? all[0] : undefined;
}

function tagOf(schema: unknown): string | undefined {
  if (!isSchema(schema)) return undefined;
  const values = 'const' in schema ? [schema.const] : list(schema.enum);
  return values.length === 1 && (typeof values[0] === 'string' || typeof values[0] === 'number') ? String(values[0]) : undefined;
}

/** Whether a plan does anything when decoding; a closed object alone only matters for encoding. */
export function converts(plan: PlanNode | null): boolean {
  if (!plan) return false;
  switch (plan.kind) {
    case 'format':
    case 'ref':
      return true;
    case 'array':
      return converts(plan.items);
    case 'record':
      return converts(plan.values);
    case 'object':
      return plan.props.some(([, p]) => converts(p));
    case 'union':
      return plan.members.some(converts);
  }
}

type PlanOf<K extends PlanNode['kind']> = Extract<PlanNode, { kind: K }>;

interface Shape {
  properties: Schema;
  required: Set<unknown>;
  closed: boolean;
}

interface Part {
  closed: boolean;
  props: [string, PlanNode | null][];
  type: unknown;
  uses: Usage;
}

class Planner {
  private available = new Set<string>();
  private modelable = new Set<string>();
  private readonly resolving = new Set<string>();

  constructor(private readonly ctx: TypeContext) {}

  /** Refs resolve to DTOs with a plan, and a DTO may lose its plan when its refs do: iterate until nothing drops. */
  public dtos(): { dtos: Map<string, DtoPlan>; modelable: Set<string> } {
    const ids = [...this.ctx.used].sort((a, b) => (this.ctx.nameOf(a) < this.ctx.nameOf(b) ? -1 : 1));
    this.available = new Set(ids.map((id) => this.ctx.nameOf(id)));
    let table = this.table(ids);
    while (table.size < this.available.size) {
      this.available = new Set(table.keys());
      table = this.table(ids);
    }
    // Model types depend on which DTOs are modelable, so they are printed from one more pass.
    this.modelable = new Set([...table].filter(([, dto]) => MODELABLE.has(dto.plan.kind)).map(([name]) => name));
    return { dtos: this.table(ids), modelable: this.modelable };
  }

  public method(entry: RouteEntry, route: RouteModel): MethodPlan {
    const base = `AppClient[${literal(route.controllerKey)}][${literal(route.name)}]`;
    const reply = route.returns === 'void' ? undefined : this.typed(entry.returnType, { from: 'reply', root: `$ReplyOf<${base}>`, steps: [] });
    const args = route.args.map((arg, i) => {
      const param = arg.schema === undefined ? undefined : entry.params.find((p) => p.name === arg.name);
      return param && arg.type === this.ctx.typeOf(param.runtimeType) ? this.typed(param.runtimeType, { from: 'arg', root: `$ArgOf<${base}, ${i}>`, steps: [] }) : undefined;
    });
    return { route, ...(reply ? { reply: converts(reply.plan) ? reply : { ...reply, plan: null } } : {}), args };
  }

  private table(ids: string[]): Map<string, DtoPlan> {
    const table = new Map<string, DtoPlan>();
    for (const id of ids) {
      const name = this.ctx.nameOf(id);
      const { plan, type, uses } = this.node(this.ctx.schemaOf(id), { from: 'dto', root: name, steps: [] }, true);
      if (plan) table.set(name, { id, plan, type, uses });
    }
    return table;
  }

  // Mirrors `TypeContext.typeOf`: a schema named like the TS type is referenced, any other is inlined.
  private typed(ref: TypeRef, path: TypePath): Planned | undefined {
    const schema = ref.schema !== undefined ? this.ctx.schemaOf(ref.schema) : undefined;
    if (ref.schema === undefined || !schema) return undefined;
    return this.node(lastSegment(ref.schema) === ref.text ? { $ref: ref.schema } : schema, path);
  }

  /** `named`: a DTO's own schema, which gets an object plan even when nothing converts, so a model can be registered. */
  private node(schema: unknown, path: TypePath | undefined, named = false): Planned {
    if (!isSchema(schema)) return wire(schema);
    if (typeof schema.$ref === 'string') return this.ref(schema.$ref, schema);
    if ('const' in schema || Array.isArray(schema.enum)) return wire(schema);
    const slot = formatSlot(schema);
    if (slot) return this.format(slot, schema);
    for (const key of ['anyOf', 'oneOf'] as const) if (list(schema[key]).length > 0) return this.union(schema, key, path);
    if (list(schema.allOf).length > 0) return this.intersection(schema, path, named);
    const type = baseType(schema);
    if (type === 'array') return this.array(schema, path);
    return type === 'object' ? this.object(schema, path, named) : wire(schema);
  }

  private ref(id: string, schema: Schema): Planned {
    const name = this.ctx.nameOf(id);
    if (!this.ctx.schemaOf(id) || !this.available.has(name)) return wire(schema);
    const model = `${name}Model<F, M>`;
    return { plan: { kind: 'ref', name }, type: { tsType: this.modelable.has(name) ? `ModelOf<M, ${literal(name)}, ${model}>` : model }, uses: BOTH };
  }

  private format(slot: FormatSlot, schema: Schema): Planned {
    const slotType = { tsType: `F[${literal(slot)}]` };
    const type = types(schema).includes('null') ? { anyOf: [slotType, { type: 'null' }] } : slotType;
    return { plan: { kind: 'format', format: slot }, type, uses: { formats: true, models: false } };
  }

  // A `null` member passes through the walker as a value, so only the other members decide the plan.
  private union(schema: Schema, key: 'anyOf' | 'oneOf', path: TypePath | undefined): Planned {
    const members = list(schema[key]);
    const others = members.filter((m) => !isNullType(m));
    const planned = others.map((m) => this.node(m, others.length === 1 ? path : undefined));
    const type = { ...schema, [key]: members.map((m) => (isNullType(m) ? m : planned[others.indexOf(m)].type)) };
    const plans = planned.map((p) => p.plan);
    const uses = either(planned.map((p) => p.uses));
    if (plans.every((p) => !p)) return wire(schema);
    if (plans.length === 1) return { plan: plans[0], type, uses };
    const discriminator = this.declaredDiscriminator(schema) ?? this.inferredDiscriminator(others, plans);
    if (discriminator) return { plan: { kind: 'union', discriminator, members: plans }, type, uses };
    // Without a way to pick the member the runtime converts only where members agree, which the type cannot show.
    return plans.every((p) => same(p, plans[0])) ? { plan: plans[0], type, uses } : wire(schema);
  }

  private declaredDiscriminator(schema: Schema): Discriminator | undefined {
    const declared = schema['x-discriminator'];
    if (!isSchema(declared) || typeof declared.propertyName !== 'string' || !isSchema(declared.mapping)) return undefined;
    const mapping = Object.entries(declared.mapping)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && this.available.has(this.ctx.nameOf(entry[1])))
      .map(([tag, id]): [string, string] => [tag, this.ctx.nameOf(id)]);
    return { property: declared.propertyName, mapping };
  }

  /**
   * Finds a property that every member but at most one declares as a required literal; the one that lacks it must be
   * closed, so a value without the property can only be that member (`UserDto | ValidationProblem` by `kind`).
   */
  private inferredDiscriminator(members: unknown[], plans: (PlanNode | null)[]): Discriminator | undefined {
    const shapes = members.map((m) => this.shapeOf(m));
    if (!shapes.every((s): s is Shape => s !== undefined)) return undefined;
    const names = [...new Set(shapes.flatMap((s) => Object.keys(s.properties)))];
    for (const property of names) {
      const found = this.tagsBy(property, shapes, plans);
      if (found) return found;
    }
    return undefined;
  }

  private tagsBy(property: string, shapes: Shape[], plans: (PlanNode | null)[]): Discriminator | undefined {
    const found: Discriminator = { property, mapping: [] };
    const tags = new Set<string>();
    let absent = 0;
    for (const [i, shape] of shapes.entries()) {
      const plan = plans[i];
      // A member with no plan needs no mapping entry; one with an inline plan cannot be named in the mapping.
      if (plan && plan.kind !== 'ref') return undefined;
      if (!Object.hasOwn(shape.properties, property)) {
        if (!shape.closed || ++absent > 1) return undefined;
        if (plan) found.absent = plan.name;
        continue;
      }
      const tag = tagOf(shape.properties[property]);
      if (tag === undefined || !shape.required.has(property) || tags.has(tag)) return undefined;
      tags.add(tag);
      if (plan) found.mapping.push([tag, plan.name]);
    }
    return found;
  }

  private shapeOf(member: unknown): Shape | undefined {
    const target = isSchema(member) && typeof member.$ref === 'string' ? this.ctx.schemaOf(member.$ref) : member;
    if (!isSchema(target) || !isSchema(target.properties) || target.anyOf || target.oneOf || target.allOf) return undefined;
    return { properties: target.properties, required: new Set(list(target.required)), closed: target.additionalProperties === false && !isPartial(target) };
  }

  // The server closes an intersection over the union of its members' properties only when every member is closed.
  private intersection(schema: Schema, path: TypePath | undefined, named: boolean): Planned {
    const props: [string, PlanNode | null][] = [];
    const memberTypes: unknown[] = [];
    const uses: Usage[] = [];
    let closed = true;
    for (const member of list(schema.allOf)) {
      const part = this.part(member, path);
      if (!part) return wire(schema);
      closed &&= part.closed;
      for (const [name, plan] of part.props) {
        const earlier = props.find(([key]) => key === name);
        if (earlier && !same(earlier[1], plan)) return wire(schema);
        if (!earlier) props.push([name, plan]);
      }
      memberTypes.push(part.type);
      uses.push(part.uses);
    }
    if (!named && !closed && !props.some(([, p]) => p)) return wire(schema);
    return { plan: { kind: 'object', closed, props, ...(path ? { of: path } : {}) }, type: { ...schema, allOf: memberTypes }, uses: either(uses) };
  }

  private part(member: unknown, path: TypePath | undefined): Part | undefined {
    if (!isSchema(member)) return undefined;
    if (typeof member.$ref !== 'string') {
      const planned = this.node(member, path, true);
      if (!planned.plan) return Object.keys(member).length === 0 ? { closed: false, props: [], type: member, uses: NONE } : undefined;
      return planned.plan.kind === 'object' ? { closed: this.closedPart(member, planned.plan), props: planned.plan.props, type: planned.type, uses: planned.uses } : undefined;
    }
    const id = member.$ref;
    const target = this.ctx.schemaOf(id);
    if (!target || this.resolving.has(id)) return undefined;
    this.resolving.add(id);
    const planned = this.node(target, path, true);
    this.resolving.delete(id);
    if (planned.plan?.kind !== 'object') return undefined;
    const name = this.ctx.nameOf(id);
    // The members of an intersection convert inline: a model registered for one of them does not run.
    const type = this.available.has(name) ? { tsType: `${name}Model<F, M>` } : member;
    return { closed: this.closedPart(target, planned.plan), props: planned.plan.props, type, uses: this.available.has(name) ? BOTH : planned.uses };
  }

  // A member that is itself an intersection is closed as the server prepares it, which its own plan already says.
  private closedPart(schema: Schema, plan: PlanOf<'object'>): boolean {
    if (Array.isArray(schema.allOf)) return plan.closed;
    return schema.additionalProperties === false && isSchema(schema.properties) && !isPartial(schema) && !schema.anyOf && !schema.oneOf;
  }

  // A tuple has no plan kind, so it converts nothing.
  private array(schema: Schema, path: TypePath | undefined): Planned {
    if (!isSchema(schema.items)) return wire(schema);
    const items = this.node(schema.items, child(path, 'number'));
    return items.plan ? { plan: { kind: 'array', items: items.plan }, type: { ...schema, items: items.type }, uses: items.uses } : wire(schema);
  }

  private object(schema: Schema, path: TypePath | undefined, named: boolean): Planned {
    const properties = isSchema(schema.properties) ? schema.properties : undefined;
    const extra = schema.additionalProperties;
    if (!properties && isSchema(extra)) {
      const values = this.node(extra, child(path, 'string'));
      return values.plan ? { plan: { kind: 'record', values: values.plan }, type: { ...schema, additionalProperties: values.type }, uses: values.uses } : wire(schema);
    }
    const planned = Object.entries(properties ?? {}).map(([name, value]): [string, Planned] => [name, this.node(value, child(path, literal(name)))]);
    const closed = extra === false && !isPartial(schema);
    const convert = planned.some(([, p]) => p.plan);
    if (!named && !closed && !convert) return wire(schema);
    const type: Schema = { ...schema, ...(properties ? { properties: Object.fromEntries(planned.map(([name, p]) => [name, p.type])) } : {}) };
    // Typed extra keys stay wire values, and an index signature must admit the converted property types.
    if (convert && isSchema(extra)) type.additionalProperties = true;
    const props = planned.map(([name, p]): [string, PlanNode | null] => [name, p.plan]);
    return { plan: { kind: 'object', closed, props, ...(path ? { of: path } : {}) }, type, uses: either(planned.map(([, p]) => p.uses)) };
  }
}

export function planModels(model: ClientModel): ModelPlans {
  const planner = new Planner(model.ctx);
  const { dtos, modelable } = planner.dtos();
  const controllers = model.controllers.map((controller) => ({ controller, methods: controller.routes.map((route, i) => planner.method(controller.entry.routes[i], route)) }));
  return { dtos, modelable, controllers };
}


// A `__proto__` key in an object literal sets the prototype instead of defining a property.
const key = (name: string): string => (name === '__proto__' ? `['__proto__']` : propertyKey(name));

function printUnion(plan: PlanOf<'union'>): string {
  const d = plan.discriminator;
  const mapping = d && (d.mapping.length > 0 ? `{ ${d.mapping.map(([tag, name]) => `${key(tag)}: ${literal(name)}`).join(', ')} }` : '{}');
  const discriminator = d ? `discriminator: { property: ${literal(d.property)}, mapping: ${mapping}${d.absent !== undefined ? `, absent: ${literal(d.absent)}` : ''} }, ` : '';
  return `{ kind: 'union', ${discriminator}members: [${plan.members.map(printPlan).join(', ')}] }`;
}

export function printPlan(plan: PlanNode | null): string {
  if (!plan) return 'null';
  switch (plan.kind) {
    case 'format':
      return `{ kind: 'format', format: ${literal(plan.format)} }`;
    case 'ref':
      return `{ kind: 'ref', name: ${literal(plan.name)} }`;
    case 'array':
      return `{ kind: 'array', items: ${printPlan(plan.items)} }`;
    case 'record':
      return `{ kind: 'record', values: ${printPlan(plan.values)} }`;
    case 'object': {
      const props = plan.props.map(([name, p]) => `${key(name)}: ${printPlan(p)}`).join(', ');
      return `{ kind: 'object', closed: ${plan.closed}, props: ${props ? `{ ${props} }` : '{}'} }${plan.of ? ` satisfies ObjectPlanOf<${pathType(plan.of)}>` : ''}`;
    }
    case 'union':
      return printUnion(plan);
  }
}

/** Adds the runtime types a printed plan names: `ObjectPlanOf` and the path helpers of its `satisfies` checks. */
export function planImports(plan: PlanNode | null, into: Set<string>): void {
  if (!plan) return;
  if (plan.kind === 'array') planImports(plan.items, into);
  else if (plan.kind === 'record') planImports(plan.values, into);
  else if (plan.kind === 'union') plan.members.forEach((m) => planImports(m, into));
  else if (plan.kind === 'object') {
    if (plan.of) for (const name of ['ObjectPlanOf', ...pathHelpers(plan.of)]) into.add(name);
    plan.props.forEach(([, p]) => planImports(p, into));
  }
}

export function printPlans(planned: ModelPlans): string {
  const dtos = [...planned.dtos].map(([name, dto]) => `  ${key(name)}: ${printPlan(dto.plan)},`);
  const controllers = planned.controllers.flatMap(({ controller, methods }) => {
    const lines = methods
      .filter((m) => m.reply?.plan || m.args.some((a) => a?.plan))
      .map((m) => `    ${key(m.route.name)}: { ${m.reply?.plan ? `reply: ${printPlan(m.reply.plan)}, ` : ''}args: [${m.args.map((a) => printPlan(a?.plan ?? null)).join(', ')}] },`);
    return lines.length > 0 ? [`  ${key(controller.key)}: {\n${lines.join('\n')}\n  },`] : [];
  });
  const block = (items: string[]) => (items.length > 0 ? `{\n${items.join('\n')}\n}` : '{}');
  return `const plans: ConversionPlans = ${block(dtos)};\n\nconst routePlans: RoutePlans = ${block(controllers)};`;
}
