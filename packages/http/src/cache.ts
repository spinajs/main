import type TS from 'typescript';
import { resolve as resolvePath, dirname, join, isAbsolute } from 'path';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { AsyncService, Autoinject, ClassInfo, Singleton } from '@spinajs/di';
import { fs as fFs, FileHasher, FileSystem } from '@spinajs/fs';
import type { BaseController } from './base-controller.js';
import { Logger, Log } from '@spinajs/log';
import type { IControllerDocumentation, IExampleDoc, IMethodDoc, IPolicyDoc, ITagExtractor, ITagExtractorContext, ITypeSchema } from './controller-documentation.js';
import { isOnDiskSource, parseFnParamNames } from './cache-helpers.js';
import { NoControllerMetadata } from './controller-metadata.js';

// Assigned by loadTypescript() before any parse: a process whose cache entries all exist never loads the compiler.
let ts: typeof TS;

async function loadTypescript(): Promise<void> {
  try {
    ts ??= (await import('typescript')).default;
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_MODULE_NOT_FOUND' && String((err as Error).message).includes("'typescript'")) {
      throw new NoControllerMetadata('The TypeScript controller cache needs the optional peer dependency `typescript` to parse controller declarations: install it, pre-build the cache ( spinajs http:controllers:cache ), or build the app manifest ( spinajs build ) and set system.manifest.mode.', err);
    }
    throw err;
  }
}

/** Stand-in prefix used when the package version cannot be read - see `resolveVersion()`. */
const UNKNOWN_VERSION = 'unknown';

/**
 * Shape of a cache entry file: `<package version>_<content hash>`, with a `doc_` twin holding the
 * documentation. Tells this class's own files apart from anything else that ends up in the
 * directory - `fs.rm()` is recursive, so a stray subdirectory would go whole.
 */
const ENTRY_NAME = /^(doc_)?[^_]+_[0-9a-f]+$/;

/**
 * Best-effort lookup of this package's version, the same way `@spinajs/cli` reads its own.
 *
 * Resolved rather than joined onto cwd: node walks the parent `node_modules` chain, so this holds
 * when the process starts somewhere below the app root - a monorepo package, a test runner. Anchored
 * at the app root (WORKSPACE_ROOT_PATH or cwd) on purpose, so the version is the one the app installed.
 * Requires `./package.json` in the package's `exports`.
 */
function resolveVersion(): string {
  try {
    const require = createRequire(`${process.env.WORKSPACE_ROOT_PATH ?? process.cwd()}/`);
    return (require('@spinajs/http/package.json') as { version: string }).version;
  } catch {
    return UNKNOWN_VERSION;
  }
}

/** Wrapper types unwrapped to their first type argument (`Promise<T>`, `Ok<T>`, `ModelData<T>`, …). */
const TRANSPARENT_WRAPPERS = new Set<string>([
  'Promise', 'Ok', 'Json', 'Created', 'BadRequest', 'NotFound',
  'ServerError', 'Unauthorized', 'Forbidden', 'Conflict', 'NoContent',
  'ValidationError', 'NotAllowed', 'EntityTooLarge',
  'ModelDataWithRelationData', 'ModelData',
]);

@Singleton()
export class DefaultControllerCache extends AsyncService {
  @Logger('http')
  protected Log: Log;

  @FileSystem('__fs_controller_cache__')
  protected CacheFS: fFs;

  @Autoinject(FileHasher)
  protected Hasher: FileHasher;

  /**
   * Version of the installed `@spinajs/http`, prefixed onto every cache key.
   *
   * Entries are keyed by the hash of a controller's `.d.ts`, which answers "did the controller
   * change?" but not "did the extractor that reads it change?". Adding `classTags` support touched
   * no controller, so every entry kept its key and the new extractor read back the old, tagless
   * document - endpoints then showed in the swagger under their class name instead of their
   * `@tags`. Prefixing the version means a newly installed package build starts from keys nothing
   * was ever written under, which is exactly when the extractor can have changed.
   *
   * A version we cannot read degrades to a fixed prefix, so the cache keeps working as it did
   * before this prefix existed.
   */
  protected Version = resolveVersion();

