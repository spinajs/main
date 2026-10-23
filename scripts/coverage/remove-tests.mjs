/**
 * Deletes the tests a minimal-tests.mjs JSON lists as removable from a package's test files, matched by
 * mocha full title ( describe titles and the test title, space-joined ). Then deletes describe blocks
 * left without a test. Titles built at run time ( template literals with substitutions, loops ) cannot
 * be matched statically and are reported instead.
 *
 * Usage
 * -----
 *   node scripts/coverage/remove-tests.mjs packages/util minimal.json [--dry-run]
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';

const [pkgDir, listPath, ...flags] = process.argv.slice(2);
const DRY = flags.includes('--dry-run');
const remove = new Set(JSON.parse(readFileSync(listPath, 'utf8')).removable.map((t) => t.name));
const SUITE = new Set(['describe', 'context', 'suite']);
const TEST = new Set(['it', 'test', 'specify']);

const matched = new Set();
let removedTests = 0;
let removedSuites = 0;

for (const file of walk(join(pkgDir, 'test')).filter((f) => f.endsWith('.ts'))) {
  let text = readFileSync(file, 'utf8');
  const original = text;
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
