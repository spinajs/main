import type { Manifest } from '@spinajs/manifest';
import type { OpenAPIV3_1 } from 'openapi-types';

export interface OpenApiOptions {
  title: string;
  version: string;
}

export function manifestToOpenApi(manifest: Manifest, options: OpenApiOptions): OpenAPIV3_1.Document {
  void manifest;
  return { openapi: '3.1.0', info: { title: options.title, version: options.version }, paths: {} };
}
