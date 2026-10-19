import { NotSupported } from '@spinajs/exceptions';
import { OrmException } from '@spinajs/orm';
import type { AlterColumnQueryBuilder } from '@spinajs/orm';

interface Token {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** SQL split into words, quoted names or strings, parenthesised groups and commas, with where each sits. */
function spans(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    let end = i + 1;
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      while (end < sql.length && !(sql[end] === close && sql[end + 1] !== close)) end += sql[end] === close ? 2 : 1;
      end++;
    } else if (c === '(') {
      for (let depth = 1; end < sql.length && depth > 0; end++) {
        const d = sql[end];
        if (d === "'" || d === '"' || d === '`' || d === '[') {
          const close = d === '[' ? ']' : d;
          end++;
          while (end < sql.length && sql[end] !== close) end++;
        } else if (d === '(') depth++;
        else if (d === ')') depth--;
      }
    } else if (c === ',') {
      // a separator is a token of its own
    } else {
      while (end < sql.length && !/[\s(),'"`[]/.test(sql[end])) end++;
    }
    out.push({ text: sql.slice(i, end), start: i, end });
    i = end;
  }
  return out;
}

const tokens = (sql: string): string[] => spans(sql).map((t) => t.text);

function unquote(name: string): string {
  const first = name[0];
  if (first === '"' || first === '`') return name.slice(1, -1).replaceAll(first + first, first);
  if (first === '[') return name.slice(1, -1);
  return name;
}

/** The parts of `CREATE TABLE name (body) tail`, each definition of the body as written. */
export function createTableParts(sql: string): { body: string[]; tail: string } {
  const all = spans(sql);
  const group = all.findIndex((t) => t.text.startsWith('('));
  if (group < 0) throw new OrmException(`cannot read the definition of table: ${sql}`);
  const inner = all[group].text.slice(1, -1);
  const body: string[] = [];
  let from = 0;
  for (const t of spans(inner)) {
    if (t.text === ',') {
      body.push(inner.slice(from, t.start).trim());
      from = t.end;
    }
  }
  body.push(inner.slice(from).trim());
  return { body, tail: sql.slice(all[group].end).trim() };
}

const TABLE_CONSTRAINTS = ['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN'];

/** The column a definition of the table body declares; undefined for a table constraint. */
export function definedColumn(definition: string): string | undefined {
  const first = tokens(definition)[0];
  if (!first || TABLE_CONSTRAINTS.includes(first.toUpperCase())) return undefined;
  return unquote(first);
}

const CLAUSE_STARTS = ['CONSTRAINT', 'PRIMARY', 'NOT', 'NULL', 'UNIQUE', 'CHECK', 'DEFAULT', 'COLLATE', 'REFERENCES', 'GENERATED', 'AS'];

/** Whether `words[i]` opens a column constraint clause rather than continuing one, as in `ON DELETE SET NULL`. */
function opensClause(words: string[], i: number): boolean {
  const word = words[i].toUpperCase();
  const before = words[i - 1]?.toUpperCase();
  if (!CLAUSE_STARTS.includes(word)) return false;
  if (word === 'NOT') return words[i + 1]?.toUpperCase() === 'NULL';
  if (word === 'NULL') return before !== 'NOT' && before !== 'SET' && before !== 'DEFAULT';
  if (word === 'DEFAULT') return before !== 'SET';
  if (word === 'AS') return before !== 'ALWAYS';
  return true;
}

/** Column constraint clauses of a definition as written, each with its leading `CONSTRAINT name` when it has one. */
function clauses(definition: string): { kind: string; text: string }[] {
  const all = spans(definition).slice(1);
  const words = all.map((t) => t.text);
  const out: { kind: string; start: number; end: number }[] = [];
  for (let i = 0; i < words.length; i++) {
    if (opensClause(words, i)) {
      // `CONSTRAINT name KEYWORD …` is one clause, of the keyword's kind
      const named = words[i].toUpperCase() === 'CONSTRAINT';
      out.push({ kind: (named ? words[i + 2] : words[i])?.toUpperCase() ?? '', start: all[i].start, end: all[named ? i + 2 : i]?.end ?? all[i].end });
      if (named) i += 2;
    } else if (out.length > 0) out[out.length - 1].end = all[i].end;
  }
  return out.map((c) => ({ kind: c.kind, text: definition.slice(c.start, c.end) }));
}

/**
 * The definition `column` replaces `previous` with: the new type, nullability and default, plus the constraints of
 * `previous` the builder does not restate (primary key, unique, references, check, collation), as MySQL's MODIFY
 * keeps the keys and foreign keys of a column.
 */
export function modifiedDefinition(previous: string, column: AlterColumnQueryBuilder, compiled: string): string {
  const kept: string[] = [];
  for (const { kind, text: clause } of clauses(previous)) {
    switch (kind) {
      case 'GENERATED':
      case 'AS':
        throw new NotSupported(`sqlite cannot modify generated column ${column.Name}`);
      case 'PRIMARY':
        if (!column.PrimaryKey) kept.push(clause);
        break;
      case 'UNIQUE':
        if (!column.Unique) kept.push(clause);
        break;
      case 'COLLATE':
        if (!column.Collation) kept.push(clause);
        break;
      case 'CHECK':
        if (!/\bCHECK\b/i.test(compiled)) kept.push(clause);
        break;
      case 'REFERENCES':
        kept.push(clause);
        break;
    }
  }
  return [compiled, ...kept].join(' ');
}
