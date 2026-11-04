import { compileType } from '../dto-types.js';
import { parameterList } from '../routes.js';
import { literal, TypeContext } from '../ts-type.js';
import { usage, type ControllerPlan, type MethodPlan, type ModelPlans, type Planned } from './plans.js';

type Usage = ReturnType<typeof usage>;

const isSchema = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Prints inline route types with the planner's `tsType` replacements. */
class ModelTypeContext extends TypeContext {
  public override expression(schema: unknown): string {
    return isSchema(schema) && typeof schema.tsType === 'string' ? schema.tsType : super.expression(schema);
  }
}

// An unused type parameter fails `noUnusedParameters` unless its name starts with `_`.
export function typeParameters(used: Usage): string {
  return `<${used.formats ? 'F' : '_F'} extends Required<Formats> = PlainFormats, ${used.models ? 'M' : '_M'} = Record<never, never>>`;
}

const anyUse = (uses: Usage[]): Usage => ({ formats: uses.some((u) => u.formats), models: uses.some((u) => u.models) });
const converted = (planned: Planned | undefined): boolean => planned !== undefined && (usage(planned.type).formats || usage(planned.type).models);

/** Whether the controller's model client differs from its 4.0 client. */
export function hasModelClient(controller: ControllerPlan): boolean {
  return controller.methods.some((m) => converted(m.reply) || m.args.some(converted));
}

const MODEL_OF = [
  '/** The model registered for a DTO in `M`, else the DTO with its formats converted. */',
  'export type ModelOf<M, K extends string, Fallback> = K extends keyof M ? (M[K] extends ModelEntry<infer T> ? T : Fallback) : Fallback;',
].join('\n');

function dtoName(modelable: Set<string>): string {
  const names = [...modelable].map((name) => literal(name));
  return `/** The DTOs \`createAppClient\` accepts a model for. */\nexport type DtoName = ${names.length > 0 ? names.join(' | ') : 'never'};`;
}

async function modelDeclaration(name: string, planned: Planned, ctx: TypeContext): Promise<string> {
  const type = `${name}Model`;
  const code = await compileType(type, planned.type, ctx);
  const header = new RegExp(`^(export (?:interface|type) ${type})\\b`, 'm');
  if (!header.test(code)) throw new Error(`generateClientFiles: models: could not print the type ${type}`);
  return code.replace(header, `$1${typeParameters(usage(planned.type))}`);
}

function methodLine(method: MethodPlan, printer: ModelTypeContext): { line: string; used: Usage } {
  const { route } = method;
  const typeOf = (planned: Planned | undefined, fallback: string) => (converted(planned) ? printer.expression(planned?.type) : fallback);
  const args = route.args.map((arg, i) => ({ ...arg, type: typeOf(method.args[i], arg.type) }));
  const used = anyUse([method.reply, ...method.args].map((p) => (p ? usage(p.type) : { formats: false, models: false })));
  return { line: `  ${route.name}(${parameterList(args).join(', ')}): Promise<${typeOf(method.reply, route.returns)}>;`, used };
}

/** `ModelOf`, `DtoName`, one `<Dto>Model<F, M>` per planned DTO, the converting controller clients and `AppModelClient`. */
export async function emitModelTypes(planned: ModelPlans, ctx: TypeContext): Promise<string> {
  const blocks = [MODEL_OF, dtoName(planned.modelable)];
  for (const [name, dto] of planned.dtos) blocks.push(await modelDeclaration(name, dto, ctx));
  const printer = new ModelTypeContext(ctx.manifest);
  const members: string[] = [];
  for (const controller of planned.controllers) {
    const { key, base } = controller.controller;
    if (!hasModelClient(controller)) {
      members.push(`  ${key}: ${base}Client;`);
      continue;
    }
    const lines = controller.methods.map((m) => methodLine(m, printer));
    blocks.push(`export interface ${base}ModelClient${typeParameters(anyUse(lines.map((l) => l.used)))} {\n${lines.map((l) => l.line).join('\n')}\n}`);
    members.push(`  ${key}: ${base}ModelClient<F, M>;`);
  }
  const converts = planned.controllers.some(hasModelClient);
  blocks.push(`export interface AppModelClient${typeParameters({ formats: converts, models: converts })} {\n${members.join('\n')}\n}`);
  return blocks.join('\n\n');
}
