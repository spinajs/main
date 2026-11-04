import type { ClientModel } from '../model.js';
import { planImports, planModels, printPlans, type ModelPlans } from './plans.js';
import { emitModelTypes, hasModelClient } from './types.js';

export interface EmittedModels {
  /** The runtime names `client.ts` imports instead of `createClient`. */
  imports: string;
  types: string;
  plans: string;
  overload: string;
}

const OVERLOAD = [
  'export function createAppClient(options: ClientOptions & { formats?: undefined; models?: undefined }): AppClient;',
  'export function createAppClient<const F extends FormatCodecs = $NoEntries, const M extends $ModelMap<DtoName> = $NoEntries>(options: ClientOptions & { formats?: F; models?: M }): AppModelClient<FormatTypes<F>, M>;',
  'export function createAppClient(options: ModelClientOptions): unknown {',
  '  return createModelClient(definition, plans, routePlans, options);',
  '}',
].join('\n');

const IMPORTS = ['ClientDefinition', 'ClientOptions', 'ConversionPlans', 'FormatCodecs', 'FormatTypes', 'ModelClientOptions', 'PlainFormats', 'RoutePlans'];

// Global types such as `Record` or `NonNullable` could be shadowed by a DTO of that name; `$` never appears in one.
const HELPERS = ['ModelOf', 'FormatSlots', 'NoEntries', 'ModelMap'];
const PLAN_HELPERS = ['Defined', 'ReplyOf', 'ArgOf'];

// A DTO named `F` would be shadowed by the type parameter inside every model type.
const TYPE_PARAMETERS = ['F', 'M', '_F', '_M'];

/** Interface merging would silently join a model type with a same-named DTO or client, so a second declaration fails. */
function checkNames(model: ClientModel, planned: ModelPlans): void {
  const declared = new Set([...[...model.ctx.used].map((id) => model.ctx.nameOf(id)), ...model.controllers.map((c) => `${c.base}Client`), 'AppClient']);
  const added = [
    ...IMPORTS,
    'ObjectPlanOf',
    'createModelClient',
    ...TYPE_PARAMETERS,
    'ModelOf',
    'DtoName',
    'AppModelClient',
    ...[...planned.dtos.keys()].map((name) => `${name}Model`),
    ...planned.controllers.filter(hasModelClient).map((c) => `${c.controller.base}ModelClient`),
  ];
  for (const name of added) {
    if (declared.has(name)) throw new Error(`generateClientFiles: models: client.ts would declare '${name}' twice; rename the schema or the controller`);
    declared.add(name);
  }
}

function importList(planned: ModelPlans): string {
  const named = new Set<string>();
  for (const dto of planned.dtos.values()) planImports(dto.plan, named);
  for (const { methods } of planned.controllers) {
    for (const m of methods) [m.reply, ...m.args].forEach((p) => planImports(p?.plan ?? null, named));
  }
  const plain = [...IMPORTS, ...(named.has('ObjectPlanOf') ? ['ObjectPlanOf'] : [])].sort();
  const aliased = [...HELPERS, ...PLAN_HELPERS.filter((name) => named.has(name))];
  return ['createModelClient', ...plain.map((name) => `type ${name}`), ...aliased.map((name) => `type ${name} as $${name}`)].join(', ');
}

/** What `--models` adds to `client.ts`: model types, conversion plans and the `createAppClient` overloads. */
export async function emitModels(model: ClientModel): Promise<EmittedModels> {
  const planned = planModels(model);
  checkNames(model, planned);
  return {
    imports: importList(planned),
    types: await emitModelTypes(planned, model.ctx),
    plans: printPlans(planned),
    overload: OVERLOAD,
  };
}
