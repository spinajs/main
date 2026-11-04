import { compileType } from '../dto-types.js';
import { parameterList } from '../routes.js';
import { literal, type TypeContext } from '../ts-type.js';
import type { ControllerPlan, MethodPlan, ModelPlans, Planned, Usage } from './plans.js';

const NONE: Usage = { formats: false, models: false };

// An unused type parameter fails `noUnusedParameters` unless its name starts with `_`.
export function typeParameters(used: Usage): string {
  return `<${used.formats ? 'F' : '_F'} extends $FormatSlots = PlainFormats, ${used.models ? 'M' : '_M'} = $NoEntries>`;
}

const anyUse = (uses: Usage[]): Usage => ({ formats: uses.some((u) => u.formats), models: uses.some((u) => u.models) });
const converted = (planned: Planned | undefined): boolean => planned !== undefined && (planned.uses.formats || planned.uses.models);

/** Whether the controller's model client differs from its 4.0 client. */
export function hasModelClient(controller: ControllerPlan): boolean {
  return controller.methods.some((m) => converted(m.reply) || m.args.some(converted));
}

const MODEL_OF = [
  '/** The model registered for a DTO in `M`, else the DTO with its formats converted. */',
  'export type ModelOf<M, K extends string, Fallback> = $ModelOf<M, K, Fallback>;',
].join('\n');

function dtoName(modelable: Set<string>): string {
  const names = [...modelable].map((name) => literal(name));
  return `/** The DTOs \`createAppClient\` accepts a model for. */\nexport type DtoName = ${names.length > 0 ? names.join(' | ') : 'never'};`;
}

// json-schema-to-typescript has no generics, so the type parameters are added to the declaration it prints.
async function modelDeclaration(name: string, planned: Planned, ctx: TypeContext): Promise<string> {
  const type = `${name}Model`;
  const code = await compileType(type, planned.type, ctx);
  const header = new RegExp(`^(export (?:interface|type) ${type})\\b`, 'm');
  if (!header.test(code)) throw new Error(`generateClientFiles: models: could not print the type ${type}`);
  return code.replace(header, `$1${typeParameters(planned.uses)}`);
}

function methodLine(method: MethodPlan, printer: TypeContext): { line: string; used: Usage } {
  const { route } = method;
  const typeOf = (planned: Planned | undefined, fallback: string) => (converted(planned) ? printer.expression(planned?.type) : fallback);
  const args = route.args.map((arg, i) => ({ ...arg, type: typeOf(method.args[i], arg.type) }));
  const used = anyUse([method.reply, ...method.args].map((p) => p?.uses ?? NONE));
  return { line: `  ${route.name}(${parameterList(args).join(', ')}): Promise<${typeOf(method.reply, route.returns)}>;`, used };
}

/** `ModelOf`, `DtoName`, one `<Dto>Model<F, M>` per planned DTO, the converting controller clients and `AppModelClient`. */
export async function emitModelTypes(planned: ModelPlans, ctx: TypeContext): Promise<string> {
  const blocks = [MODEL_OF, dtoName(planned.modelable)];
  for (const [name, dto] of planned.dtos) blocks.push(await modelDeclaration(name, dto, ctx));
  const printer = ctx.withTsTypes();
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