  public async resolve() {
    await super.resolve();
    await this.dropStaleEntries();
    this.Log.info({ dir: this.CacheFS.resolvePath(''), version: this.Version }, 'Controller cache dir is: ${dir} ( @spinajs/http ${version} )');
  }

  /**
   * Drops every entry in the cache directory, whatever version wrote it.
   *
   * Used by `http:controllers:cache --rebuild`, so a run leaves the directory holding exactly what
   * the current build produces.
   */
  public async clear(): Promise<void> {
    if (!(await this.CacheFS.dirExists(''))) {
      return;
    }

    for (const entry of await this.CacheFS.list('')) {
      if (ENTRY_NAME.test(entry)) {
        await this.CacheFS.rm(entry);
      }
    }
  }

  /**
   * Removes entries left behind by other versions of this package.
   *
   * They key under a prefix nothing will ever look up again, so a directory that grows one full
   * set per installed version buys nothing - one readdir on startup is cheaper than that, and it
   * means upgrading the package needs no cache command at all.
   *
   * Skipped when the version could not be resolved: every entry would then look foreign and the
   * cache would be wiped on every boot.
   */
  protected async dropStaleEntries(): Promise<void> {
    if (this.Version === UNKNOWN_VERSION || !(await this.CacheFS.dirExists(''))) {
      return;
    }

    const mine = (name: string) => name.startsWith(`${this.Version}_`) || name.startsWith(`doc_${this.Version}_`);

    for (const entry of await this.CacheFS.list('')) {
      if (ENTRY_NAME.test(entry) && !mine(entry)) {
        this.Log.info({ entry }, 'Dropping stale controller cache entry ${entry}');
        await this.CacheFS.rm(entry);
      }
    }
  }

  /**
   * Returns parameter-name map used for route argument binding.
   *
   * Cache entries are keyed by source-file content hash and package version, so a changed file or
   * a changed package naturally gets a fresh entry. Missing entries are generated here, which is
   * also how `http:controllers:cache` pre-builds them after wiping the directory.
   */
  public async getCache(controller: ClassInfo<BaseController>): Promise<Record<string, string[]>> {
    // Sentinel values like `<di>` are set by Controllers.resolve() / add() for
    // controllers registered through DI rather than a file scan. There's no
    // on-disk source to parse, so fall back to a runtime extraction of
    // parameter names from each method's Function.toString().
    if (!this.isResolvableSource(controller.file)) {
      return this.extractParametersAtRuntime(controller);
    }

    const file = resolvePath(controller.file.replace('.js', '.d.ts'));
    // Both entries are keyed by the source hash AND the package version - see the Version field. Parameters
    // go through the same extractAll() as the documentation, so both go stale the same way when
    // the extractor changes.
    const paramHash = `${this.Version}_${await this.Hasher.hash(file)}`;
    const docHash = `doc_${paramHash}`;

    const paramExists = await this.CacheFS.exists(paramHash);
    const docExists = await this.CacheFS.exists(docHash);

    if (!paramExists || !docExists) {
      this.Log.info({ controller: controller.name }, 'Generating controller cache for ${controller}');
      await loadTypescript();
      const { parameters, documentation } = this.extractAll(file, controller.name);

      if (!paramExists) await this.CacheFS.write(paramHash, JSON.stringify(parameters));
      if (!docExists) await this.CacheFS.write(docHash, JSON.stringify(documentation));

      this.Log.info({ controller: controller.name }, 'Controller cache generated for ${controller}');
    }

    return this.CacheFS.read(paramHash).then((x) => JSON.parse(x.toString()) as Record<string, string[]>);
  }

  /** Whether `file` points at a real on-disk source we can parse. */
  private isResolvableSource(file: string | undefined): boolean {
    return isOnDiskSource(file);
  }

