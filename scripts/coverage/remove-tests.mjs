/**
 * Deletes the tests a minimal-tests.mjs JSON lists as removable from a package's test files, matched by
 * mocha full title ( describe titles and the test title, space-joined ). Then deletes describe blocks
 * left without a test.
 *
 * Tests a loop builds ( titles from template literals ) need --sites, the output of test-sites.cjs: the
 * line of the it() call and the loop iteration. The row is deleted from the array the loop runs over,
 * when that is one for...of over an array literal: inline, a const used nowhere else, or a parameter of
 * a helper ( table(op, rows) ), whose calls then hold the rows, the k-th call building the k-th suite.
 * A trailing spread ( ...SHARED.map(...) ) goes only when every row it adds goes. Anything else ( nested
 * loops, other spreads, shared arrays ) is reported instead.
 *
 * Usage
 * -----
 *   node scripts/coverage/remove-tests.mjs packages/util minimal.json [--sites sites.json] [--dry-run]
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import ts from 'typescript';

const [pkgDir, listPath, ...flags] = process.argv.slice(2);
const DRY = flags.includes('--dry-run');
const sites = flags.includes('--sites') ? JSON.parse(readFileSync(flags[flags.indexOf('--sites') + 1], 'utf8')) : {};
const remove = new Set(JSON.parse(readFileSync(listPath, 'utf8')).removable.map((t) => t.name));
const SUITE = new Set(['describe', 'context', 'suite']);
const TEST = new Set(['it', 'test', 'specify']);

const matched = new Set();
let removedTests = 0;
let removedSuites = 0;

for (const file of walk(join(pkgDir, 'test')).filter((f) => f.endsWith('.ts'))) {
  let text = readFileSync(file, 'utf8');
  const original = text;
  // Rows first: site lines describe the file as it ran.
  text = cutRows(text, file);
  text = cut(text, file, (call, title, stack) => TEST.has(callee(call)) && remove.has([...stack, title].join(' ')) && (matched.add([...stack, title].join(' ')), removedTests++, true));
  // Repeat: removing an empty describe can empty its parent.
  for (let before; before !== text; ) {
    before = text;
    text = cut(text, file, (call) => SUITE.has(callee(call)) && !hasTest(call) && (removedSuites++, true));
  }
  if (text !== original && !DRY) writeFileSync(file, text);
}

const unmatched = [...remove].filter((name) => !matched.has(name));
console.log(`removed ${removedTests} tests, ${removedSuites} emptied suites${DRY ? ' ( dry run )' : ''}`);
if (unmatched.length) console.log(`not found statically ( ${unmatched.length} ):\n${unmatched.map((n) => `  ${n}`).join('\n')}`);

function cutRows(text, file) {
  const rel = relative(pkgDir, file).replaceAll('\\', '/');
  const rows = new Map();
  for (const name of remove) {
    const site = !matched.has(name) && sites[name];
    if (site?.file === rel) rows.set(site.line, [...(rows.get(site.line) ?? []), { name, index: site.index }]);
  }
  if (!rows.size) return text;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // Site lines come from ts-node's compiled output ( its source maps stay in the loader thread ), but
  // compiling keeps statement order: the k-th it() line seen at run time is the k-th it() in the source.
  const calls = [];
  const collect = (node) => (ts.isCallExpression(node) && TEST.has(callee(node)) && calls.push(node), ts.forEachChild(node, collect));
  collect(source);
  const runtimeLines = [...new Set(Object.values(sites).filter((x) => x.file === rel).map((x) => x.line))].sort((a, b) => a - b);
  if (runtimeLines.length !== calls.length) {
    console.log(`  ${rel}: ${calls.length} it() calls but ${runtimeLines.length} run-time sites, rows left alone`);
    return text;
  }
  const runtimeLineOf = new Map(calls.map((call, k) => [call, runtimeLines[k]]));
  const edits = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && TEST.has(callee(node))) {
      const line = runtimeLineOf.get(node);
      const wanted = rows.get(line);
      const arrays = wanted && loopArrays(node, source);
      if (arrays) {
        // The tests this it() built, in run order, split per suite: one suite per array.
        const built = Object.entries(sites).filter(([, x]) => x.file === rel && x.line === line).sort((a, b) => a[1].index - b[1].index);
        const groups = [];
        for (const [name, x] of built) (groups.at(-1)?.suite === x.suite ? groups.at(-1) : groups[groups.push({ suite: x.suite, names: [] }) - 1]).names.push(name);
        if (arrays.length === 1 && groups.length > 1) groups.splice(0, groups.length, { names: built.map(([name]) => name) });
        // A repeated title hides a row of its suite, and every row after it would map one off.
        const ambiguous = (group) => group.names.some((name) => sites[name].ambiguous);
        groups.filter(ambiguous).forEach(() => console.log(`  ${rel}:${line}: tests of one suite share a title, its rows left alone`));
        if (groups.length === arrays.length) arrays.forEach((array, k) => !ambiguous(groups[k]) && edits.push(...dropRows(array, groups[k].names, wanted, source)));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) text = text.slice(0, start) + replacement + text.slice(end);
  return text;
}

function enclosingLoop(node) {
  let n = node.parent;
  while (n && !ts.isForOfStatement(n) && !ts.isSourceFile(n)) n = n.parent;
  return n && ts.isForOfStatement(n) ? n : undefined;
}

// The rows of one array: literal elements one to one, then at most one trailing spread whose rows go
// only all together.
function dropRows(array, names, wanted, source) {
  const spreadAt = array.elements.findIndex(ts.isSpreadElement);
  if (spreadAt !== -1 && spreadAt !== array.elements.length - 1) return [];
  const literal = spreadAt === -1 ? array.elements.length : spreadAt;
  if (names.length < literal || (spreadAt === -1 && names.length !== literal)) return [];
  const removable = new Set(wanted.map((w) => w.name));
  const drop = names.map((name) => removable.has(name));
  const spreadGoes = spreadAt !== -1 && drop.slice(literal).every(Boolean);
  const gone = new Set();
  names.forEach((name, j) => {
    if (!drop[j] || (j >= literal && !spreadGoes)) return;
    matched.add(name);
    removedTests++;
    if (j < literal) gone.add(j);
  });
  if (spreadGoes) gone.add(spreadAt);
  if (!gone.size) return [];
  // A one-line array is rewritten from what stays; a multi-line one loses whole lines.
  if (!array.getText().includes('\n')) {
    const kept = array.elements.filter((_, i) => !gone.has(i)).map((e) => e.getText());
    return [[array.getStart(), array.getEnd(), `[${kept.join(', ')}]`]];
  }
  return [...gone].map((i) => elementRange(array, i, source));
}

// The arrays a test-building loop runs over: one, or one per call of the helper the loop sits in.
function loopArrays(call, source) {
  const loop = enclosingLoop(call);
  if (!loop) return undefined;
  const param = ts.isIdentifier(loop.expression) ? parameterOf(loop, loop.expression.text) : undefined;
  if (!param) {
    const array = loopArray(call, source);
    return array && [array];
  }
  const { fn, index } = param;
  const arrays = [];
  const find = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === fn.name?.text) {
      let arg = n.arguments[index];
      while (arg && (ts.isAsExpression(arg) || ts.isParenthesizedExpression(arg))) arg = arg.expression;
      arrays.push(arg && ts.isArrayLiteralExpression(arg) ? arg : undefined);
    }
    ts.forEachChild(n, find);
  };
  find(source);
  return arrays.length && arrays.every(Boolean) ? arrays : undefined;
}

function parameterOf(node, name) {
  for (let n = node.parent; n && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isFunctionDeclaration(n)) {
      const index = n.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === name);
      return index === -1 ? undefined : { fn: n, index };
    }
  }
  return undefined;
}

// The array literal one for...of runs over, when the it() sits in exactly one loop below its describe.
function loopArray(call, source) {
  const loop = enclosingLoop(call);
  if (!loop) return undefined;
  for (let n = loop.parent; n && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isForOfStatement(n) || ts.isForStatement(n) || ts.isForInStatement(n)) return undefined;
    if (ts.isCallExpression(n) && SUITE.has(callee(n))) break;
  }
  let expr = loop.expression;
  while (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr) || ts.isSatisfiesExpression?.(expr)) expr = expr.expression;
  if (ts.isIdentifier(expr)) {
    const uses = [];
    const find = (n) => (ts.isIdentifier(n) && n.text === expr.text && uses.push(n), ts.forEachChild(n, find));
    find(source);
    const decl = uses.map((u) => u.parent).find((p) => ts.isVariableDeclaration(p) && p.name === uses.find((u) => u.parent === p));
    if (!decl || uses.length !== 2 || !(decl.parent.flags & ts.NodeFlags.Const) || !decl.initializer) return undefined;
    expr = decl.initializer;
    while (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr) || ts.isSatisfiesExpression?.(expr)) expr = expr.expression;
  }
  if (!ts.isArrayLiteralExpression(expr) || expr.elements.some(ts.isSpreadElement)) return undefined;
  return expr;
}

// The element with its leading whitespace / comments and the comma after it.
function elementRange(array, i, source) {
  const el = array.elements[i];
  const text = source.text;
  let end = el.getEnd();
  const after = /^\s*,/.exec(text.slice(end));
  if (after) end += after[0].length;
  return [el.getFullStart(), end, ''];
}

function cut(text, file, shouldCut) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const ranges = [];
  const visit = (node, stack) => {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      const title = titleOf(call);
      if (title !== undefined && shouldCut(call, title, stack)) {
        ranges.push([node.getFullStart(), node.getEnd()]);
        return;
      }
      if (title !== undefined && SUITE.has(callee(call))) {
        ts.forEachChild(node, (child) => visit(child, [...stack, title]));
        return;
      }
    }
    ts.forEachChild(node, (child) => visit(child, stack));
  };
  visit(source, []);
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) text = text.slice(0, start) + text.slice(end);
  return text;
}

// `it`, `it.only`, `describe.skip` and the like: the name before any member access.
function callee(call) {
  let e = call.expression;
  while (ts.isPropertyAccessExpression(e)) e = e.expression;
  return ts.isIdentifier(e) ? e.text : undefined;
}

function titleOf(call) {
  const arg = call.arguments[0];
  return arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) ? arg.text : undefined;
}

function hasTest(node) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isCallExpression(n) && TEST.has(callee(n))) found = true;
    else ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
