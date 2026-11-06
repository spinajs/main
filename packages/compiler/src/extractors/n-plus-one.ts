import ts from 'typescript';
import type { ExtractorContext } from '../context.js';
import { iterationCallback, iterations, type Iteration } from '../flow/iteration.js';
import { chainOf, QueryTracer, unwrap, type QueryValue } from '../flow/query-values.js';
import { isModelType, isRelationType, ORM } from '../model-members.js';
import { extendsFrameworkClass, isDeclaredIn } from '../schema/framework-members.js';

type Code = 'ORM101' | 'ORM102';
type Report = (code: Code, message: string, node: ts.Node, loop: ts.Node) => void;

const IGNORE = /^\/\/\s*spinajs-orm-ignore\s+(ORM10[12])\s*:(.*)$/;
const NOT_READS = new Set(['insert', 'update', 'destroy', 'create', 'truncate', 'transaction']);
const SELECT_BUILDERS = new Set(['ISelectQueryBuilder', 'SelectQueryBuilder']);
// Members of Relation/SingleRelation that need no populate: the loader, its flag, and the mutators (relation-objects.ts:186-305, 338-377, 426).
const GUARD_MEMBERS = new Set(['populate', 'Populated', 'add', 'set', 'remove', 'attach', 'detach', 'union', 'intersection', 'diff', 'empty', 'clear', 'sync']);
const LOOP_QUERY = 'N+1: a query is awaited inside a loop; load the rows once before the loop ( whereIn, populate ) or batch them';

const strictness = new WeakMap<ts.Program, boolean>();

const isRegistry = (s: ts.Statement): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === 'OrmTypeRegistry';

/** `OrmTypeRegistry` as `@spinajs/orm` declares it, and every `declare module '@spinajs/orm'` that augments it. */
function registryDeclarations(file: ts.SourceFile): ts.InterfaceDeclaration[] {
  const out = file.statements.filter(isRegistry).filter((s) => isDeclaredIn(s, ORM));
  for (const s of file.statements) {
    if (ts.isModuleDeclaration(s) && s.name.text === ORM && s.body && ts.isModuleBlock(s.body)) out.push(...s.body.statements.filter(isRegistry));
  }
  return out;
}

function declaresStrict(checker: ts.TypeChecker, declaration: ts.InterfaceDeclaration): boolean {
  const symbol = checker.getSymbolAtLocation(declaration.name);
  const property = symbol && checker.getPropertyOfType(checker.getDeclaredTypeOfSymbol(symbol), 'strictColumns');
  return !!property && checker.typeToString(checker.getTypeOfSymbol(property)) === 'true';
}

/** D2's opt-in: the merged `OrmTypeRegistry` of the package's program has `strictColumns: true`. */
export function isStrictOrm(program: ts.Program, checker: ts.TypeChecker): boolean {
  let strict = strictness.get(program);
  if (strict === undefined) {
    strict = program.getSourceFiles().some((file) => registryDeclarations(file).some((d) => declaresStrict(checker, d)));
    strictness.set(program, strict);
  }
  return strict;
}

function statementOf(node: ts.Node): ts.Node {
  let current = node;
  while (current.parent && !ts.isBlock(current.parent) && !ts.isSourceFile(current.parent) && !ts.isModuleBlock(current.parent) && !ts.isCaseOrDefaultClause(current.parent)) {
    current = current.parent;
  }
  return current;
}

/** `// spinajs-orm-ignore ORM10x: <reason>` right above the statement that holds the loop; without a reason it does not count. */
function isIgnored(loop: ts.Node, code: Code): boolean {
  const statement = statementOf(loop);
  const text = statement.getSourceFile().text;
  return (ts.getLeadingCommentRanges(text, statement.getFullStart()) ?? []).some((range) => {
    const match = IGNORE.exec(text.slice(range.pos, range.end).trim());
    return !!match && match[1] === code && match[2].trim().length > 0;
  });
}

