import { ConditionalCheckFailedException, CreateTableCommand, DeleteItemCommand, DeleteTableCommand, DescribeTableCommand, GetItemCommand, PutItemCommand, ResourceInUseException, ResourceNotFoundException, ScanCommand, UpdateItemCommand, UpdateTimeToLiveCommand } from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';

export type Item = Record<string, AttributeValue>;

/** DynamoDB's own error for a malformed request (unused or unknown placeholders, overlapping paths). */
export class ValidationException extends Error {
  public readonly name = 'ValidationException';
}

type Operand = { kind: 'path'; name: string } | { kind: 'value'; value: AttributeValue };
type Comparator = '=' | '<' | '<=' | '>' | '>=';
type Condition = { kind: 'or' | 'and'; left: Condition; right: Condition } | { kind: 'not'; operand: Condition } | { kind: 'exists'; name: string; negated: boolean } | { kind: 'compare'; op: Comparator; left: Operand; right: Operand };

interface Placeholders {
  names: Record<string, string>;
  values: Record<string, AttributeValue>;
  usedNames: Set<string>;
  usedValues: Set<string>;
}

const TOKEN = /\s*(<=|>=|<>|[=<>(),]|#[A-Za-z0-9_]+|:[A-Za-z0-9_]+|[A-Za-z_][A-Za-z0-9_]*)/y;

function tokenize(expression: string): string[] {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < expression.length) {
    if (/^\s*$/.test(expression.slice(TOKEN.lastIndex))) {
      break;
    }
    const at = TOKEN.lastIndex;
    const match = TOKEN.exec(expression);
    if (!match) {
      throw new ValidationException(`Invalid expression near: ${expression.slice(at)}`);
    }
    tokens.push(match[1]);
  }
  return tokens;
}

/**
 * Parses the subset of the DynamoDB expression grammar the store may use:
 * OR / AND / NOT, parentheses, the comparators = < <= > >=, and the functions
 * attribute_exists / attribute_not_exists. Attribute names must go through
 * `#placeholders` (stricter than DynamoDB, so a reserved word such as Data or
 * State can never slip in raw); anything else is refused, never ignored.
 */
class Parser {
  private at = 0;

  constructor(private readonly tokens: string[], private readonly p: Placeholders) {}

  public static condition(expression: string, p: Placeholders): Condition {
    const parser = new Parser(tokenize(expression), p);
    const condition = parser.or();
    parser.end();
    return condition;
  }

  public static update(expression: string, p: Placeholders): { set: [string, AttributeValue][]; remove: string[] } {
    const parser = new Parser(tokenize(expression), p);
    const set: [string, AttributeValue][] = [];
    const remove: string[] = [];
    while (!parser.done()) {
      const clause = parser.next().toUpperCase();
      if (clause === 'SET') {
        do {
          const name = parser.name();
          parser.expect('=');
          const value = parser.operand();
          if (value.kind !== 'value') {
            throw new ValidationException('The fake only SETs placeholders');
          }
          set.push([name, value.value]);
        } while (parser.accept(','));
      } else if (clause === 'REMOVE') {
        do {
          remove.push(parser.name());
        } while (parser.accept(','));
      } else {
        throw new ValidationException(`Unsupported update clause ${clause}`);
      }
    }
    const paths = [...set.map(([n]) => n), ...remove];
    if (new Set(paths).size !== paths.length) {
      throw new ValidationException('Two document paths overlap');
    }
    return { set, remove };
  }

  private or(): Condition {
    let left = this.and();
    while (this.acceptWord('OR')) {
      left = { kind: 'or', left, right: this.and() };
    }
    return left;
  }

  private and(): Condition {
    let left = this.not();
    while (this.acceptWord('AND')) {
      left = { kind: 'and', left, right: this.not() };
    }
    return left;
  }

  private not(): Condition {
    if (this.acceptWord('NOT')) {
      return { kind: 'not', operand: this.not() };
    }
    return this.primary();
  }

