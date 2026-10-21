import { AuthzConfigError } from '@spinajs/authz';
import { Container, Inject, Singleton } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { commandBatch } from './primitives.js';
import type { JsonSchema } from './primitives.js';

/**
 * The JSON schemas of one model's admin commands, by command kind. Each model contributes one with
 * `@Injectable(AuthzCommandSchemaSource)`; the batch body of POST /authz/commands lists every registered kind.
 */
export abstract class AuthzCommandSchemaSource {
  /** Command kind -> the JSON schema of that command, `kind` included. */
  abstract schemas(): Readonly<Record<string, object>>;
}

const q = (v: unknown): string => JSON.stringify(v);

function namesKind(schema: object, kind: string): boolean {
  const property = (schema as { properties?: { kind?: { enum?: unknown } } }).properties?.kind;
  return Array.isArray(property?.enum) && property.enum.length === 1 && property.enum[0] === kind;
}

/** The command schemas of every registered AuthzCommandSchemaSource, read on each call so a late registration counts. */
@Singleton()
@Inject(Container)
export class AuthzCommandSchemaRegistry {
  constructor(protected readonly container: IContainer) {}

  /** Command kind -> JSON schema, merged from the sources of this container and its ancestors. */
  public commands(): Readonly<Record<string, JsonSchema>> {
    const out: Record<string, JsonSchema> = {};
    const owners = new Map<string, string>();
    for (const source of this.sources()) {
      const name = source.constructor.name;
      for (const [kind, schema] of Object.entries(source.schemas())) {
        const other = owners.get(kind);
        if (other !== undefined) throw new AuthzConfigError(`Two AuthzCommandSchemaSources describe command kind ${q(kind)}: ${other} and ${name}`);
        if (!namesKind(schema, kind)) throw new AuthzConfigError(`${name}: the schema of command kind ${q(kind)} must have properties.kind.enum [${q(kind)}]`);
        owners.set(kind, name);
        out[kind] = schema as JsonSchema;
      }
    }
    return out;
  }

  /** The body of POST /authz/commands over the registered command kinds (schema AuthzAdminBatch). */
  public batch(): JsonSchema {
    return commandBatch(Object.values(this.commands()));
  }

  private sources(): AuthzCommandSchemaSource[] {
    const sources = this.container.resolve(Array.chainOf(AuthzCommandSchemaSource));
    // SchemaProvider.getSchema is synchronous, so the sources must be too.
    if (sources instanceof Promise) {
      sources.catch(() => undefined);
      throw new AuthzConfigError('An AuthzCommandSchemaSource must not be an AsyncService');
    }
    return [...sources];
  }
}
