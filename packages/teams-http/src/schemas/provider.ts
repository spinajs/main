import { Injectable } from '@spinajs/di';
import { SchemaProvider } from '@spinajs/validation';

import * as responses from './responses.js';
import type { JsonSchema } from './responses.js';

/** Every answer schema by the name the controllers' `@response` tags use. */
export const TEAMS_HTTP_SCHEMAS: Readonly<Record<string, JsonSchema>> = Object.freeze(Object.fromEntries(Object.entries(responses).filter(([name]) => name.startsWith('Teams')) as [string, JsonSchema][]));

/** Serves the answer schemas to http-swagger; request bodies are `@Schema` classes and need no provider. */
@Injectable(SchemaProvider)
export class TeamsHttpSchemaProvider extends SchemaProvider {
  public getSchema(typeName: string): Record<string, unknown> | undefined {
    return Object.hasOwn(TEAMS_HTTP_SCHEMAS, typeName) ? TEAMS_HTTP_SCHEMAS[typeName] : undefined;
  }
}