  private primary(): Condition {
    if (this.accept('(')) {
      const inner = this.or();
      this.expect(')');
      return inner;
    }
    const fn = this.peek().toLowerCase();
    if (fn === 'attribute_exists' || fn === 'attribute_not_exists') {
      this.next();
      this.expect('(');
      const name = this.name();
      this.expect(')');
      return { kind: 'exists', name, negated: fn === 'attribute_not_exists' };
    }
    const left = this.operand();
    const op = this.next();
    if (!['=', '<', '<=', '>', '>='].includes(op)) {
      throw new ValidationException(`Unsupported comparator ${op}`);
    }
    return { kind: 'compare', op: op as Comparator, left, right: this.operand() };
  }

  private operand(): Operand {
    const token = this.peek();
    if (token.startsWith(':')) {
      this.next();
      const value = this.p.values[token];
      if (!value) {
        throw new ValidationException(`An expression attribute value used in expression is not defined: ${token}`);
      }
      this.p.usedValues.add(token);
      return { kind: 'value', value };
    }
    return { kind: 'path', name: this.name() };
  }

  private name(): string {
    const token = this.next();
    if (!token.startsWith('#')) {
      throw new ValidationException(`Attribute names must be #placeholders in this fake, got ${token}`);
    }
    const name = this.p.names[token];
    if (!name) {
      throw new ValidationException(`An expression attribute name used in the document path is not defined: ${token}`);
    }
    this.p.usedNames.add(token);
    return name;
  }

  private peek(): string {
    if (this.done()) {
      throw new ValidationException('Unexpected end of expression');
    }
    return this.tokens[this.at];
  }

  private next(): string {
    const token = this.peek();
    this.at++;
    return token;
  }

  private done(): boolean {
    return this.at >= this.tokens.length;
  }

  private accept(token: string): boolean {
    if (!this.done() && this.tokens[this.at] === token) {
      this.at++;
      return true;
    }
    return false;
  }

  private acceptWord(word: string): boolean {
    if (!this.done() && this.tokens[this.at].toUpperCase() === word) {
      this.at++;
      return true;
    }
    return false;
  }

  private expect(token: string): void {
    if (!this.accept(token)) {
      throw new ValidationException(`Expected ${token}`);
    }
  }

  private end(): void {
    if (!this.done()) {
      throw new ValidationException(`Unexpected token ${this.tokens[this.at]}`);
    }
  }
}

function resolve(operand: Operand, item: Item): AttributeValue | undefined {
  return operand.kind === 'value' ? operand.value : item[operand.name];
}

/** DynamoDB compares N numerically and S by code point; a missing attribute or a type mismatch is false. */
function compare(op: Comparator, a: AttributeValue | undefined, b: AttributeValue | undefined): boolean {
  let x: number | string;
  let y: number | string;
  if (a?.N !== undefined && b?.N !== undefined) {
    x = Number(a.N);
    y = Number(b.N);
  } else if (a?.S !== undefined && b?.S !== undefined) {
    x = a.S;
    y = b.S;
  } else {
    return false;
  }
  switch (op) {
    case '=':
      return x === y;
    case '<':
      return x < y;
    case '<=':
      return x <= y;
    case '>':
      return x > y;
    case '>=':
      return x >= y;
  }
}

function evaluate(c: Condition, item: Item): boolean {
  switch (c.kind) {
    case 'or':
      return evaluate(c.left, item) || evaluate(c.right, item);
    case 'and':
      return evaluate(c.left, item) && evaluate(c.right, item);
    case 'not':
      return !evaluate(c.operand, item);
    case 'exists':
      return (item[c.name] !== undefined) !== c.negated;
    case 'compare':
      return compare(c.op, resolve(c.left, item), resolve(c.right, item));
  }
}

const copy = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

interface ExpressionInput {
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
}

function placeholders(input: ExpressionInput): Placeholders {
  return { names: input.ExpressionAttributeNames ?? {}, values: input.ExpressionAttributeValues ?? {}, usedNames: new Set(), usedValues: new Set() };
}

