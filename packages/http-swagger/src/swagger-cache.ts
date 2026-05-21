import ts from 'typescript';
import { resolve as resolvePath } from 'path';
import { AsyncService, Autoinject, ClassInfo, Singleton } from '@spinajs/di';
import { fs as fFs, FileHasher, FileSystem } from '@spinajs/fs';
import { BaseController } from '@spinajs/http';
import { Logger, Log } from '@spinajs/log';
import { ISwaggerCacheEntry, IMethodDocumentation, IExampleDocumentation, IOpenApiSchema } from './interfaces.js';

/**
 * Cache for JSDoc documentation extracted from controller source files.
 * Parses TypeScript declaration files to extract JSDoc comments from controller methods.
 */
@Singleton()
export class SwaggerDocCache extends AsyncService {
  @Logger('http-swagger')
  protected Log!: Log;

  @FileSystem('__fs_swagger_cache__')
  protected CacheFS!: fFs;

  @Autoinject(FileHasher)
  protected Hasher!: FileHasher;

  public async resolve() {
    await super.resolve();
    this.Log.info(`Swagger doc cache dir is: ${this.CacheFS.resolvePath('')}`);
  }

  /**
   * Get JSDoc documentation cache for a controller.
   * If cache doesn't exist, generates it from source file.
   */
  public async getCache(controller: ClassInfo<BaseController>): Promise<ISwaggerCacheEntry> {
    const file = controller.file.replace('.js', '.d.ts');
    const hash = `swagger_${await this.Hasher.hash(file)}`;

    const exists = await this.CacheFS.exists(hash);
    if (!exists) {
      this.Log.info(`Swagger cache not found for ${controller.name}, generating...`);
      const entry = this.extractDocumentation(file, controller.name);
      await this.CacheFS.write(hash, JSON.stringify(entry));
      return entry;
    }

    const content = await this.CacheFS.read(hash) as string
    return JSON.parse(content) as ISwaggerCacheEntry;
  }