  /**
   * Fallback: derive route method parameter names by parsing each method's
   * Function.toString() output. Loses JSDoc documentation (no @param tags
   * etc.) but keeps argument binding working for DI-registered controllers
   * that have no source file on disk.
   */
  private extractParametersAtRuntime(controller: ClassInfo<BaseController>): Record<string, string[]> {
    const parameters: Record<string, string[]> = {};
    const instance = controller.instance;
    if (!instance || !instance.Descriptor) return parameters;

    for (const [methodName] of instance.Descriptor.Routes) {
      const fn = (instance as any)[methodName as string];
      if (typeof fn !== 'function') continue;
      parameters[methodName as string] = parseFnParamNames(fn);
    }
    return parameters;
  }

  /** Returns the JSDoc / TypeScript-annotation documentation for a controller. */
  public async getDocumentation(controller: ClassInfo<BaseController>): Promise<IControllerDocumentation> {
    // No source file → no JSDoc to extract. Return an empty shell so callers
    // (e.g. http-swagger) gracefully skip the controller instead of throwing.
    if (!this.isResolvableSource(controller.file)) {
      return { className: controller.name, methods: {} };
    }

    const file = resolvePath(controller.file.replace('.js', '.d.ts'));
    // Same key as getCache() writes under, package version included - see the Version field.
    const docHash = `doc_${this.Version}_${await this.Hasher.hash(file)}`;

    if (!(await this.CacheFS.exists(docHash))) {
      await this.getCache(controller);
    }

    return this.CacheFS.read(docHash).then((x) => JSON.parse(x.toString()) as IControllerDocumentation);
  }

  /**
   * Resolve JSDoc descriptions for policy classes referenced by a controller.
   *
   * Policy class names come from `controller.instance.Descriptor.Policies`
   * and `route.Policies` at runtime. To find each class's source we parse the
   * controller's compiled JS file (which preserves *all* imports — unlike the
   * .d.ts which only emits type-referenced ones) and resolve the matching
   * module specifier against the controller's directory or node_modules.
   *
   * JSDoc is extracted per class — several policies may share one file, so the
   * file is parsed once per class. Policy doc volume is small and a parse is
   * cheap, see parseSourceFile().
   */
  public async getPolicyDocumentation(
    controller: ClassInfo<BaseController>,
    policyNames: string[],
  ): Promise<Record<string, IPolicyDoc>> {
    const out: Record<string, IPolicyDoc> = {};
    if (policyNames.length === 0) return out;

    const controllerJs = resolvePath(controller.file);
    await loadTypescript();
    const importMap = this.extractImports(controllerJs);
    if (importMap.size === 0) return out;

    for (const name of policyNames) {
      if (out[name]) continue;
      const moduleSpec = importMap.get(name);
      if (!moduleSpec) continue;

      const policyFile = this.resolvePolicyFile(controllerJs, moduleSpec);
      if (!policyFile) continue;

      try {
        const description = this.extractClassJsDoc(policyFile, name);
        out[name] = { file: policyFile, description };
      } catch (err) {
        this.Log.trace({ error: err, policyFile, policy: name }, 'Could not parse policy file ${policyFile} for ${policy}');
        out[name] = { file: policyFile };
      }
    }

    return out;
  }

  // ---------------------------------------------------------------------------
  // Single-pass TypeScript extraction
  // ---------------------------------------------------------------------------

  /**
   * Parses `file` alone. Every extractor here reads one file's syntax tree; a `ts.Program` would
   * also parse the default lib and every reachable `@types` package (~110 files, 3 MB) on each
   * call, which made a boot with a few dozen controllers take tens of seconds. `ts.sys.readFile`
   * is what a program's compiler host reads with, so the text - BOM handling included - is the same.
   */
  private parseSourceFile(file: string): ts.SourceFile | undefined {
    const text = ts.sys.readFile(file);
    return text === undefined ? undefined : ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
  }

