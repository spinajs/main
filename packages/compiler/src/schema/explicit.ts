import path from 'node:path';
import ts from 'typescript';
import { findDecorator, literalValue } from '../decorators.js';
import type { DeriveContext, JsonSchema } from './derive.js';

export interface ResolvedLiteral {
  value: unknown;
  /** Sub-expressions `literalValue` could not evaluate; `value` lacks whatever they contribute. */
  unresolved: ts.Node[];
}

/** `literalValue` collecting the sub-expressions it could not evaluate instead of reporting them; it follows identifiers to the initializer of their `const`. */
export function resolveLiteral(checker: ts.TypeChecker, expression: ts.Expression): ResolvedLiteral {
  const unresolved: ts.Node[] = [];
  const value = literalValue(expression, { checker, info: (_code, _message, node) => unresolved.push(node ?? expression) });
  return { value, unresolved };
}

export interface ExplicitSchema {
  schema: JsonSchema;
  id?: string;
  /** Non-empty when the `@Schema` argument was only partly evaluated: `schema` is then not the runtime schema. */
  unresolved: ts.Node[];
  /** Set when the argument is a Standard Schema whose JSON Schema cannot be read; the caller reports it as SCH004 and publishes the derived schema. */
  standardIssue?: string;
}

export function explicitSchema(ctx: DeriveContext, type: ts.Type): ExplicitSchema | undefined {
  const declaration = type.getSymbol()?.declarations?.find(ts.isClassDeclaration);
  const argument = declaration && findDecorator(declaration, 'Schema')?.args[0];
  if (!argument) return undefined;
  const vendor = standardVendor(ctx.checker, argument);
  if (vendor) return standardSchema(ctx.checker, declaration, vendor);
  const { value, unresolved } = resolveLiteral(ctx.checker, argument);
  if (typeof value === 'string') return { schema: { $ref: value }, unresolved };
  if (value && typeof value === 'object') {
    const schema = value as JsonSchema;
    return { schema, id: typeof schema.$id === 'string' ? schema.$id : undefined, unresolved };
  }
  return unresolved.length ? { schema: {}, unresolved } : undefined;
}

interface StandardVendor {
  name: string | undefined;
  /** Version of the package that declares the schema type, when it can be read. */
  version: string | undefined;
  /** zod 3.25.x ships the v4 API under `zod/v4`; that subpath is v4 whatever the package version says. */
  zodV4Subpath: boolean;
  local: boolean;
}

/** The vendor is the package declaring the `~standard` member: libraries type `vendor` as plain `string`. */
function standardVendor(checker: ts.TypeChecker, argument: ts.Expression): StandardVendor | undefined {
  const type = checker.getTypeAtLocation(argument);
  const marker = type.getProperty('~standard');
  if (!marker) return undefined;
  const file = marker.declarations?.[0]?.getSourceFile().fileName;
  const declaring = file ? declaringPackage(file) : undefined;
  const local = !declaring || declaring.dir === declaringPackage(argument.getSourceFile().fileName)?.dir;
  if (local) return { name: literalVendor(checker, marker, argument) ?? 'local', version: undefined, zodV4Subpath: false, local: true };
  const subpath = path.relative(declaring.dir, file!).split(path.sep)[0];
  return { name: declaring.name, version: declaring.version, zodV4Subpath: subpath === 'v4' || subpath === 'v4-mini', local: false };
}

function literalVendor(checker: ts.TypeChecker, marker: ts.Symbol, argument: ts.Expression): string | undefined {
  const vendor = checker.getTypeOfSymbolAtLocation(marker, argument).getProperty('vendor');
  const type = vendor && checker.getTypeOfSymbolAtLocation(vendor, argument);
  return type?.isStringLiteral() ? type.value : undefined;
}

/** The nearest named package.json above `file`; read as data, nothing in the package is loaded. */
function declaringPackage(file: string): { name: string; version?: string; dir: string } | undefined {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const text = ts.sys.readFile(path.join(dir, 'package.json'));
    const parsed = text ? (ts.parseConfigFileTextToJson('package.json', text).config as { name?: unknown; version?: unknown } | undefined) : undefined;
    if (typeof parsed?.name === 'string') return { name: parsed.name, dir, version: typeof parsed.version === 'string' ? parsed.version : undefined };
    if (path.dirname(dir) === dir) return undefined;
  }
}

function standardSchema(checker: ts.TypeChecker, declaration: ts.ClassDeclaration, vendor: StandardVendor): ExplicitSchema {
  const className = declaration.name?.text ?? 'Dto';
  const exportName = `${className}JsonSchema`;
  const label = vendor.local ? `a locally defined schema (${vendor.name})` : vendor.name ? `${vendor.name}${vendor.version ? ` ${vendor.version}` : ''}` : 'an unknown vendor';
  const derivedNote = 'the published schema is derived from the class';
  if (vendor.local || vendor.name !== 'zod' || !(vendor.zodV4Subpath || Number(vendor.version?.split('.')[0]) >= 4)) {
    return { schema: {}, unresolved: [], standardIssue: `@Schema of ${className} is a Standard Schema from ${label}, whose JSON Schema the compiler cannot read; ${derivedNote}` };
  }
  const initializer = exportedConstInitializer(declaration.getSourceFile(), exportName);
  if (!initializer) {
    return { schema: {}, unresolved: [], standardIssue: `@Schema of ${className} is a Standard Schema from ${label}; export \`const ${exportName}\` as a literal JSON Schema from the same file to publish it, otherwise ${derivedNote}` };
  }
  const { value, unresolved } = resolveLiteral(checker, initializer);
  return { schema: value && typeof value === 'object' ? (value as JsonSchema) : {}, unresolved };
}

function exportedConstInitializer(file: ts.SourceFile, name: string): ts.Expression | undefined {
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) || !statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    const found = statement.declarationList.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === name);
    if (found?.initializer) return found.initializer;
  }
  return undefined;
}
