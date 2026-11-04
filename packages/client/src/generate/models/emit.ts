import type { ClientModel } from '../model.js';
import { checksShape, planModels, printPlans, type ModelPlans } from './plans.js';
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
  'export function createAppClient<const F extends FormatCodecs = Record<never, never>, const M extends Partial<Record<DtoName, ModelEntry<unknown>>> = Record<never, never>>(options: ClientOptions & { formats?: F; models?: M }): AppModelClient<FormatTypes<F>, M>;',
  'export function createAppClient(options: ModelClientOptions): unknown {',
  '  return createModelClient(definition, plans, routePlans, options);',
  '}',
].join('\n');

const IMPORTS = ['ClientDefinition', 'ClientOptions', 'ConversionPlans', 'FormatCodecs', 'Formats', 'FormatTypes', 'ModelClientOptions', 'ModelEntry', 'ObjectPlanOf', 'PlainFormats', 'RoutePlans'];

// A DTO named `F` would be shadowed by the type parameter inside every model type.
const TYPE_PARAMETERS = ['F', 'M', '_F', '_M'];

/** Interface merging would silently join a model type with a same-named DTO or client, so a second declaration fails. */
function checkNames(model: ClientModel, planned: ModelPlans): void {
  const declared = new Set([...[...model.ctx.used].map((id) => model.ctx.nameOf(id)), ...model.controllers.map((c) => `${c.base}Client`), 'AppClient']);
  const added = [
    ...IMPORTS,
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

/** What `--models` adds to `client.ts`: model types, conversion plans and the `createAppClient` overloads. */
export async function emitModels(model: ClientModel): Promise<EmittedModels> {
  const planned = planModels(model);
  checkNames(model, planned);
  const checked = [...planned.dtos.values()].some((d) => checksShape(d.plan)) || planned.controllers.some((c) => c.methods.some((m) => checksShape(m.reply?.plan ?? null) || m.args.some((a) => checksShape(a?.plan ?? null))));
  const names = IMPORTS.filter((name) => checked || name !== 'ObjectPlanOf');
  return {
    imports: ['createModelClient', ...names.map((name) => `type ${name}`)].join(', '),
    types: await emitModelTypes(planned, model.ctx),
    plans: printPlans(planned),
    overload: OVERLOAD,
  };
}
