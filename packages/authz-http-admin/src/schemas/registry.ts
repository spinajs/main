import { Container, Inject, Singleton } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import type { JsonSchema } from './primitives.js';

/**
 * The JSON schemas of one model's admin commands, by command kind. Each model contributes one with
 * `@Injectable(AuthzCommandSchemaSource)`; the batch body of POST /authz/commands lists every registered kind.
 */
export abstract class AuthzCommandSchemaSource {
  /** Command kind -> the JSON schema of that command, `kind` included. */
  abstract schemas(): Readonly<Record<string, object>>;
}

/** The command schemas of every registered AuthzCommandSchemaSource. */
@Singleton()
@Inject(Container)
export class AuthzCommandSchemaRegistry {
  constructor(protected readonly container: IContainer) {}

  /** Command kind -> JSON schema, merged from the sources of this container and its ancestors. */
  public commands(): Readonly<Record<string, JsonSchema>> {
    throw new Error('not implemented: AuthzCommandSchemaRegistry.commands');
  }

  /** The body of POST /authz/commands over the registered command kinds (schema AuthzAdminBatch). */
  public batch(): JsonSchema {
    throw new Error('not implemented: AuthzCommandSchemaRegistry.batch');
  }
}