/** DynamoDB refuses a request that defines a placeholder its expressions do not use. */
function assertAllUsed(p: Placeholders): void {
  const names = Object.keys(p.names).filter((n) => !p.usedNames.has(n));
  const values = Object.keys(p.values).filter((v) => !p.usedValues.has(v));
  if (names.length > 0) {
    throw new ValidationException(`Value provided in ExpressionAttributeNames unused in expressions: keys: {${names.join(', ')}}`);
  }
  if (values.length > 0) {
    throw new ValidationException(`Value provided in ExpressionAttributeValues unused in expressions: keys: {${values.join(', ')}}`);
  }
}

const metadata = { $metadata: {} };

/**
 * Stateful in-memory stand-in for the AWS SDK v3 `DynamoDBClient`, for one
 * table keyed by the string hash key `SessionId`. It honours what the store's
 * correctness rests on: ConditionExpression on every write (failing with
 * ConditionalCheckFailedException), UpdateItem creating a missing item when
 * no condition stops it, FilterExpression applied after the page is read,
 * paging through LastEvaluatedKey with a small page, and ValidationException
 * for unknown or unused placeholders. Unsupported commands and grammar throw.
 */
export class FakeDynamo {
  public readonly items = new Map<string, Item>();

  public tableExists = false;

  public ttlAttribute: string | undefined;

  /** Items read per Scan page before the filter (DynamoDB stops at 1 MB). */
  public pageSize = 2;

  /** Every command input, in order. */
  public readonly sent: { command: string; input: Record<string, unknown> }[] = [];

  /** Runs around every command; tests use it to interleave a concurrent write. */
  public around: ((command: string, input: Record<string, unknown>, run: () => Promise<unknown>) => Promise<unknown>) | undefined;

  public async send(command: unknown): Promise<unknown> {
    const name = (command as { constructor: { name: string } }).constructor.name;
    const input = copy((command as { input: Record<string, unknown> }).input);
    this.sent.push({ command: name, input });
    const run = () => this.dispatch(command, input);
    return this.around ? this.around(name, input, run) : run();
  }

  public destroy(): void {}

  private async dispatch(command: unknown, input: Record<string, unknown>): Promise<unknown> {
    if (command instanceof DescribeTableCommand) {
      this.requireTable();
      return { Table: { TableName: input.TableName, TableStatus: 'ACTIVE' } };
    }
    if (command instanceof CreateTableCommand) {
      if (this.tableExists) {
        throw new ResourceInUseException({ message: `Table already exists: ${String(input.TableName)}`, ...metadata });
      }
      const keys = input.KeySchema as { AttributeName: string; KeyType: string }[];
      if (keys.length !== 1 || keys[0].AttributeName !== 'SessionId' || keys[0].KeyType !== 'HASH') {
        throw new ValidationException('The fake models a table keyed by the hash key SessionId only');
      }
      this.tableExists = true;
      return {};
    }
    if (command instanceof UpdateTimeToLiveCommand) {
      this.requireTable();
      const spec = input.TimeToLiveSpecification as { AttributeName: string; Enabled: boolean };
      this.ttlAttribute = spec.Enabled ? spec.AttributeName : undefined;
      return { TimeToLiveSpecification: spec };
    }
    if (command instanceof DeleteTableCommand) {
      this.requireTable();
      this.items.clear();
      this.tableExists = false;
      this.ttlAttribute = undefined;
      return {};
    }

    this.requireTable();

    if (command instanceof GetItemCommand) {
      this.refuseExpressions(input);
      return { Item: copy(this.items.get(this.keyOf(input.Key))) };
    }
    if (command instanceof PutItemCommand) {
      const item = input.Item as Item;
      const key = this.keyOf(item, true);
      this.check(input, this.items.get(key));
      this.items.set(key, copy(item));
      return {};
    }
    if (command instanceof DeleteItemCommand) {
      const key = this.keyOf(input.Key);
      const old = this.items.get(key);
      this.check(input, old);
      this.items.delete(key);
      return input.ReturnValues === 'ALL_OLD' ? { Attributes: copy(old) } : {};
    }
    if (command instanceof UpdateItemCommand) {
      return this.update(input);
    }
    if (command instanceof ScanCommand) {
      return this.scan(input);
    }

    throw new Error(`FakeDynamo received an unsupported command: ${(command as { constructor: { name: string } }).constructor.name}`);
  }

