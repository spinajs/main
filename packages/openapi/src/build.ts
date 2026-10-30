import type { Manifest } from '@spinajs/manifest';
import type { OpenAPIV3_1 } from 'openapi-types';
import { createComponentRegistry } from './components.js';
import { buildPaths } from './paths.js';
import { FALLBACK_PROBLEM_SCHEMA } from './problem.js';
import { validateRefs } from './refs.js';

export interface OpenApiOptions {
  title: string;
  version: string;
  servers?: { url: string; description?: string }[];
  securitySchemes?: Record<string, OpenAPIV3_1.SecuritySchemeObject>;
  /** `$id` of the problem+json schema; default 'spinajs/http/ProblemDetails'. */
  errorSchemaId?: string;
  /** Body of the problem+json schema, used when `manifest.schemas` does not hold `errorSchemaId`; defaults to the RFC 9457 shape `@spinajs/http` emits. */
  errorSchema?: Record<string, unknown>;
  /** Prepended to every path as written, e.g. where a proxy mounts the app. */
  basePath?: string;
  /** The app's `http.controllers.route.prefix`, applied to every route as the router applies it. */
  routePrefix?: string;
}

const DEFAULT_ERROR_SCHEMA_ID = 'spinajs/http/ProblemDetails';

function schemasWithError(manifest: Manifest, errorSchemaId: string, errorSchema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (Object.hasOwn(manifest.schemas, errorSchemaId)) return manifest.schemas;
  return { ...manifest.schemas, [errorSchemaId]: errorSchema ?? FALLBACK_PROBLEM_SCHEMA };
}

export function manifestToOpenApi(manifest: Manifest, options: OpenApiOptions): OpenAPIV3_1.Document {
  const errorSchemaId = options.errorSchemaId ?? DEFAULT_ERROR_SCHEMA_ID;
  const registry = createComponentRegistry(schemasWithError(manifest, errorSchemaId, options.errorSchema));
  const paths = buildPaths(manifest, registry, { errorSchemaId, basePath: options.basePath ?? '', routePrefix: options.routePrefix });
  const tagNames = manifest.controllers.flatMap((c) => [c.className.replace(/Controller$/, ''), ...c.routes.flatMap((r) => r.doc?.tags ?? [])]);
  const tags = [...new Set(tagNames)].sort().map((name) => ({ name }));
  const document: OpenAPIV3_1.Document = {
    openapi: '3.1.0',
    info: { title: options.title, version: options.version, 'x-spinajs-manifest-hash': manifest.hash } as OpenAPIV3_1.InfoObject,
    ...(options.servers ? { servers: options.servers } : {}),
    tags,
    paths,
    components: {
      schemas: registry.schemas() as Record<string, OpenAPIV3_1.SchemaObject>,
      ...(options.securitySchemes ? { securitySchemes: options.securitySchemes } : {}),
    },
  };
  validateRefs(document);
  return document;
}
