import { RbacBound, RbacIdentifier, RbacOuterColumn } from './sql.js';
import type { RbacSql } from './sql.js';

/*
 * SQLite parses with a fixed LALR stack (YYSTACKDEPTH 100 in the builds node-sqlite3 ships) and fails a
 * statement that needs more with "parser stack overflow". This replays the parser's stack over the shapes the
 * rule blocks write (nested brackets, AND/OR/NOT, comparisons, CASE, function calls, sub-selects in an
 * expression or a FROM) and gives the most symbols it holds at once. Checked against SQLite 3.44 by wrapping
 * fragments in brackets until they overflow: the estimate is within a symbol or two of the parser's.
 */

type Sym = 'E' | 'OP' | 'NOT' | 'LP' | 'FN' | 'EXISTS' | 'CASE' | 'CO' | 'CL' | 'WHEN' | 'THEN' | 'ELSE' | 'SELECT' | 'WITH' | 'CTE' | 'X';

// parse.y precedence, low to high; prefix NOT sits between AND and the comparisons.
const PREC: Readonly<Record<string, number>> = {
  OR: 1,
  AND: 2,
  IS: 4,
  IN: 4,
  LIKE: 4,
  GLOB: 4,
  BETWEEN: 4,
  '=': 4,
  '<>': 4,
  '!=': 4,
  '<': 5,
  '<=': 5,
  '>': 5,
  '>=': 5,
  ESCAPE: 6,
  '+': 8,
  '-': 8,
  '*': 9,
  '/': 9,
  '%': 9,
  '||': 10,
};
const NOT_PREC = 3;

