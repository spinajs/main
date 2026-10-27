import ts from 'typescript';
import type { SocketCommandEntry, SocketContractEntry, SocketControllerEntry, TypeRef } from '@spinajs/manifest';
import type { Extractor, ExtractorContext } from '../context.js';
import { findDecorator, literalValue, type DecoratorInfo } from '../decorators.js';
import { policyGroupsOf } from './policies.js';

type NamedMethod = ts.MethodDeclaration & { name: ts.Identifier };

function socketAccessOf(m: ts.MethodDeclaration, ctx: ExtractorContext): string[] | undefined {
  const d = findDecorator(m, 'SocketAccess');
  if (!d) return undefined;
  const v = literalValue(d.args[0], ctx);
  return Array.isArray(v) ? v.map(String) : [String(v)];
}

function payloadOf(m: NamedMethod, className: string, ctx: ExtractorContext): TypeRef {
  const p = m.parameters.find((param) => findDecorator(param, 'Payload'));
  return p ? ctx.typeRef(ctx.checker.getTypeAtLocation(p), p, `${className}_${m.name.text}_Payload`) : { text: 'void' };
}

function commandOf(m: NamedMethod, className: string, cmd: DecoratorInfo, ctx: ExtractorContext): SocketCommandEntry {
  const sig = ctx.checker.getSignatureFromDeclaration(m);
  const access = socketAccessOf(m, ctx);
  const policies = policyGroupsOf(m, ctx, 'route');
  if (access) policies.push([{ type: 'AccessPolicy', options: ['route'] }]);
  return {
    name: (literalValue(cmd.args[0], ctx) as string | undefined) ?? m.name.text,
    handler: m.name.text,
    payload: payloadOf(m, className, ctx),
    result: sig ? ctx.typeRef(ctx.checker.getReturnTypeOfSignature(sig), m, `${className}_${m.name.text}_Result`) : { text: 'unknown' },
    options: (literalValue(cmd.args[1], ctx) as SocketCommandEntry['options'] | undefined) ?? {},
    ...(access ? { access } : {}),
    policies,
    source: ctx.sourceRef(m),
  };
}

function controllerOf(node: ts.ClassDeclaration & { name: ts.Identifier }, sc: DecoratorInfo, ctx: ExtractorContext): SocketControllerEntry {
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
  return {
    id: `${ctx.packageName}:${node.name.text}`,
    className: node.name.text,
    prefix: (literalValue(sc.args[0], ctx) as string | undefined) ?? '',
    commands,
    events,
    source: ctx.sourceRef(node),
  };
}

export const extractSocketControllers: Extractor<SocketControllerEntry> = (ctx, file) => {
  const out: SocketControllerEntry[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      const sc = findDecorator(node, 'SocketController');
      if (sc) out.push(controllerOf(node as ts.ClassDeclaration & { name: ts.Identifier }, sc, ctx));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
};

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
      const typeArg = init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'defineContract' ? init.typeArguments?.[0] : undefined;
      if (!typeArg || !ts.isIdentifier(decl.name)) continue;
      out.push(contractOf(decl as ts.VariableDeclaration & { name: ts.Identifier }, ctx.checker.getTypeFromTypeNode(typeArg), ctx));
    }
  }
  return out;
};
