import ts from 'typescript';
import { AsyncService, Autoinject, ClassInfo, Singleton } from '@spinajs/di';
import { fs as fFs, FileHasher, FileSystem } from '@spinajs/fs';
import { BaseController } from '@spinajs/http';
import { Logger, Log } from '@spinajs/log';
import { ISwaggerCacheEntry, IMethodDocumentation, IExampleDocumentation } from './interfaces.js';

/**
 * Cache for JSDoc documentation extracted from controller source files.
 * Parses TypeScript declaration files to extract JSDoc comments from controller methods.
 */
@Singleton()
export class SwaggerDocCache extends AsyncService {
  @Logger('http-swagger')
  protected Log: Log;

  @FileSystem('__fs_swagger_cache__')
  protected CacheFS: fFs;

  @Autoinject(FileHasher)
  protected Hasher: FileHasher;

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

    return await this.CacheFS.read(hash).then((x: string) => JSON.parse(x) as ISwaggerCacheEntry);
  }

  /**
   * Extract JSDoc documentation from a TypeScript source file for a given class.
   */
  private extractDocumentation(file: string, className: string): ISwaggerCacheEntry {
    const program = ts.createProgram([file], {
      module: ts.ModuleKind.NodeNext,
      target: ts.ScriptTarget.Latest,
    });

    const sourceFile = program.getSourceFile(file);
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

    // Get JSDoc tags from the method
    const jsDocs = ts.getJSDocTags(method);

    for (const tag of jsDocs) {
      const tagName = tag.tagName.text;

      switch (tagName) {
        case 'param': {
          const paramTag = tag as ts.JSDocParameterTag;
          const paramName = paramTag.name ? (ts.isIdentifier(paramTag.name) ? paramTag.name.text : paramTag.name.getText()) : '';
          if (paramName) {
            doc.params[paramName] = {
              name: paramName,
              description: this.getTagComment(tag),
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
   * Get a specific JSDoc tag value from a node.
   */
  private getJSDocTagValues(node: ts.Node, tagName: string): string | undefined {
    const tags = ts.getJSDocTags(node);
    const found = tags.find((t) => t.tagName.text === tagName);
    if (!found) return undefined;
    return this.getTagComment(found);
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
}
