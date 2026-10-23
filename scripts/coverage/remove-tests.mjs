/**
 * Deletes the tests a minimal-tests.mjs JSON lists as removable from a package's test files, matched by
 * mocha full title ( describe titles and the test title, space-joined ). Then deletes describe blocks
 * left without a test.
 *
 * Tests a loop builds ( titles from template literals ) need --sites, the output of test-sites.cjs: the
 * line of the it() call and the loop iteration. The row is deleted from the array the loop runs over,
 * when that is one for...of over an array literal ( inline, or a const used nowhere else ). Anything
 * else ( nested loops, spreads, shared arrays ) is reported instead.
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
      const array = wanted && loopArray(node, source);
      if (array) {
        const total = Object.values(sites).filter((x) => x.file === rel && x.line === line).length;
        if (total === array.elements.length) {
          const drop = new Set(wanted.map((w) => w.index));
          wanted.forEach((w) => matched.add(w.name));
          removedTests += drop.size;
          if (drop.size === array.elements.length) {
            const loop = enclosingLoop(node);
            edits.push([loop.getFullStart(), loop.getEnd(), '']);
          } else {
            array.elements.forEach((el, i) => drop.has(i) && edits.push(elementRange(array, i, source)));
          }
        }
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
