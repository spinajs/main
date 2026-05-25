import ts from 'typescript';
import { resolve as resolvePath, dirname, join, isAbsolute } from 'path';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { AsyncService, Autoinject, ClassInfo, Singleton } from '@spinajs/di';
import { fs as fFs, FileHasher, FileSystem } from '@spinajs/fs';
import type { BaseController } from './controllers.js';
import { Logger, Log } from '@spinajs/log';

// ---------------------------------------------------------------------------
// Documentation types — generic enough to live in http, used by http-swagger
// ---------------------------------------------------------------------------

export interface IParamDoc {
  name: string;
  description?: string;
  type?: string;
}

export interface IResponseDoc {
  description: string;
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

// ---------------------------------------------------------------------------

@Singleton()
export class DefaultControllerCache extends AsyncService {
  @Logger('http')
  protected Log: Log;

  @FileSystem('__fs_controller_cache__')
  protected CacheFS: fFs;

  @Autoinject(FileHasher)
  protected Hasher: FileHasher;

  public async resolve() {
    await super.resolve();
    this.Log.info(`Controller cache dir is: ${this.CacheFS.resolvePath('')}`);
  }

  /** Returns parameter-name map used for route argument binding. */
  public async getCache(controller: ClassInfo<BaseController>): Promise<Record<string, string[]>> {
    const file = resolvePath(controller.file.replace('.js', '.d.ts'));
    const hash = await this.Hasher.hash(file);
    const docHash = `doc_${hash}`;

    const paramExists = await this.CacheFS.exists(hash);
    const docExists = await this.CacheFS.exists(docHash);

    if (!paramExists || !docExists) {
      this.Log.info(`Generating controller cache for ${controller.name}`);
      const { parameters, documentation } = this.extractAll(file, controller.name);

      if (!paramExists) await this.CacheFS.write(hash, JSON.stringify(parameters));
      if (!docExists) await this.CacheFS.write(docHash, JSON.stringify(documentation));

      this.Log.info(`Controller cache generated for ${controller.name}`);
    }

    return this.CacheFS.read(hash).then((x) => JSON.parse(x.toString()) as Record<string, string[]>);
  }

  /** Returns the JSDoc / TypeScript-annotation documentation for a controller. */
  public async getDocumentation(controller: ClassInfo<BaseController>): Promise<IControllerDocumentation> {
    const file = resolvePath(controller.file.replace('.js', '.d.ts'));
    const hash = await this.Hasher.hash(file);
    const docHash = `doc_${hash}`;

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
   * Per-call in-memory cache only — policy doc volume is small and the cost is
   * dominated by ts.createProgram which we already pay for the controller.
   */
  public async getPolicyDocumentation(
    controller: ClassInfo<BaseController>,
    policyNames: string[],
  ): Promise<Record<string, IPolicyDoc>> {
    const out: Record<string, IPolicyDoc> = {};
    if (policyNames.length === 0) return out;

    const controllerJs = resolvePath(controller.file);
    const importMap = this.extractImports(controllerJs);
    if (importMap.size === 0) return out;

    const seenFiles = new Set<string>();
    for (const name of policyNames) {
      if (out[name]) continue;
      const moduleSpec = importMap.get(name);
      if (!moduleSpec) continue;

      const policyFile = this.resolvePolicyFile(controllerJs, moduleSpec);
      if (!policyFile || seenFiles.has(policyFile)) {
        if (policyFile) out[name] = { file: policyFile };
        continue;
      }
      seenFiles.add(policyFile);

      try {
        const description = this.extractClassJsDoc(policyFile, name);
        out[name] = { file: policyFile, description };
      } catch (err) {
        this.Log.trace(`Could not parse policy file ${policyFile} for ${name}: ${(err as Error).message}`);
        out[name] = { file: policyFile };
      }
    }

    return out;
  }

  // ---------------------------------------------------------------------------
  // Single-pass TypeScript extraction
  // ---------------------------------------------------------------------------

  private extractAll(file: string, className: string): { parameters: Record<string, string[]>; documentation: IControllerDocumentation } {
    const program = ts.createProgram([file], {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.Latest,
      noResolve: true,
      skipLibCheck: true,
    });

    const sourceFile = program.getSourceFile(file);

    const parameters: Record<string, string[]> = {};
    const documentation: IControllerDocumentation = { className, methods: {} };

    if (!sourceFile) {
      this.Log.warn(`Could not parse source file: ${file}`);
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
        parameters[methodName] = member.parameters.map((p) => (p.name as ts.Identifier).text);

        // JSDoc documentation
        documentation.methods[methodName] = this.extractMethodDoc(member, sourceFile);
      }
    });

    return { parameters, documentation };
  }

  // ---------------------------------------------------------------------------
  // JSDoc extraction helpers
  // ---------------------------------------------------------------------------

