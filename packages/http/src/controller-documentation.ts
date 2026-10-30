import type ts from 'typescript';
import type { DefaultControllerCache } from './cache.js';

export interface IParamDoc {
  name: string;
  description?: string;
  type?: string;
}

export interface IResponseDoc {
  description: string;
  /** Optional `{type}` annotation, e.g. `@response 400 {string} message` */
  type?: string;
}

/** `@body {Type} description`: the JSON body of a route that reads it without a body route argument. */
export interface IBodyDoc {
  type: string;
  description?: string;
}

export interface IExampleDoc {
  name?: string;
  description?: string;
  value?: string;
}

/** JSON-Schema-compatible shape produced by the TypeScript return-type analyser */
export interface ITypeSchema {
  type?: string;
  items?: ITypeSchema;
  properties?: Record<string, ITypeSchema>;
  required?: string[];
  $ref?: string;
  description?: string;
}

export interface IReturnDoc {
  description?: string;
  type?: string;
  schema?: ITypeSchema;
}

export interface IMethodDoc {
  summary?: string;
  description?: string;
  params: Record<string, IParamDoc>;
  returns?: IReturnDoc;
  body?: IBodyDoc;
  responses?: Record<string, IResponseDoc>;
  examples?: IExampleDoc[];
  tags?: string[];
  deprecated?: boolean;
  /**
   * Per-operation security override.
   * Empty array means public (no auth required).
   * Each entry is a security requirement object: { schemeName: scopes[] }.
   */
  security?: Array<Record<string, string[]>>;
}

export interface IPolicyDoc {
  /** Source/declaration file where the policy class is defined */
  file?: string;
  /** JSDoc class-level description, if present */
  description?: string;
}

export interface IControllerDocumentation {
  className: string;
  classDescription?: string;
  classTags?: string[];
  methods: Record<string, IMethodDoc>;
}

/** Context passed to every JSDoc tag extractor */
export interface ITagExtractorContext {
  /** Doc object being populated for the current method */
  doc: IMethodDoc;
  /** Source file the tag was parsed from (needed for safe getText() calls) */
  sourceFile: ts.SourceFile;
  /** Cache instance — exposes helper methods like getTagComment, safeGetText */
  cache: DefaultControllerCache;
}

/**
 * JSDoc tag handler. Register new tags by pushing into
 * `DefaultControllerCache.tagExtractors`.
 */
export interface ITagExtractor {
  /** Tag names this handler accepts (e.g. ['returns', 'return']) */
  tags: string[];
  extract(tag: ts.JSDocTag, ctx: ITagExtractorContext): void;
}