  /**
   * Extract JSDoc documentation from a TypeScript source file for a given class.
   */
  private extractDocumentation(file: string, className: string): ISwaggerCacheEntry {
    // Normalize path so getSourceFile can find it (glob returns forward-slash paths on Windows)
    const normalizedFile = resolvePath(file);
    const program = ts.createProgram([normalizedFile], {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.Latest,
      noResolve: true,
      skipLibCheck: true,
    });

    const sourceFile = program.getSourceFile(normalizedFile);
    if (!sourceFile) {
      this.Log.warn(`Could not parse source file: ${file}`);
      return { className, methods: {} };
    }

    const entry: ISwaggerCacheEntry = {
      className,
      methods: {},
    };

    ts.forEachChild(sourceFile, (node) => {
      if (ts.isClassDeclaration(node) && node.name?.text === className) {
        // Extract class-level JSDoc
        const classDoc = this.getJSDocComment(node);
        if (classDoc) {
          entry.classDescription = classDoc;
        }

        const classTags = this.getJSDocTagValues(node, 'tags') || this.getJSDocTagValues(node, 'category');
        if (classTags) {
          entry.classTags = classTags.split(',').map((t) => t.trim());
        }

        // Extract method-level JSDoc
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member) && member.name) {
            const methodName = (member.name as ts.Identifier).text || (member.name as any).escapedText;
            if (!methodName) continue;

            const methodDoc = this.extractMethodDocumentation(member);
            if (methodDoc) {
              entry.methods[methodName] = methodDoc;
            }
          }
        }
      }
    });

    return entry;
  }

  /**
   * Extract all JSDoc information from a single method declaration.
   */
  private extractMethodDocumentation(method: ts.MethodDeclaration): IMethodDocumentation {
    const doc: IMethodDocumentation = {
      params: {},
    };

    // Get the main description/summary from the JSDoc comment block
    const comment = this.getJSDocComment(method);
    if (comment) {
      // First line is summary, rest is description
      const lines = comment.split('\n');
      doc.summary = lines[0].trim();
      if (lines.length > 1) {
        doc.description = lines.slice(1).join('\n').trim() || undefined;
      }
    }

    // Infer return schema from TypeScript return type annotation
    if (method.type) {
      const schema = this.inferSchemaFromTypeNode(method.type);
      if (!doc.returns) doc.returns = {};
      doc.returns.schema = schema;
    }

    // Get JSDoc tags from the method using raw access (ts.getJSDocTags can return
    // empty arrays when program is created with noResolve: true)
    const jsDocs = this.getRawJSDocTags(method);

    for (const tag of jsDocs) {
      const tagName = tag.tagName.text;

      switch (tagName) {
        case 'param': {
          const paramTag = tag as ts.JSDocParameterTag;
          const paramName = paramTag.name ? (ts.isIdentifier(paramTag.name) ? paramTag.name.text : paramTag.name.getText()) : '';
          if (paramName) {
            doc.params[paramName] = {
              name: paramName,
              description: this.getTagComment(tag)?.trim(),
              type: paramTag.typeExpression ? paramTag.typeExpression.getText() : undefined,
            };
          }
          break;
        }
        case 'returns':
        case 'return': {
          doc.returns = {
            description: this.getTagComment(tag),
            type: (tag as ts.JSDocReturnTag).typeExpression?.getText(),
          };
          break;
        }
        case 'example': {
          const example = this.parseExample(tag);
          if (example) {
            if (!doc.examples) doc.examples = [];
            doc.examples.push(example);
          }
          break;
        }
        case 'tags':
        case 'tag':
        case 'category': {
          const tagValue = this.getTagComment(tag);
          if (tagValue) {
            doc.tags = tagValue.split(',').map((t) => t.trim());
          }
          break;
        }
        case 'deprecated': {
          doc.deprecated = true;
          break;
        }
        case 'response': {
          const comment = this.getTagComment(tag);
          if (comment) {
            const spaceIdx = comment.indexOf(' ');
            if (spaceIdx > 0) {
              const statusCode = comment.substring(0, spaceIdx).trim();
              const description = comment.substring(spaceIdx + 1).trim();
              if (/^\d+$/.test(statusCode)) {
                if (!doc.responses) doc.responses = {};
                doc.responses[statusCode] = { description };
              }
            }
          }
          break;
        }
        case 'summary': {
          // Override summary if explicitly provided via @summary
          const summaryValue = this.getTagComment(tag);
          if (summaryValue) {
            doc.summary = summaryValue;
          }
          break;
        }
      }
    }

    return doc;
  }

  /**
   * Get the text content of a JSDoc comment block (excluding tags).
   */
  private getJSDocComment(node: ts.Node): string | undefined {
    const jsDocs = (node as any).jsDoc as ts.JSDoc[] | undefined;
    if (!jsDocs || jsDocs.length === 0) return undefined;

    const jsDoc = jsDocs[0];
    if (!jsDoc.comment) return undefined;

    if (typeof jsDoc.comment === 'string') {
      return jsDoc.comment;
    }

    // Handle JSDocComment node parts
    if (Array.isArray(jsDoc.comment)) {
      return jsDoc.comment.map((part: any) => {
        if (typeof part === 'string') return part;
        if (part.text) return part.text;
        return '';
      }).join('');
    }

    return undefined;
  }

  /**
   * Get a specific JSDoc tag value from a node using raw jsDoc access.
   * Note: ts.getJSDocTags() can return empty arrays when noResolve is used;
   * direct access to (node as any).jsDoc is more reliable.
   */
  private getJSDocTagValues(node: ts.Node, tagName: string): string | undefined {
    const rawJsDocs = (node as any).jsDoc as ts.JSDoc[] | undefined;
    if (!rawJsDocs) return undefined;
    for (const jsDoc of rawJsDocs) {
      if (!jsDoc.tags) continue;
      const found = Array.from(jsDoc.tags).find((t) => t.tagName?.text === tagName);
      if (found) return this.getTagComment(found);
    }
    return undefined;
  }

  /**
   * Get all JSDoc tags from a node using raw jsDoc access.
   */
  private getRawJSDocTags(node: ts.Node): ts.JSDocTag[] {
    const rawJsDocs = (node as any).jsDoc as ts.JSDoc[] | undefined;
    if (!rawJsDocs) return [];
    const result: ts.JSDocTag[] = [];
    for (const jsDoc of rawJsDocs) {
      if (jsDoc.tags) {
        result.push(...Array.from(jsDoc.tags));
      }
    }
    return result;
  }

  /**
   * Extract the text comment from a JSDoc tag.
   */
  private getTagComment(tag: ts.JSDocTag): string | undefined {
    if (!tag.comment) return undefined;

    if (typeof tag.comment === 'string') {
      return tag.comment;
    }

    if (Array.isArray(tag.comment)) {
      return (tag.comment as ts.NodeArray<ts.JSDocComment>)
        .map((part: any) => {
          if (typeof part === 'string') return part;
          if (part.text) return part.text;
          return '';
        })
        .join('');
    }

    return undefined;
  }

  /**
   * Parse an @example tag into a structured example object.
   * Supports format:
   *   @example <caption>Example Name</caption>
   *   { "key": "value" }
   */
  private parseExample(tag: ts.JSDocTag): IExampleDocumentation | undefined {
    const comment = this.getTagComment(tag);
    if (!comment) return undefined;

    const example: IExampleDocumentation = {};

    // Check for <caption>...</caption> pattern
    const captionMatch = comment.match(/<caption>(.*?)<\/caption>/s);
    if (captionMatch) {
      example.name = captionMatch[1].trim();
      example.value = comment.replace(captionMatch[0], '').trim();
    } else {
      example.value = comment.trim();
    }

    return example;
  }

  /**
   * Infer an OpenAPI schema from a TypeScript type node in the AST.
   * Handles keyword types, arrays, type literals, and type references.
   * Transparent wrappers (Promise, Ok) are unwrapped automatically.
   */
  private inferSchemaFromTypeNode(typeNode: ts.TypeNode): IOpenApiSchema {
    switch (typeNode.kind) {
      case ts.SyntaxKind.StringKeyword:
        return { type: 'string' };
      case ts.SyntaxKind.NumberKeyword:
        return { type: 'number' };
      case ts.SyntaxKind.BooleanKeyword:
        return { type: 'boolean' };
      case ts.SyntaxKind.VoidKeyword:
      case ts.SyntaxKind.UndefinedKeyword:
      case ts.SyntaxKind.NullKeyword:
      case ts.SyntaxKind.AnyKeyword:
      case ts.SyntaxKind.UnknownKeyword:
      case ts.SyntaxKind.ObjectKeyword:
        return { type: 'object' };
    }

    // T[]
    if (ts.isArrayTypeNode(typeNode)) {
      return { type: 'array', items: this.inferSchemaFromTypeNode(typeNode.elementType) };
    }

    // Named / generic type reference
    if (ts.isTypeReferenceNode(typeNode)) {
      const name = ts.isIdentifier(typeNode.typeName)
        ? typeNode.typeName.text
        : (typeNode.typeName as ts.QualifiedName).right.text;

      // Unwrap transparent wrappers
      if ((name === 'Promise' || name === 'Ok') && typeNode.typeArguments?.length) {
        return this.inferSchemaFromTypeNode(typeNode.typeArguments[0]);
      }

      if (name === 'Array' && typeNode.typeArguments?.length) {
        return { type: 'array', items: this.inferSchemaFromTypeNode(typeNode.typeArguments[0]) };
      }

      switch (name) {
        case 'string': return { type: 'string' };
        case 'number': return { type: 'number' };
        case 'boolean': return { type: 'boolean' };
        default:
          return { $ref: `#/components/schemas/${name}` };
      }
    }

    // Inline object literal { prop: type; ... }
    if (ts.isTypeLiteralNode(typeNode)) {
      const properties: Record<string, IOpenApiSchema> = {};
      const required: string[] = [];

      for (const member of typeNode.members) {
        if (ts.isPropertySignature(member) && ts.isIdentifier(member.name) && member.type) {
          const propName = member.name.text;
          properties[propName] = this.inferSchemaFromTypeNode(member.type);
          if (!member.questionToken) required.push(propName);
        }
      }

      const schema: IOpenApiSchema = { type: 'object', properties };
      if (required.length) schema.required = required;
      return schema;
    }

    // A | B — strip null/undefined, use first remaining type
    if (ts.isUnionTypeNode(typeNode)) {
      const meaningful = typeNode.types.filter(
        (t) => t.kind !== ts.SyntaxKind.NullKeyword && t.kind !== ts.SyntaxKind.UndefinedKeyword,
      );
      if (meaningful.length === 1) return this.inferSchemaFromTypeNode(meaningful[0]);
    }

    return { type: 'object' };
  }
}