function relationMember(checker: ts.TypeChecker, owner: ts.Type, name: string): boolean {
  if (!isModelType(checker, owner)) return false;
  const property = owner.getProperty(name);
  return !!property && isRelationType(checker, checker.getNonNullableType(checker.getTypeOfSymbol(property)));
}

/** `node` widened past the `!` and parentheses around it. */
function outer(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isNonNullExpression(current.parent) || ts.isParenthesizedExpression(current.parent)) current = current.parent;
  return current;
}

function isAssigned(access: ts.Expression): boolean {
  const parent = access.parent;
  return ts.isBinaryExpression(parent) && parent.left === access && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
}

/** The relation path `item.a.Value.b…` walks, with each access, up to the first member that is not a relation. */
function relationPath(checker: ts.TypeChecker, item: ts.Identifier): Array<{ path: string; node: ts.PropertyAccessExpression; current: ts.Expression }> {
  const out: Array<{ path: string; node: ts.PropertyAccessExpression; current: ts.Expression }> = [];
  const path: string[] = [];
  let current: ts.Expression = outer(item);
  while (ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current) {
    const access = current.parent;
    const owner = checker.getNonNullableType(checker.getTypeAtLocation(current));
    current = outer(access);
    if (access.name.text === 'Value' && extendsFrameworkClass(checker, owner, 'SingleRelation', ORM)) continue;
    if (!relationMember(checker, owner, access.name.text)) break;
    path.push(access.name.text);
    out.push({ path: path.join('.'), node: access, current });
  }
  return out;
}

/** The first relation along `item.a.Value.b…` that neither the query nor an earlier `populate()` in the body loaded, with the access that reads it. */
function unpopulatedRead(checker: ts.TypeChecker, item: ts.Identifier, populated: Set<string>, populatedBefore: Array<{ path: string; end: number }>): { path: string; node: ts.PropertyAccessExpression } | undefined {
  for (const { path, node, current } of relationPath(checker, item)) {
    const next = current.parent;
    if (isAssigned(current) || (ts.isPropertyAccessExpression(next) && GUARD_MEMBERS.has(next.name.text))) return undefined;
    if (populated.has(path) || populatedBefore.some((p) => p.path === path && p.end <= node.getStart())) continue;
    return { path, node };
  }
  return undefined;
}

/** `item.a.populate(…)` calls in the body: each one loads `a` for the reads that follow it (the call itself is an ORM102). */
function populatesIn(checker: ts.TypeChecker, iteration: Iteration): Array<{ path: string; end: number }> {
  const out: Array<{ path: string; end: number }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === iteration.item) {
      const steps = relationPath(checker, node);
      const last = steps[steps.length - 1];
      const next = last?.current.parent;
      if (last && next && ts.isPropertyAccessExpression(next) && next.name.text === 'populate' && ts.isCallExpression(next.parent)) out.push({ path: last.path, end: next.parent.getEnd() });
    }
    ts.forEachChild(node, visit);
  };
  visit(iteration.body);
  return out;
}

