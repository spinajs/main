import ts from 'typescript';
import type { WorkflowEntry } from '@spinajs/manifest';
import type { Extractor, ExtractorContext } from '../context.js';
import { findDecorator, literalValue } from '../decorators.js';
import { isAbstractClass } from './abstract.js';
import { stringArg } from './string-arg.js';

/** The signal name recorded for a `waitForEvent` whose name is not a literal. */
export const DYNAMIC_SIGNAL = '*';

/** Callbacks of these context calls run inside a journaled step, where wall-clock reads are fine. */
const STEP_CALLS = new Set(['step', 'emit']);

const REPLACEMENT: Record<string, string> = { 'Date.now': 'ctx.now()', 'new Date': 'ctx.now()', 'Math.random': 'ctx.random()' };

type Signal = WorkflowEntry['signals'][number];

const methodName = (node: ts.Node): string | undefined =>
  ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : undefined;

function wallClock(node: ts.Node): string | undefined {
  if (ts.isCallExpression(node)) {
    const text = node.expression.getText();
    if (text === 'Date.now' || text === 'Math.random') return text;
  }
  if (ts.isNewExpression(node) && node.expression.getText() === 'Date' && (node.arguments?.length ?? 0) === 0) return 'new Date';
  return undefined;
}

function permissionOf(arg: ts.Expression | undefined): string | undefined {
  if (!arg || !ts.isObjectLiteralExpression(arg)) return undefined;
  for (const p of arg.properties) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'permission' && ts.isStringLiteralLike(p.initializer)) return p.initializer.text;
  }
  return undefined;
}

/** The signal a `waitForEvent` call waits for; `undefined` (after WF005) for a literal name the runtime refuses. */
function signalOf(call: ts.CallExpression, ctx: ExtractorContext, className: string): Signal | undefined {
  const [nameArg, optsArg] = call.arguments;
  if (!nameArg || !ts.isStringLiteralLike(nameArg)) return { name: DYNAMIC_SIGNAL };
  const name = nameArg.text;
  // '*' marks a park on several names and '#' ends the name in a wait key (workflow's eventNameProblem).
  if (/[#*]/.test(name)) {
    ctx.warn('WF005', `${className}.run waits for event ${JSON.stringify(name)}, which waitForEvent refuses: event names cannot contain '#' or '*'`, call);
    return undefined;
  }
  const permission = permissionOf(optsArg);
  return permission ? { name, permission } : { name };
}

/** The signals `run()` waits for, and WF004 for values a replay would not see again. */
function walkRun(body: ts.Block, ctx: ExtractorContext, className: string): Signal[] {
  const signals: Signal[] = [];
  const seen = new Set<string>();
  const add = (signal: Signal | undefined): void => {
    const key = signal && `${signal.name}\u0000${signal.permission ?? ''}`;
    if (!signal || key === undefined || seen.has(key)) return;
    seen.add(key);
    signals.push(signal);
  };
  const visit = (node: ts.Node): void => {
    const method = methodName(node);
    if (method !== undefined && STEP_CALLS.has(method)) return;
    if (method === 'waitForEvent') add(signalOf(node as ts.CallExpression, ctx, className));
    const clock = wallClock(node);
    if (clock) ctx.warn('WF004', `${className}.run calls ${clock}() outside a step; use ${REPLACEMENT[clock]} so a replay sees the same value`, node);
    ts.forEachChild(node, visit);
  };
  visit(body);
  return signals;
}

export const extractWorkflows: Extractor<WorkflowEntry> = (ctx, file) => {
  const out: WorkflowEntry[] = [];
  for (const st of file.statements) {
    if (!ts.isClassDeclaration(st) || !st.name || isAbstractClass(st)) continue;
    const d = findDecorator(st, 'Workflow');
    if (!d) continue;
    const options = (literalValue(d.args[1], ctx) ?? {}) as { version?: unknown };
    const run = st.members.find((m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === 'run');
    out.push({
      name: stringArg(d.args[0], ctx, st.name.text),
      version: typeof options.version === 'number' ? options.version : 1,
      className: st.name.text,
      signals: run?.body ? walkRun(run.body, ctx, st.name.text) : [],
      source: ctx.sourceRef(st),
    });
  }
  return out;
};
