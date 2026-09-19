import { Container, IContainer, Inject, NewInstance } from '@spinajs/di';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { DatetimeValueConverter, LiteralQuoter } from '@spinajs/orm';
import { DateTime } from 'luxon';

/**
 * The plain ANSI spelling: single quotes with embedded quotes doubled, 1 / 0 for booleans.
 * Valid sqlite as it is; the other drivers override `quoteString` / `quoteBoolean`.
 */
@NewInstance()
@Inject(Container)
export class SqlLiteralQuoter extends LiteralQuoter {
  constructor(protected container: IContainer) {
    super();
  }

  public quote(value: unknown): string {
    if (value === null || value === undefined) {
      return 'NULL';
    }

    switch (typeof value) {
      case 'number':
        if (!Number.isFinite(value)) {
          throw new InvalidArgument(`cannot write ${value} as an SQL literal`);
        }
        return String(value);
      case 'bigint':
        return value.toString();
      case 'boolean':
        return this.quoteBoolean(value);
      case 'string':
        return this.quoteString(value);
    }

    if (value instanceof Date || DateTime.isDateTime(value)) {
      return this.quoteDate(value);
    }

    throw new InvalidArgument(`cannot write a value of type ${(value as object).constructor?.name ?? typeof value} as an SQL literal`);
  }

  protected quoteString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  protected quoteBoolean(value: boolean): string {
    return value ? '1' : '0';
  }

  protected quoteDate(value: Date | DateTime): string {
    const converter = this.container.resolve<DatetimeValueConverter>(DatetimeValueConverter);
    return this.quoteString(String(converter.toDB(value, null as any, null as any)));
  }
}

const QUOTES = ["'", '"', '`'];

/**
 * Writes `bindings` into the `?` placeholders of `expression`.
 *
 * Placeholders inside quoted regions and comments are left alone. A backslash is NOT an
 * escape here and `[...]` is not quoting ( it is array syntax in postgres ).
 */
export function inlineBindings(expression: string, bindings: unknown[], quoter: LiteralQuoter): string {
  if (!bindings || bindings.length === 0) {
    return expression;
  }

  let out = '';
  let used = 0;
  let i = 0;

  while (i < expression.length) {
    const ch = expression[i];

    if (QUOTES.includes(ch)) {
      let end = i + 1;
      while (end < expression.length) {
        if (expression[end] === ch) {
          if (expression[end + 1] !== ch) {
            break;
          }
          end++;
        }
        end++;
      }
      out += expression.substring(i, end + 1);
      i = end + 1;
      continue;
    }

    if (ch === '-' && expression[i + 1] === '-') {
      const eol = expression.indexOf('\n', i);
      const end = eol === -1 ? expression.length : eol;
      out += expression.substring(i, end);
      i = end;
      continue;
    }

    if (ch === '/' && expression[i + 1] === '*') {
      const close = expression.indexOf('*/', i + 2);
      const end = close === -1 ? expression.length : close + 2;
      out += expression.substring(i, end);
      i = end;
      continue;
    }

    if (ch === '?') {
      if (used >= bindings.length) {
        throw new InvalidOperation(`expression has more placeholders than its ${bindings.length} bindings`);
      }
      out += quoter.quote(bindings[used++]);
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  if (used !== bindings.length) {
    throw new InvalidOperation(`expression has ${used} placeholders but ${bindings.length} bindings`);
  }

  return out;
}
