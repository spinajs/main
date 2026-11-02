import { isAbstractClass } from './abstract.js';
import ts from 'typescript';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SocketCommandEntry, SocketContractEntry, SocketControllerEntry, TypeRef } from '@spinajs/manifest';
import type { Extractor, ExtractorContext } from '../context.js';
import { findDecorator, literalValue, type DecoratorInfo } from '../decorators.js';
import { policyGroupsOf } from './policies.js';
import { owningPackage } from '../owning-package.js';

type NamedMethod = ts.MethodDeclaration & { name: ts.Identifier };

function socketAccessOf(m: ts.MethodDeclaration, ctx: ExtractorContext): string[] | undefined {
  const d = findDecorator(m, 'SocketAccess');
  if (!d) return undefined;
  const v = literalValue(d.args[0], ctx);
  return Array.isArray(v) ? v.map(String) : [String(v)];
}

function payloadOf(m: NamedMethod, className: string, ctx: ExtractorContext): TypeRef {
  const p = m.parameters.find((param) => findDecorator(param, 'Payload'));
  if (!p) return { text: 'void' };
  const type = ctx.checker.getTypeAtLocation(p);
  return { ...ctx.typeRef(type, p, `${className}_${m.name.text}_Payload`), ...ctx.runtimeTypeFields(type, p) };
}

const STREAM_TYPES = new Set(['AsyncIterable', 'AsyncIterableIterator', 'AsyncGenerator']);

function streamItemOf(type: ts.Type, ctx: ExtractorContext): ts.Type | undefined {
  const isReference = type.flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference;
  if (!isReference || !STREAM_TYPES.has(type.getSymbol()?.name ?? '')) return undefined;
  return ctx.checker.getTypeArguments(type as ts.TypeReference)[0];
}

function resultOf(m: NamedMethod, className: string, ctx: ExtractorContext): Pick<SocketCommandEntry, 'result' | 'stream'> {
  const sig = ctx.checker.getSignatureFromDeclaration(m);
  if (!sig) return { result: { text: 'unknown' } };
  const returned = ctx.checker.getReturnTypeOfSignature(sig);
  const hint = `${className}_${m.name.text}_Result`;
  const item = streamItemOf(returned, ctx);
  return item ? { result: ctx.typeRef(item, m, hint), stream: true } : { result: ctx.typeRef(returned, m, hint) };
}

function commandOf(m: NamedMethod, className: string, cmd: DecoratorInfo, ctx: ExtractorContext): SocketCommandEntry {
  const access = socketAccessOf(m, ctx);
  const policies = policyGroupsOf(m, ctx, 'route');
  if (access) policies.push([{ type: 'AccessPolicy', options: ['route'] }]);
  return {
    name: (literalValue(cmd.args[0], ctx) as string | undefined) ?? m.name.text,
    handler: m.name.text,
    payload: payloadOf(m, className, ctx),
    ...resultOf(m, className, ctx),
    options: (literalValue(cmd.args[1], ctx) as SocketCommandEntry['options'] | undefined) ?? {},
    ...(access ? { access } : {}),
    policies,
    source: ctx.sourceRef(m),
  };
}

function isDefineContract(init: ts.Expression | undefined): init is ts.CallExpression {
  return !!init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'defineContract';
}

function contractIdOf(decl: ts.VariableDeclaration & { name: ts.Identifier }, call: ts.CallExpression, ctx: ExtractorContext): string {
  return (literalValue(call.arguments[0], ctx) as string | undefined) ?? `${ctx.packageName}:${decl.name.text}`;
}

/** A contract declared in a dependency is only a `.d.ts` here; its id lives in the dependency's manifest fragment, found by package and export name. */
function dependencyContractId(decl: ts.VariableDeclaration & { name: ts.Identifier }): string | undefined {
  const owner = decl.getSourceFile().isDeclarationFile ? owningPackage(decl.getSourceFile().fileName) : undefined;
  const fragment = owner?.fragment ? join(owner.root, owner.fragment) : undefined;
  if (!owner || !fragment || !existsSync(fragment)) return undefined;

  const { socketContracts = [] } = JSON.parse(readFileSync(fragment, 'utf8')) as { socketContracts?: SocketContractEntry[] };
  const exported = decl.name.text;
  return (socketContracts.find((c) => c.exportName === exported) ?? socketContracts.find((c) => c.id === `${owner.name}:${exported}`))?.id;
}

