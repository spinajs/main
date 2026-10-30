import type { Manifest } from '@spinajs/manifest';
import type { OpenAPIV3_1 } from 'openapi-types';
import { createComponentRegistry } from './components.js';
import { buildPaths } from './paths.js';

export interface OpenApiOptions {
  title: string;
  version: string;
  servers?: { url: string; description?: string }[];
  securitySchemes?: Record<string, unknown>;
  /** `$id` of the problem+json schema; default 'spinajs/http/ProblemDetails'. */
  errorSchemaId?: string;
  /**
   * Body of the problem+json schema, used when `manifest.schemas` does not hold `errorSchemaId`.
   * The generator does not import `@spinajs/http`; pass its `PROBLEM_DETAILS_SCHEMA` here.
   */
  errorSchema?: unknown;
  /** Prepended to every path, e.g. the runtime route prefix. */
  basePath?: string;
}

const DEFAULT_ERROR_SCHEMA_ID = 'spinajs/http/ProblemDetails';

function schemasWithError(manifest: Manifest, errorSchemaId: string, errorSchema: unknown): Record<string, unknown> {
  if (errorSchemaId in manifest.schemas || errorSchema === undefined) return manifest.schemas;
  return { ...manifest.schemas, [errorSchemaId]: errorSchema };
}

export function manifestToOpenApi(manifest: Manifest, options: OpenApiOptions): OpenAPIV3_1.Document {
  const errorSchemaId = options.errorSchemaId ?? DEFAULT_ERROR_SCHEMA_ID;
  const registry = createComponentRegistry(schemasWithError(manifest, errorSchemaId, options.errorSchema));
  const paths = buildPaths(manifest, registry, { errorSchemaId, basePath: options.basePath ?? '' });
  const tags = [...new Set(manifest.controllers.map((c) => c.className.replace(/Controller$/, '')))].sort().map((name) => ({ name }));
  return {
    openapi: '3.1.0',
    info: { title: options.title, version: options.version, 'x-spinajs-manifest-hash': manifest.hash } as OpenAPIV3_1.InfoObject,
    ...(options.servers ? { servers: options.servers } : {}),
    tags,
    paths,
    components: {
      schemas: registry.schemas() as Record<string, OpenAPIV3_1.SchemaObject>,
      ...(options.securitySchemes ? { securitySchemes: options.securitySchemes as Record<string, OpenAPIV3_1.SecuritySchemeObject> } : {}),
    },
  };
}
