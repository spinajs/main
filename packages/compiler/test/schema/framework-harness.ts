import type { ControllerEntry, Diagnostic, ModelEntry } from '@spinajs/manifest';
import ts from 'typescript';
import { createContext, createProgramFromTsconfig, extractControllers, extractModels, type ExtractorContext } from '../../src/index.js';

let shared: { loaded: ReturnType<typeof createProgramFromTsconfig>; ctx: ExtractorContext } | undefined;

function context(): NonNullable<typeof shared> {
  if (!shared) {
    const loaded = createProgramFromTsconfig('test/fixtures/schema-framework/tsconfig.json');
    shared = { loaded, ctx: createContext(loaded, 'fw', 'test/fixtures/schema-framework') };
  }
  return shared;
}

/** Extracts the controller of `src/<name>.ts` and returns the SCH diagnostics that extraction produced. */
export function extract(name: string): { controller: ControllerEntry; diagnostics: Diagnostic[] } {
  const { loaded, ctx } = context();
  const file = loaded.sourceFiles.find((f) => f.fileName.endsWith(`/${name}.ts`))!;
  const before = ctx.diagnostics.length;
  const [controller] = extractControllers(ctx, file);
  return { controller, diagnostics: ctx.diagnostics.slice(before).filter((d) => d.code.startsWith('SCH')) };
}

/** The manifest `models` entries of `src/<name>.ts`. */
export function extractModelsOf(name: string): ModelEntry[] {
  const { loaded, ctx } = context();
  return extractModels(ctx, loaded.sourceFiles.find((f) => f.fileName.endsWith(`/${name}.ts`))!);
}

export const registered = (name: string): unknown => context().ctx.schemaRegistry.get(`spinajs/fw/${name}`);
export const registeredIds = (): string[] => [...context().ctx.schemaRegistry.keys()];
/** Every registered schema, serialized, for assertions about what is published anywhere. */
export const published = (): string => JSON.stringify([...context().ctx.schemaRegistry.values()]);

/** The properties of the type alias `alias` declared in `src/<name>.ts`, as the checker resolves them for derivation. */
export function aliasProperties(name: string, alias: string): ts.Symbol[] {
  const { loaded } = context();
  const file = loaded.sourceFiles.find((f) => f.fileName.endsWith(`/${name}.ts`))!;
  const declaration = file.statements.find((s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === alias)!;
  return loaded.checker.getPropertiesOfType(loaded.checker.getTypeAtLocation(declaration.name));
}