const TOKEN = /\s*(<=|>=|<>|!=|\|\||[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[(),.*=<>+\-/%])/y;

function tokens(fragment: RbacSql): string[] {
  const out: string[] = [];
  for (const p of fragment.parts) {
    if (p instanceof RbacIdentifier || p instanceof RbacOuterColumn || p instanceof RbacBound) {
      out.push('?');
      continue;
    }
    TOKEN.lastIndex = 0;
    for (;;) {
      const start = TOKEN.lastIndex;
      const m = TOKEN.exec(p);
      if (!m) {
        if (p.slice(start).trim() !== '') throw new Error(`authz-rbac sqlite depth: cannot read ${JSON.stringify(p.slice(start))}`);
        break;
      }
      out.push(/^[A-Za-z_]/.test(m[1]) ? m[1].toUpperCase() : m[1]);
    }
  }
  return out;
}

/** The most symbols SQLite's parser stack holds while it reads `fragment` as an expression. */
export function sqliteParserDepth(fragment: RbacSql): number {
  const t = tokens(fragment);
  const stack: { s: Sym; p?: number }[] = [];
  let max = 0;
  let betweens = 0;
  const push = (s: Sym, p?: number): void => {
    stack.push(p === undefined ? { s } : { s, p });
    if (stack.length > max) max = stack.length;
  };
  const top = (i = 0): Sym | undefined => stack[stack.length - 1 - i]?.s;
  const inWithList = (): boolean => {
    let i = stack.length - 1;
    while (i >= 0 && stack[i].s === 'X') i--;
    return i >= 0 && stack[i].s === 'WITH';
  };
  /** Reduces the operators that bind at least as tightly as `p` (left associative). */
  const reduce = (p: number): void => {
    for (;;) {
      if (top() !== 'E') return;
      const below = stack[stack.length - 2];
      if (below?.s === 'OP' && below.p! >= p && stack[stack.length - 3]?.s === 'E') stack.length -= 2;
      else if (below?.s === 'NOT' && NOT_PREC >= p) {
        stack.length -= 2;
        stack.push({ s: 'E' });
      } else return;
    }
  };
  /** Reduces down to the nearest symbol in `marks` and leaves it on top. */
  const unwind = (marks: readonly Sym[]): void => {
    reduce(0);
    while (stack.length > 0 && !marks.includes(top()!)) stack.pop();
  };
  const selectFrame = (...after: Sym[]): void => {
    unwind(['SELECT']);
    for (const s of after) push(s);
  };

  for (let i = 0; i < t.length; i++) {
    const tok = t[i];
    const next = t[i + 1];
    // `name AS (` in a WITH list: the name, its column list and AS stay below the table's select.
    if (inWithList()) {
      const materialized = t[i + 2] === 'MATERIALIZED' ? 1 : 0;
      if (/^[A-Z_?]/.test(tok) && next === 'AS' && t[i + 2 + materialized] === '(') {
        push('X');
        push('X');
        push('X');
        push('CTE');
        i += 2 + materialized;
        continue;
      }
    }
    if (tok === 'WITH') {
      push('WITH');
      continue;
    }
    if (tok === '(') {
      push('LP');
      // `name(` takes an empty `distinct` before its arguments; `(*)` is COUNT's.
      if (top(1) === 'FN') push('X');
      continue;
    }
    if (tok === ')') {
      unwind(['LP', 'CTE']);
      if (top() === 'CTE') {
        // The table reduces into the WITH list.
        while (stack.length > 0 && top() !== 'WITH') stack.pop();
        push('X');
        continue;
      }
      stack.pop();
      if (top() === 'X') stack.pop();
      if (top() === 'FN' || top() === 'EXISTS') stack.pop();
      push('E');
      continue;
    }
    if (tok === ',') {
      unwind(['LP', 'SELECT', 'WITH']);
      if (top() === 'WITH') {
        push('X');
        push('X');
        continue;
      }
      if (top() === 'LP') push('X');
      else push('X'), push('X'), push('X');
      push('X');
      continue;
    }
    if (tok === '.' || (tok === '*' && (t[i - 1] === '.' || t[i - 1] === '('))) {
      if (tok === '*' && t[i - 1] === '(') push('E');
      continue;
    }
    if (tok === 'SELECT') {
      push('SELECT');
      push('X');
      push('X');
      push('X');
      continue;
    }
    // A derived table after FROM holds one symbol more than the grammar shows (measured).
    if (tok === 'FROM') {
      selectFrame('X', 'X', 'X', 'X', 'X');
      continue;
    }
    if (tok === 'CROSS') {
      selectFrame('X', 'X', 'X', 'X');
      continue;
    }
    if (tok === 'JOIN') continue;
    if (tok === 'WHERE') {
      selectFrame('X', 'X', 'X', 'X');
      continue;
    }
    if (tok === 'AS') {
      i++;
      continue;
    }
    if (tok === 'COLLATE') {
      reduce(11);
      i++;
      continue;
    }
    if (tok === 'CASE') {
      push('CASE');
      push('CO');
      continue;
    }
    if (tok === 'WHEN' || tok === 'ELSE') {
      unwind(['CASE', 'CO', 'CL', 'THEN']);
      // `WHEN a THEN b` pairs fold into the case list.
      if (top() === 'THEN') {
        while (top() !== 'CO' && top() !== 'CL') stack.pop();
        if (top() === 'CO') push('CL');
      }
      push(tok === 'WHEN' ? 'WHEN' : 'ELSE');
      continue;
    }
    if (tok === 'THEN') {
      unwind(['WHEN']);
      push('E');
      push('THEN');
      continue;
    }
    if (tok === 'END') {
      unwind(['CASE']);
      stack.pop();
      push('E');
      continue;
    }
    if (tok === 'NOT') {
      // IS NOT, NOT IN, NOT LIKE: part of the operator.
      if (t[i - 1] === 'IS' || top() === 'E') continue;
      push('NOT');
      continue;
    }
    if (tok === 'EXISTS') {
      push('EXISTS');
      continue;
    }
    if (/^[A-Z_]/.test(tok) && next === '(' && PREC[tok] === undefined) {
      push('FN');
      continue;
    }
    if (tok === 'AND' && betweens > 0) {
      betweens--;
      reduce(PREC.BETWEEN + 1);
      push('OP', PREC.BETWEEN);
      continue;
    }
    const prec = PREC[tok];
    if (prec !== undefined && (top() === 'E' || tok !== '-')) {
      if (tok === 'BETWEEN') betweens++;
      reduce(prec);
      push('OP', prec);
      continue;
    }
    // A name, a number, NULL, a bound value, or a unary minus before a number.
    if (tok === '-') continue;
    push('E');
  }
  return max;
}