  private extractAll(file: string, className: string): { parameters: Record<string, string[]>; documentation: IControllerDocumentation } {
    const sourceFile = this.parseSourceFile(file);

    const parameters: Record<string, string[]> = {};
    const documentation: IControllerDocumentation = { className, methods: {} };

    if (!sourceFile) {
      this.Log.warn({ file }, 'Could not parse source file: ${file}');
      return { parameters, documentation };
    }

    ts.forEachChild(sourceFile, (node) => {
      if (!ts.isClassDeclaration(node) || node.name?.text !== className) return;

      // Class-level JSDoc
      const classComment = this.getJSDocComment(node);
      if (classComment) documentation.classDescription = classComment;

      const classTags = this.getJSDocTagValue(node, 'tags') ?? this.getJSDocTagValue(node, 'category');
      if (classTags) documentation.classTags = classTags.split(',').map((t) => t.trim());

      // Per-method extraction
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !member.name) continue;

        const methodName: string = ts.isIdentifier(member.name) ? member.name.text : (member.name as any).escapedText ?? '';
        if (!methodName) continue;

        // Param names (for routing)
        parameters[methodName] = member.parameters.map((p) => (p.name as TS.Identifier).text);

        // JSDoc documentation
        documentation.methods[methodName] = this.extractMethodDoc(member, sourceFile);
      }
    });

    return { parameters, documentation };
  }

  // ---------------------------------------------------------------------------
  // JSDoc extraction helpers
  // ---------------------------------------------------------------------------

  private extractMethodDoc(method: TS.MethodDeclaration, sourceFile: TS.SourceFile): IMethodDoc {
    const doc: IMethodDoc = { params: {} };

    const comment = this.getJSDocComment(method);
    if (comment) {
      const lines = comment.split('\n');
      doc.summary = lines[0].trim();
      const rest = lines.slice(1).join('\n').trim();
      if (rest) doc.description = rest;
    }

    // Infer schema from TypeScript return type annotation
    if (method.type) {
      if (!doc.returns) doc.returns = {};
      doc.returns.schema = this.inferSchemaFromTypeNode(method.type);
    }

    const ctx: ITagExtractorContext = { doc, sourceFile, cache: this };
    for (const tag of this.getRawJSDocTags(method)) {
      const tagName = tag.tagName.text;
      for (const ex of this.tagExtractors) {
        if (ex.tags.includes(tagName)) {
          ex.extract(tag, ctx);
          break;
        }
      }
    }

    return doc;
  }

  // ---------------------------------------------------------------------------
  // JSDoc tag extractors
  //
  // Subclasses can mutate `this.tagExtractors` (e.g. in resolve()) to add or
  // override tag handlers. Each tag name is matched once per JSDoc tag — the
  // first matching extractor wins.
  // ---------------------------------------------------------------------------

  /**
   * Built-in tag extractors. Public so subclasses / consumers can append
   * custom JSDoc tag handlers without overriding extractMethodDoc.
   */
  public readonly tagExtractors: ITagExtractor[] = [
    { tags: ['param'], extract: (tag, ctx) => this.extractParamTag(tag as TS.JSDocParameterTag, ctx) },
    { tags: ['returns', 'return'], extract: (tag, ctx) => this.extractReturnTag(tag as TS.JSDocReturnTag, ctx) },
    { tags: ['response'], extract: (tag, ctx) => this.extractResponseTag(tag, ctx) },
    { tags: ['body'], extract: (tag, ctx) => this.extractBodyTag(tag, ctx) },
    { tags: ['example'], extract: (tag, ctx) => this.extractExampleTag(tag, ctx) },
    { tags: ['tags', 'tag', 'category'], extract: (tag, ctx) => this.extractTagsTag(tag, ctx) },
    { tags: ['deprecated'], extract: (_tag, ctx) => { ctx.doc.deprecated = true; } },
    { tags: ['summary'], extract: (tag, ctx) => this.extractSummaryTag(tag, ctx) },
    { tags: ['security'], extract: (tag, ctx) => this.extractSecurityTag(tag, ctx) },
  ];

  private extractParamTag(tag: TS.JSDocParameterTag, ctx: ITagExtractorContext): void {
    const name = ts.isIdentifier(tag.name) ? tag.name.text : (tag.name as any)?.right?.text ?? '';
    if (!name) return;
    ctx.doc.params[name] = {
      name,
      description: this.getTagComment(tag)?.trim(),
      type: this.safeGetText(tag.typeExpression, ctx.sourceFile),
    };
  }

  private extractReturnTag(tag: TS.JSDocReturnTag, ctx: ITagExtractorContext): void {
    if (!ctx.doc.returns) ctx.doc.returns = {};
    ctx.doc.returns.description = this.getTagComment(tag) ?? undefined;
    ctx.doc.returns.type = this.safeGetText(tag.typeExpression, ctx.sourceFile);
  }

  private extractResponseTag(tag: TS.JSDocTag, ctx: ITagExtractorContext): void {
    const comment = this.getTagComment(tag);
    if (!comment) return;
    const space = comment.indexOf(' ');
    if (space <= 0) return;
    const code = comment.substring(0, space).trim();
    if (!/^\d+$/.test(code)) return;
    let desc = comment.substring(space + 1).trim();

    // `@response 400 {string} message` — split the optional type annotation off
    let type: string | undefined;
    const typeMatch = /^\{([^}]+)\}\s*/.exec(desc);
    if (typeMatch) {
      type = typeMatch[1].trim();
      desc = desc.substring(typeMatch[0].length).trim();
    }

    (ctx.doc.responses ??= {})[code] = { description: desc, ...(type ? { type } : {}) };
  }

  private extractBodyTag(tag: TS.JSDocTag, ctx: ITagExtractorContext): void {
    const match = /^\{([^}]+)\}\s*([\s\S]*)$/.exec(this.getTagComment(tag)?.trim() ?? '');
    if (!match) return;
    const description = match[2].trim();
    ctx.doc.body = { type: match[1].trim(), ...(description ? { description } : {}) };
  }

  private extractExampleTag(tag: TS.JSDocTag, ctx: ITagExtractorContext): void {
    const ex = this.parseExample(tag);
    if (ex) (ctx.doc.examples ??= []).push(ex);
  }

  private extractTagsTag(tag: TS.JSDocTag, ctx: ITagExtractorContext): void {
    const val = this.getTagComment(tag);
    if (val) ctx.doc.tags = val.split(',').map((t) => t.trim());
  }

  private extractSummaryTag(tag: TS.JSDocTag, ctx: ITagExtractorContext): void {
    const val = this.getTagComment(tag);
    if (val) ctx.doc.summary = val;
  }

  private extractSecurityTag(tag: TS.JSDocTag, ctx: ITagExtractorContext): void {
    const val = this.getTagComment(tag)?.trim();
    if (val === '[]' || val === '') {
      ctx.doc.security = [];
    } else if (val) {
      // Comma-separated scheme names, each maps to an empty scopes array.
      // e.g. "@security cookieAuth"            → [{ cookieAuth: [] }]
      // e.g. "@security cookieAuth, bearerAuth" → [{ cookieAuth: [] }, { bearerAuth: [] }]
      ctx.doc.security = val.split(',').map((s): Record<string, string[]> => ({ [s.trim()]: [] }));
    }
  }

  private getJSDocComment(node: TS.Node): string | undefined {
    const jsDocs = (node as any).jsDoc as TS.JSDoc[] | undefined;
    if (!jsDocs?.length) return undefined;
    const { comment } = jsDocs[0];
    if (!comment) return undefined;
    if (typeof comment === 'string') return comment;
    if (Array.isArray(comment)) return comment.map((p: any) => p.text ?? p).join('');
    return undefined;
  }

  private getJSDocTagValue(node: TS.Node, tagName: string): string | undefined {
    const rawJsDocs = (node as any).jsDoc as TS.JSDoc[] | undefined;
    if (!rawJsDocs) return undefined;
    for (const jsDoc of rawJsDocs) {
      if (!jsDoc.tags) continue;
      const found = Array.from(jsDoc.tags).find((t) => t.tagName?.text === tagName);
      if (found) return this.getTagComment(found);
    }
    return undefined;
  }

  private getRawJSDocTags(node: TS.Node): TS.JSDocTag[] {
    const rawJsDocs = (node as any).jsDoc as TS.JSDoc[] | undefined;
    if (!rawJsDocs) return [];
    return rawJsDocs.flatMap((j) => (j.tags ? Array.from(j.tags) : []));
  }

  private safeGetText(node: TS.Node | undefined, sourceFile: TS.SourceFile): string | undefined {
    if (!node) return undefined;
    try {
      return node.getText(sourceFile);
    } catch {
      return undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Policy doc helpers — used by getPolicyDocumentation()
  // ---------------------------------------------------------------------------

  /**
   * Parse a JS or TS file and return `imported name → module specifier` for
   * every static `import { X, Y as Z } from 'mod'` declaration. Default and
   * namespace imports are skipped — policies are always named exports.
   */
  private extractImports(file: string): Map<string, string> {
    const map = new Map<string, string>();
    const sourceFile = this.parseSourceFile(file);
    if (!sourceFile) return map;

    ts.forEachChild(sourceFile, (node) => {
      if (!ts.isImportDeclaration(node)) return;
      if (!ts.isStringLiteral(node.moduleSpecifier)) return;
      const specifier = node.moduleSpecifier.text;

      const named = node.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          // `imported as local` → bind local to the source module
          map.set(el.name.text, specifier);
        }
      }
    });

    return map;
  }

  /**
   * Resolve a module specifier (relative or package) referenced from
   * `fromFile` into the on-disk `.d.ts` we can parse. Prefers .d.ts over .js so
   * JSDoc preserved by tsc declaration emit is available.
   */
  private resolvePolicyFile(fromFile: string, specifier: string): string | undefined {
    if (specifier.startsWith('.')) {
      const base = resolvePath(dirname(fromFile), specifier);
      return this.pickDeclarationFile(base);
    }

    // Bare package specifier — use Node's resolver, anchored at the controller's dir
    try {
      const require = createRequire(fromFile);
      const resolved = require.resolve(specifier);
      return this.pickDeclarationFile(resolved);
    } catch {
      return undefined;
    }
  }

  /**
   * From a JS/path candidate, return the matching declaration file. Tries
   * .d.ts variants first; falls back to the .js itself if no declarations
   * exist (we can still parse JSDoc out of the source).
   */
  private pickDeclarationFile(candidate: string): string | undefined {
    const noExt = candidate.replace(/\.(js|mjs|cjs|d\.ts|ts)$/i, '');
    const candidates = [
      `${noExt}.d.ts`,
      candidate.replace(/\.js$/i, '.d.ts'),
      candidate,
      `${noExt}.ts`,
      `${noExt}.js`,
    ];
    for (const c of candidates) {
      if (isAbsolute(c) && existsSync(c)) return c;
    }
    return undefined;
  }

  /**
   * Extract the JSDoc block immediately above the class declaration named
   * `className` in `file`. Returns the description text without tags.
   */
  private extractClassJsDoc(file: string, className: string): string | undefined {
    const sourceFile = this.parseSourceFile(file);
    if (!sourceFile) return undefined;

    let description: string | undefined;
    ts.forEachChild(sourceFile, (node) => {
      if (description) return;
      if (ts.isClassDeclaration(node) && node.name?.text === className) {
        description = this.getJSDocComment(node);
      }
    });
    // Suppress the unused-import linting in environments that strip them out
    void join;
    return description;
  }

  private getTagComment(tag: TS.JSDocTag): string | undefined {
    if (!tag.comment) return undefined;
    if (typeof tag.comment === 'string') return tag.comment;
    if (Array.isArray(tag.comment)) return (tag.comment as any[]).map((p) => p.text ?? p).join('');
    return undefined;
  }

  private parseExample(tag: TS.JSDocTag): IExampleDoc | undefined {
    const comment = this.getTagComment(tag);
    if (!comment) return undefined;
    const captionMatch = comment.match(/<caption>(.*?)<\/caption>/s);
    if (captionMatch) {
      return { name: captionMatch[1].trim(), value: comment.replace(captionMatch[0], '').trim() };
    }
    return { value: comment.trim() };
  }

  // ---------------------------------------------------------------------------
  // TypeScript return-type → ITypeSchema inference
  // ---------------------------------------------------------------------------

  private inferSchemaFromTypeNode(typeNode: TS.TypeNode): ITypeSchema {
    switch (typeNode.kind) {
      case ts.SyntaxKind.StringKeyword:  return { type: 'string' };
      case ts.SyntaxKind.NumberKeyword:  return { type: 'number' };
      case ts.SyntaxKind.BooleanKeyword: return { type: 'boolean' };
      case ts.SyntaxKind.VoidKeyword:
      case ts.SyntaxKind.UndefinedKeyword:
      case ts.SyntaxKind.NullKeyword:
      case ts.SyntaxKind.AnyKeyword:
      case ts.SyntaxKind.UnknownKeyword:
      case ts.SyntaxKind.ObjectKeyword:  return { type: 'object' };
    }

    if (ts.isArrayTypeNode(typeNode)) {
      return { type: 'array', items: this.inferSchemaFromTypeNode(typeNode.elementType) };
    }

    if (ts.isTypeReferenceNode(typeNode)) {
      return this.schemaFromNamedType(entityNameRight(typeNode.typeName), typeNode.typeArguments);
    }
    if (ts.isImportTypeNode(typeNode) && typeNode.qualifier) {
      return this.schemaFromNamedType(entityNameRight(typeNode.qualifier), typeNode.typeArguments);
    }

    if (ts.isTypeLiteralNode(typeNode)) {
      const properties: Record<string, ITypeSchema> = {};
      const required: string[] = [];
      for (const member of typeNode.members) {
        if (ts.isPropertySignature(member) && ts.isIdentifier(member.name) && member.type) {
          const propName = member.name.text;
          properties[propName] = this.inferSchemaFromTypeNode(member.type);
          if (!member.questionToken) required.push(propName);
        }
      }
      const schema: ITypeSchema = { type: 'object', properties };
      if (required.length) schema.required = required;
      return schema;
    }

    if (ts.isUnionTypeNode(typeNode)) {
      const meaningful = typeNode.types.filter(
        (t) => t.kind !== ts.SyntaxKind.NullKeyword && t.kind !== ts.SyntaxKind.UndefinedKeyword,
      );
      if (meaningful.length === 1) {
        return this.inferSchemaFromTypeNode(meaningful[0]);
      }
    }

    return { type: 'object' };
  }

  /**
   * Schema for a named type: unwrap wrappers and `Array<T>`, otherwise tag it as a named object.
   * The parser only names the type; http-swagger's providers expand it later.
   */
  private schemaFromNamedType(name: string, typeArguments: TS.NodeArray<TS.TypeNode> | undefined): ITypeSchema {
    if (TRANSPARENT_WRAPPERS.has(name) && typeArguments?.length) {
      return this.inferSchemaFromTypeNode(typeArguments[0]);
    }
    if (name === 'Array' && typeArguments?.length) {
      return { type: 'array', items: this.inferSchemaFromTypeNode(typeArguments[0]) };
    }
    return { type: 'object', description: name };
  }
}

/** Rightmost identifier of an entity name. */
function entityNameRight(name: TS.EntityName): string {
  return ts.isIdentifier(name) ? name.text : name.right.text;
}