  private extractMethodDoc(method: ts.MethodDeclaration, sourceFile: ts.SourceFile): IMethodDoc {
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

    for (const tag of this.getRawJSDocTags(method)) {
      const tagName = tag.tagName.text;

      switch (tagName) {
        case 'param': {
          const paramTag = tag as ts.JSDocParameterTag;
          const name = ts.isIdentifier(paramTag.name) ? paramTag.name.text : (paramTag.name as any)?.right?.text ?? '';
          if (name) {
            doc.params[name] = {
              name,
              description: this.getTagComment(tag)?.trim(),
              type: this.safeGetText(paramTag.typeExpression, sourceFile),
            };
          }
          break;
        }
        case 'returns':
        case 'return': {
          if (!doc.returns) doc.returns = {};
          doc.returns.description = this.getTagComment(tag) ?? undefined;
          doc.returns.type = this.safeGetText((tag as ts.JSDocReturnTag).typeExpression, sourceFile);
          break;
        }
        case 'response': {
          const comment = this.getTagComment(tag);
          if (comment) {
            const space = comment.indexOf(' ');
            if (space > 0) {
              const code = comment.substring(0, space).trim();
              const desc = comment.substring(space + 1).trim();
              if (/^\d+$/.test(code)) {
                if (!doc.responses) doc.responses = {};
                doc.responses[code] = { description: desc };
              }
            }
          }
          break;
        }
        case 'example': {
          const ex = this.parseExample(tag);
          if (ex) (doc.examples ??= []).push(ex);
          break;
        }
        case 'tags':
        case 'tag':
        case 'category': {
          const val = this.getTagComment(tag);
          if (val) doc.tags = val.split(',').map((t) => t.trim());
          break;
        }
        case 'deprecated':
          doc.deprecated = true;
          break;
        case 'summary': {
          const val = this.getTagComment(tag);
          if (val) doc.summary = val;
          break;
        }
        case 'security': {
          const val = this.getTagComment(tag)?.trim();
          if (val === '[]' || val === '') {
            doc.security = [];
          } else if (val) {
            // Comma-separated scheme names, each maps to an empty scopes array.
            // e.g. "@security cookieAuth" → [{ cookieAuth: [] }]
            // e.g. "@security cookieAuth, bearerAuth" → [{ cookieAuth: [] }, { bearerAuth: [] }]
            doc.security = val.split(',').map((s): Record<string, string[]> => ({ [s.trim()]: [] }));
          }
          break;
        }
      }
    }

    return doc;
  }

  private getJSDocComment(node: ts.Node): string | undefined {
    const jsDocs = (node as any).jsDoc as ts.JSDoc[] | undefined;
    if (!jsDocs?.length) return undefined;
    const { comment } = jsDocs[0];
    if (!comment) return undefined;
    if (typeof comment === 'string') return comment;
    if (Array.isArray(comment)) return comment.map((p: any) => p.text ?? p).join('');
    return undefined;
  }

  private getJSDocTagValue(node: ts.Node, tagName: string): string | undefined {
    const rawJsDocs = (node as any).jsDoc as ts.JSDoc[] | undefined;
    if (!rawJsDocs) return undefined;
    for (const jsDoc of rawJsDocs) {
      if (!jsDoc.tags) continue;
      const found = Array.from(jsDoc.tags).find((t) => t.tagName?.text === tagName);
      if (found) return this.getTagComment(found);
    }
    return undefined;
  }

  private getRawJSDocTags(node: ts.Node): ts.JSDocTag[] {
    const rawJsDocs = (node as any).jsDoc as ts.JSDoc[] | undefined;
    if (!rawJsDocs) return [];
    return rawJsDocs.flatMap((j) => (j.tags ? Array.from(j.tags) : []));
  }

  private safeGetText(node: ts.Node | undefined, sourceFile: ts.SourceFile): string | undefined {
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
    const program = ts.createProgram([file], {
      allowJs: true,
      module: ts.ModuleKind.NodeNext,
      target: ts.ScriptTarget.Latest,
      noResolve: true,
      skipLibCheck: true,
    });
    const sourceFile = program.getSourceFile(file);
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
    const program = ts.createProgram([file], {
      allowJs: true,
      module: ts.ModuleKind.NodeNext,
      target: ts.ScriptTarget.Latest,
      noResolve: true,
      skipLibCheck: true,
    });
    const sourceFile = program.getSourceFile(file);
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

  private getTagComment(tag: ts.JSDocTag): string | undefined {
    if (!tag.comment) return undefined;
    if (typeof tag.comment === 'string') return tag.comment;
    if (Array.isArray(tag.comment)) return (tag.comment as any[]).map((p) => p.text ?? p).join('');
    return undefined;
  }

  private parseExample(tag: ts.JSDocTag): IExampleDoc | undefined {
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

  private inferSchemaFromTypeNode(typeNode: ts.TypeNode): ITypeSchema {
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
      const name = ts.isIdentifier(typeNode.typeName)
        ? typeNode.typeName.text
        : (typeNode.typeName as ts.QualifiedName).right.text;

      // Unwrap transparent wrappers — pass through to the inner type argument
      const TRANSPARENT_WRAPPERS = new Set([
        'Promise', 'Ok', 'Json', 'Created', 'BadRequest', 'NotFound',
        'ServerError', 'Unauthorized', 'Forbidden', 'Conflict', 'NoContent',
        'ValidationError', 'NotAllowed', 'EntityTooLarge',
      ]);
      if (TRANSPARENT_WRAPPERS.has(name) && typeNode.typeArguments?.length) {
        return this.inferSchemaFromTypeNode(typeNode.typeArguments[0]);
      }
      if (name === 'Array' && typeNode.typeArguments?.length) {
        return { type: 'array', items: this.inferSchemaFromTypeNode(typeNode.typeArguments[0]) };
      }
      switch (name) {
        case 'string':  return { type: 'string' };
        case 'number':  return { type: 'number' };
        case 'boolean': return { type: 'boolean' };
        // Avoid generating $ref to schemas that aren't registered in components
        default:        return { type: 'object', description: name };
      }
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
      if (meaningful.length === 1) return this.inferSchemaFromTypeNode(meaningful[0]);
    }

    return { type: 'object' };
  }
}
