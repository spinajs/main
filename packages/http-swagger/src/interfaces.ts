
/**
 * Configuration for Swagger/OpenAPI documentation generation.
 * Read from application configuration at path `http.swagger`
 */
export interface ISwaggerConfig {
  enabled: boolean;
  title: string;
  version: string;
  description?: string;
  basePath?: string;
  servers?: ISwaggerServer[];
  securitySchemes?: Record<string, ISecurityScheme>;
  security?: Record<string, string[]>[];
  ui?: ISwaggerUiConfig;
}

/**
 * Configuration for Swagger UI rendering
 */
export interface ISwaggerUiConfig {
  /**
   * URL to swagger-ui CSS file
   */
  cssUrl: string;

  /**
   * URL to swagger-ui-bundle.js
   */
  bundleUrl: string;

  /**
   * URL to swagger-ui-standalone-preset.js
   */
  presetUrl: string;

  /**
   * URL to the OpenAPI JSON spec endpoint (used by Swagger UI to load the spec)
   */
  specUrl: string;

  /**
   * Custom page title for the Swagger UI page
   */
  pageTitle?: string;
}

export interface ISwaggerServer {
  url: string;
  description?: string;
}

export interface ISecurityScheme {
  type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect';
  scheme?: string;
  bearerFormat?: string;
  name?: string;
  in?: 'query' | 'header' | 'cookie';
  description?: string;
}

/**
 * JSDoc documentation extracted from a controller method
 */
export interface IMethodDocumentation {
  summary?: string;
  description?: string;
  params: Record<string, IParamDocumentation>;
  returns?: IReturnDocumentation;
  examples?: IExampleDocumentation[];
  tags?: string[];
  deprecated?: boolean;
}

export interface IParamDocumentation {
  name: string;
  description?: string;
  type?: string;
  required?: boolean;
}

export interface IReturnDocumentation {
  description?: string;
  type?: string;
}

export interface IExampleDocumentation {
  name?: string;
  description?: string;
  value?: string;
}

/**
 * Cache entry for a single controller's JSDoc documentation
 */
export interface ISwaggerCacheEntry {
  className: string;
  classDescription?: string;
  classTags?: string[];
  methods: Record<string, IMethodDocumentation>;
}

/**
 * OpenAPI 3.0 document structure
 */
export interface IOpenApiDocument {
  openapi: string;
  info: IOpenApiInfo;
  servers?: IOpenApiServer[];
  paths: Record<string, IOpenApiPathItem>;
  components?: IOpenApiComponents;
  security?: Record<string, string[]>[];
  tags?: IOpenApiTag[];
}

export interface IOpenApiInfo {
  title: string;
  version: string;
  description?: string;
}

export interface IOpenApiServer {
  url: string;
  description?: string;
}

export interface IOpenApiTag {
  name: string;
  description?: string;
}

export interface IOpenApiPathItem {
  [method: string]: IOpenApiOperation;
}

export interface IOpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: IOpenApiParameter[];
  requestBody?: IOpenApiRequestBody;
  responses: Record<string, IOpenApiResponse>;
  security?: Record<string, string[]>[];
}

export interface IOpenApiParameter {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  description?: string;
  required?: boolean;
  schema?: IOpenApiSchema;
}

export interface IOpenApiRequestBody {
  description?: string;
  required?: boolean;
  content: Record<string, IOpenApiMediaType>;
}

export interface IOpenApiMediaType {
  schema?: IOpenApiSchema;
  examples?: Record<string, IOpenApiExample>;
}

export interface IOpenApiExample {
  summary?: string;
  description?: string;
  value?: any;
}

export interface IOpenApiResponse {
  description: string;
  content?: Record<string, IOpenApiMediaType>;
}

export interface IOpenApiSchema {
  type?: string;
  format?: string;
  items?: IOpenApiSchema;
  properties?: Record<string, IOpenApiSchema>;
  required?: string[];
  $ref?: string;
  description?: string;
  enum?: any[];
}

export interface IOpenApiComponents {
  schemas?: Record<string, IOpenApiSchema>;
  securitySchemes?: Record<string, ISecurityScheme>;
}