/** The id of the contract named by `@SocketController(prefix, { contract })`; its declaration must be a `defineContract` call in a source file. */
function boundContractOf(sc: DecoratorInfo, ctx: ExtractorContext): string | undefined {
  const options = sc.args[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return undefined;
  const property = options.properties.find((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText() === 'contract');
  const expr = property && (ts.isPropertyAssignment(property) ? property.initializer : (property as ts.ShorthandPropertyAssignment).name);
  if (!expr) return undefined;

  let symbol = ctx.checker.getSymbolAtLocation(expr);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = ctx.checker.getAliasedSymbol(symbol);
  const decl = symbol?.valueDeclaration;
  if (decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
    const named = decl as ts.VariableDeclaration & { name: ts.Identifier };
    if (isDefineContract(decl.initializer)) return contractIdOf(named, decl.initializer, ctx);

    const imported = dependencyContractId(named);
    if (imported) return imported;
  }
  ctx.warn(
    'SOCK004',
    `cannot resolve the contract bound to this socket controller: ${expr.getText()} is neither a defineContract() variable in this package nor exported by a dependency with a manifest fragment; give it an explicit id with defineContract('<id>') or export it from a package with a manifest fragment`,
    expr,
  );
  return undefined;
}

function diArgsOf(node: ts.ClassDeclaration, ctx: ExtractorContext): NonNullable<SocketControllerEntry['diArgs']> {
  return node.members.filter(ts.isMethodDeclaration).flatMap((m) =>
    m.parameters.flatMap((p, index) => (findDecorator(p, 'FromDI') ? [{ handler: m.name.getText(), index, ...ctx.runtimeTypeFields(ctx.checker.getTypeAtLocation(p), p) }] : [])),
  );
}

function controllerOf(node: ts.ClassDeclaration & { name: ts.Identifier }, sc: DecoratorInfo | undefined, ctx: ExtractorContext): SocketControllerEntry {
  const commands: SocketCommandEntry[] = [];
  const events: SocketControllerEntry['events'] = [];
  for (const m of node.members) {
    if (!ts.isMethodDeclaration(m) || !ts.isIdentifier(m.name)) continue;
    const named = m as NamedMethod;
    const cmd = findDecorator(m, 'Command');
    const ev = findDecorator(m, 'OnEvent');
    if (cmd) commands.push(commandOf(named, node.name.text, cmd, ctx));
    else if (ev) events.push({ name: (literalValue(ev.args[0], ctx) as string | undefined) ?? named.name.text, payload: payloadOf(named, node.name.text, ctx) });
  }
  const contract = sc && boundContractOf(sc, ctx);
  const diArgs = diArgsOf(node, ctx);
  return {
    id: `${ctx.packageName}:${node.name.text}`,
    className: node.name.text,
    prefix: (literalValue(sc?.args[0], ctx) as string | undefined) ?? '',
    ...(contract ? { contract } : {}),
    commands,
    events,
    ...(diArgs.length ? { diArgs } : {}),
    source: ctx.sourceRef(node),
  };
}

function socketControllersIn(file: ts.SourceFile, ctx: ExtractorContext, wanted: (node: ts.ClassDeclaration, sc: DecoratorInfo | undefined) => boolean): SocketControllerEntry[] {
  const out: SocketControllerEntry[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      const sc = findDecorator(node, 'SocketController');
      if (wanted(node, sc)) out.push(controllerOf(node as ts.ClassDeclaration & { name: ts.Identifier }, sc, ctx));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

export const extractSocketControllers: Extractor<SocketControllerEntry> = (ctx, file) => socketControllersIn(file, ctx, (node, sc) => !!sc && !isAbstractClass(node));

const SOCKET_HANDLER_DECORATORS = ['Command', 'OnEvent', 'OnConnect', 'OnDisconnect'];
const hasSocketHandler = (node: ts.ClassDeclaration): boolean => node.members.some((m) => ts.isMethodDeclaration(m) && SOCKET_HANDLER_DECORATORS.some((name) => findDecorator(m, name)));

/** Nothing mounts an abstract or undecorated base, but a subclass serves its handlers and looks their types up here. */
export const extractSocketControllerBases: Extractor<SocketControllerEntry> = (ctx, file) =>
  socketControllersIn(file, ctx, (node, sc) => (isAbstractClass(node) || !sc) && hasSocketHandler(node) && ctx.isSubclassOf(node, 'BaseSocketController'));

function membersOf(type: ts.Type, ctx: ExtractorContext, node: ts.Node): Map<string, ts.Type> {
  return new Map(type.getProperties().map((p) => [p.name, ctx.checker.getTypeOfSymbolAtLocation(p, node)]));
}

function refsOf(type: ts.Type | undefined, ctx: ExtractorContext, node: ts.Node, hintPrefix: string): Record<string, TypeRef> {
  const out: Record<string, TypeRef> = {};
  if (type) for (const [name, t] of membersOf(type, ctx, node)) out[name] = ctx.typeRef(t, node, `${hintPrefix}_${name}`);
  return out;
}

function contractOf(decl: ts.VariableDeclaration & { name: ts.Identifier }, shape: ts.Type, ctx: ExtractorContext): SocketContractEntry {
  const top = membersOf(shape, ctx, decl);
  const commands: SocketContractEntry['commands'] = {};
  const commandsType = top.get('commands');
  if (commandsType) {
    for (const [name, tuple] of membersOf(commandsType, ctx, decl)) {
      const [payload, result] = ctx.checker.getTypeArguments(tuple as ts.TypeReference);
      commands[name] = { payload: ctx.typeRef(payload, decl, `${decl.name.text}_${name}_Payload`), result: ctx.typeRef(result, decl, `${decl.name.text}_${name}_Result`) };
    }
  }
  return {
    id: `${ctx.packageName}:${decl.name.text}`,
    commands,
    events: refsOf(top.get('events'), ctx, decl, `${decl.name.text}_event`),
    clientEvents: refsOf(top.get('clientEvents'), ctx, decl, `${decl.name.text}_clientEvent`),
    source: ctx.sourceRef(decl),
  };
}

export const extractSocketContracts: Extractor<SocketContractEntry> = (ctx, file) => {
  const out: SocketContractEntry[] = [];
  for (const st of file.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const decl of st.declarationList.declarations) {
      const init = decl.initializer;
      const typeArg = isDefineContract(init) ? init.typeArguments?.[0] : undefined;
      if (!typeArg || !isDefineContract(init) || !ts.isIdentifier(decl.name)) continue;
      const named = decl as ts.VariableDeclaration & { name: ts.Identifier };
      const id = contractIdOf(named, init, ctx);
      // the default id already encodes the export name
      const exportName = id === `${ctx.packageName}:${named.name.text}` ? {} : { exportName: named.name.text };
      out.push({ ...contractOf(named, ctx.checker.getTypeFromTypeNode(typeArg), ctx), id, ...exportName });
    }
  }
  return out;
};