  private update(input: Record<string, unknown>): unknown {
    const p = placeholders(input as ExpressionInput);
    const condition = typeof input.ConditionExpression === 'string' ? Parser.condition(input.ConditionExpression, p) : undefined;
    if (typeof input.UpdateExpression !== 'string') {
      throw new ValidationException('The fake requires an UpdateExpression');
    }
    const update = Parser.update(input.UpdateExpression, p);
    assertAllUsed(p);

    const key = this.keyOf(input.Key);
    const old = this.items.get(key);
    if (condition && !evaluate(condition, old ?? {})) {
      throw new ConditionalCheckFailedException({ message: 'The conditional request failed', ...metadata });
    }
    if ([...update.set.map(([n]) => n), ...update.remove].includes('SessionId')) {
      throw new ValidationException('Cannot update attribute SessionId. This attribute is part of the key');
    }

    // Like DynamoDB, an update that no condition stops creates the item.
    const next: Item = { ...(copy(old) ?? { SessionId: { S: key } }) };
    for (const [name, value] of update.set) {
      next[name] = copy(value);
    }
    for (const name of update.remove) {
      delete next[name];
    }
    this.items.set(key, next);
    return input.ReturnValues === 'ALL_NEW' ? { Attributes: copy(next) } : {};
  }

  private scan(input: Record<string, unknown>): unknown {
    const p = placeholders(input as ExpressionInput);
    const filter = typeof input.FilterExpression === 'string' ? Parser.condition(input.FilterExpression, p) : undefined;
    const projection = typeof input.ProjectionExpression === 'string' ? input.ProjectionExpression.split(',').map((t) => t.trim()) : undefined;
    const projected = projection?.map((t) => {
      if (!t.startsWith('#') || !p.names[t]) {
        throw new ValidationException(`Projection attributes must be defined #placeholders in this fake, got ${t}`);
      }
      p.usedNames.add(t);
      return p.names[t];
    });
    assertAllUsed(p);

    const start = (input.ExclusiveStartKey as Item | undefined)?.SessionId?.S;
    const ordered = [...this.items.keys()].sort().filter((k) => start === undefined || k > start);
    const limit = typeof input.Limit === 'number' ? Math.min(input.Limit, this.pageSize) : this.pageSize;
    const page = ordered.slice(0, limit);
    const matched = page.map((k) => this.items.get(k)!).filter((item) => !filter || evaluate(filter, item));
    const items = matched.map((item) => (projected ? Object.fromEntries(projected.filter((n) => item[n] !== undefined).map((n) => [n, item[n]])) : item));

    return {
      Items: copy(items),
      Count: items.length,
      ScannedCount: page.length,
      ...(ordered.length > page.length ? { LastEvaluatedKey: { SessionId: { S: page[page.length - 1] } } } : {}),
    };
  }

  private check(input: Record<string, unknown>, old: Item | undefined): void {
    const p = placeholders(input as ExpressionInput);
    const condition = typeof input.ConditionExpression === 'string' ? Parser.condition(input.ConditionExpression, p) : undefined;
    assertAllUsed(p);
    if (condition && !evaluate(condition, old ?? {})) {
      throw new ConditionalCheckFailedException({ message: 'The conditional request failed', ...metadata });
    }
  }

  private refuseExpressions(input: Record<string, unknown>): void {
    if (input.ProjectionExpression !== undefined || input.ExpressionAttributeNames !== undefined) {
      throw new ValidationException('The fake does not project GetItem');
    }
  }

  /** `key` is a Key (exactly the hash key) or, for PutItem, a whole item. */
  private keyOf(key: unknown, wholeItem = false): string {
    const attributes = (key ?? {}) as Item;
    const id = attributes.SessionId?.S;
    if (typeof id !== 'string' || id.length === 0 || (!wholeItem && Object.keys(attributes).length !== 1)) {
      throw new ValidationException('The provided key element does not match the schema');
    }
    return id;
  }

  private requireTable(): void {
    if (!this.tableExists) {
      throw new ResourceNotFoundException({ message: 'Requested resource not found', ...metadata });
    }
  }
}