function readsIn(checker: ts.TypeChecker, iteration: Iteration, value: QueryValue, report: Report): void {
  const reported = new Set<string>();
  const populatedBefore = populatesIn(checker, iteration);
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === iteration.item) {
      const read = unpopulatedRead(checker, node, value.populated, populatedBefore);
      if (read && !reported.has(read.path)) {
        reported.add(read.path);
        report('ORM101', `relation ${value.model}.${read.path} is read but never populated; add .populate('${read.path}')`, read.node, iteration.loop);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(iteration.body);
}

function checkRelationReads(checker: ts.TypeChecker, tracer: QueryTracer, body: ts.Node, report: Report): void {
  const matches = (source: ts.Expression): boolean => {
    const traced = tracer.traced(source);
    if (!traced) return false;
    const calls = chainOf(source)?.calls ?? [];
    return traced.pending ? calls[calls.length - 1]?.name === 'stream' : traced.value.shape === 'many';
  };
  for (const iteration of iterations(body, checker, matches)) {
    const value = tracer.traced(iteration.source)?.value;
    if (value && iteration.item) readsIn(checker, iteration, value, report);
  }
}

function isSelectBuilder(type: ts.Type): boolean {
  const parts = type.isUnionOrIntersection() ? type.types : [type];
  return parts.some((part) => {
    const symbol = part.getSymbol();
    return !!symbol && SELECT_BUILDERS.has(symbol.name) && isDeclaredIn(symbol.declarations?.[0], ORM);
  });
}

/** A read: a model query that is not a write, a select builder, or `relation.populate()`. */
function isQuery(checker: ts.TypeChecker, tracer: QueryTracer, operand: ts.Expression): boolean {
  const chain = chainOf(operand);
  const last = chain?.calls[chain.calls.length - 1];
  if (chain && last?.name === 'populate' && isRelationType(checker, checker.getNonNullableType(checker.getTypeAtLocation(chain.root)))) return true;
  if (tracer.traced(operand)?.pending) return !chain?.calls.some((c) => NOT_READS.has(c.name));
  return isSelectBuilder(checker.getTypeAtLocation(operand));
}

const isLoop = (node: ts.Node): node is ts.IterationStatement =>
  ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node);

function isArrayValue(checker: ts.TypeChecker, expr: ts.Expression): boolean {
  const type = checker.getNonNullableType(checker.getTypeAtLocation(expr));
  return checker.isArrayType(type) || checker.isTupleType(type);
}

/** The loop that runs `node` once per element, searched up to `root`; a function boundary ends the search unless it is a per-element callback. */
function enclosingLoop(checker: ts.TypeChecker, node: ts.Node, root: ts.Node): ts.Node | undefined {
  let child = node;
  for (let parent = node.parent; parent && child !== root; child = parent, parent = parent.parent) {
    if (isLoop(parent) && parent.statement === child) return parent;
    if (ts.isFunctionLike(child)) {
      const found = ts.isCallExpression(parent) ? iterationCallback(parent) : undefined;
      return found?.callback === child && isArrayValue(checker, found.method.expression) ? parent : undefined;
    }
  }
  return undefined;
}

/** `async (x) => User.get(x)`: the returned query runs once per element as surely as an awaited one. */
function returnedByAsyncArrow(node: ts.Node): ts.Expression | undefined {
  if (!ts.isArrowFunction(node) || ts.isBlock(node.body)) return undefined;
  return node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ? node.body : undefined;
}

function checkLoopQueries(checker: ts.TypeChecker, tracer: QueryTracer, body: ts.Node, report: Report): void {
  const visit = (node: ts.Node): void => {
    const operand = ts.isAwaitExpression(node) ? node.expression : returnedByAsyncArrow(node);
    if (operand && isQuery(checker, tracer, unwrap(operand))) {
      const loop = enclosingLoop(checker, node, body);
      if (loop) report('ORM102', LOOP_QUERY, ts.isAwaitExpression(node) ? node : operand, loop);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
}

function analyzeBody(ctx: ExtractorContext, body: ts.Node, strict: boolean): void {
  const tracer = new QueryTracer(ctx.checker).run(body);
  const report: Report = (code, message, node, loop) => {
    if (isIgnored(loop, code)) return;
    if (strict) ctx.error(code, message, node);
    else ctx.warn(code, message, node);
  };
  checkRelationReads(ctx.checker, tracer, body, report);
  checkLoopQueries(ctx.checker, tracer, body, report);
}

function functionBody(node: ts.Node): ts.Node | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return node.body;
  }
  return undefined;
}

/** ORM101 and ORM102 over every outermost function body of `file`; a callback is analysed with the body that holds it. */
export function checkNPlusOne(ctx: ExtractorContext, file: ts.SourceFile): void {
  const strict = isStrictOrm(ctx.program, ctx.checker);
  const visit = (node: ts.Node): void => {
    const body = functionBody(node);
    if (body) analyzeBody(ctx, body, strict);
    else ts.forEachChild(node, visit);
  };
  visit(file);
}
