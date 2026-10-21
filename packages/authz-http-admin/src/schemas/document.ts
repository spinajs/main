import { CONTROLLED_DESCRIPTOR_SYMBOL } from '@spinajs/http';
import type { IControllerDescriptor, IRouteParameter } from '@spinajs/http';
import { SCHEMA_SYMBOL } from '@spinajs/validation';

import { AuthzAdminController } from '../controllers/AuthzAdminController.js';
import { AuthzAdminBatch } from './commands.js';
import type { JsonSchema } from './primitives.js';
import { AUTHZ_ADMIN_SCHEMAS } from './provider.js';

interface Parameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
}

interface Operation {
  parameters?: Parameter[];
  requestBody?: unknown;
}

interface Document {
  paths?: Record<string, Record<string, Operation | undefined>>;
  components?: { schemas?: Record<string, unknown> };
}

interface ObjectSchema extends JsonSchema {
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
}

/** The answers and the batch body over the built-in command kinds. */
const DEFAULT_SCHEMAS: Readonly<Record<string, JsonSchema>> = { ...AUTHZ_ADMIN_SCHEMAS, AuthzAdminBatch };

function schemaOf(param: IRouteParameter): ObjectSchema | undefined {
  const type = param.RuntimeType as { prototype?: object } | undefined;
  return type?.prototype ? (Reflect.getMetadata(SCHEMA_SYMBOL, type.prototype) as ObjectSchema | undefined) : undefined;
}

const jsonBody = (schema: JsonSchema): unknown => ({ required: true, content: { 'application/json': { schema } } });

/** The request body or the query parameters a custom route arg of the controller takes, which http-swagger does not know. */
function describeArg(operation: Operation, param: IRouteParameter): void {
  const schema = schemaOf(param);
  if (param.Type === 'AuthzAdminBatchArg') {
    operation.requestBody = jsonBody({ $ref: '#/components/schemas/AuthzAdminBatch' });
  } else if (param.Type === 'AuthzAdminBodyArg' && schema) {
    const { $id: _id, ...documented } = schema;
    operation.requestBody = jsonBody(documented);
  } else if (param.Type === 'AuthzAdminQueryArg' && schema) {
    const parameters = (operation.parameters ??= []);
    const required = schema.required ?? [];
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      if (parameters.some((p) => p.in === 'query' && p.name === name)) continue;
      const { description, ...value } = property;
      parameters.push({ name, in: 'query', required: required.includes(name), schema: value, ...(typeof description === 'string' ? { description } : {}) });
    }
  }
}

/**
 * http-swagger documents the `@Body()` DTOs and the `@Param()` schemas of the admin routes itself.
 * This adds what it cannot see, read from the same DTOs and registry the routes validate against:
 * the body of POST /authz/commands (`$ref` AuthzAdminBatch, built from the registered
 * AuthzCommandSchemaSources), the attribute bodies (`@AdminBody()`), the query parameters of each
 * query DTO (`@AdminQuery()`) and the path parameter text. Operations are matched by method and path
 * suffix, so a route prefix does not matter; `basePath` is the configured `authz.http.admin.basePath`
 * when the app moved the routes. Changes the document in place. Pass `AuthzAdminSchemaProvider.schemas()`
 * as `schemas` to list the commands every registered model contributes.
 */
export function describeAuthzAdminDocument<T extends object>(doc: T, basePath = 'authz', schemas: Readonly<Record<string, JsonSchema>> = DEFAULT_SCHEMAS): T {
  const document = doc as Document;
  const components = ((document.components ??= {}).schemas ??= {});
  for (const [name, schema] of Object.entries(schemas)) components[name] ??= schema;

  const base = basePath.replace(/^\/+|\/+$/g, '');
  const paths = document.paths ?? {};
  const descriptor = Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, AuthzAdminController.prototype) as IControllerDescriptor;
  for (const route of descriptor.Routes.values()) {
    const routePath = `/${base}/${(route.Path ?? '').replace(/:(\w+)/g, '{$1}')}`;
    const path = Object.keys(paths).find((p) => p === routePath || p.endsWith(routePath));
    const operation = path ? paths[path][route.Type] : undefined;
    if (!operation) continue;

    for (const param of route.Parameters.values()) describeArg(operation, param);
    for (const p of operation.parameters ?? []) if (p.in === 'path' && !p.description && typeof p.schema?.description === 'string') p.description = p.schema.description;
  }
  return doc;
}
