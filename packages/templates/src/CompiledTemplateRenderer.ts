import { InvalidArgument } from '@spinajs/exceptions';
import { guessLanguage, defaultLanguage } from '@spinajs/intl';
import * as fs from 'fs';
import * as path from 'path';
import { normalize } from 'path';
import { TemplateRenderer } from './interfaces.js';

/**
 * A compiled template delegate: takes a locals/context object and returns the
 * rendered string. Both pug's `compileTemplate` and handlebars' template
 * delegate satisfy this shape.
 */
export type CompiledTemplate = (locals: any) => string;

/**
 * Base class for template engines that compile a template file into a reusable
 * delegate and cache it (pug, handlebars). It captures the render skeleton -
 * validation, lazy compile + caching, language resolution, timing/logging and
 * writing to file - leaving engines to supply only what actually differs:
 *
 *  - {@link buildContext} - the locals object passed to the compiled delegate
 *    (model merged with engine-specific helpers).
 *  - {@link compile} - how a template file is compiled and cached.
 *  - {@link shouldRecompile} - whether to bypass the cache (e.g. dev mode).
 */
export abstract class CompiledTemplateRenderer<TDelegate extends CompiledTemplate = CompiledTemplate> extends TemplateRenderer {
  protected Templates: Map<string, TDelegate> = new Map<string, TDelegate>();

  public async renderToFile(template: string, model: unknown, filePath: string, language?: string): Promise<void> {
    const content = await this.render(template, model, language);
    const dir = path.dirname(filePath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, content);
  }

  public async render(templateName: string, model: unknown, language?: string): Promise<string> {
    if (!templateName) {
      throw new InvalidArgument('template parameter cannot be null or empty');
    }

    const label = `${this.constructor.name}.render.${templateName}`;
    this.Log.trace(`Rendering template ${templateName}`);
    this.Log.timeStart(label);

    const normalized = normalize(templateName);
    if (!this.Templates.has(normalized) || this.shouldRecompile()) {
      await this.compile(normalized);
    }

    const compiled = this.Templates.get(normalized)!;
    const content = compiled(this.buildContext(model, this.resolveLanguage(language)));

    const time = this.Log.timeEnd(label);
    this.Log.trace(`Rendering template ${templateName} ended, (${time} ms)`);

    return content;
  }

  /**
   * Effective language for a render: explicit argument, else the ambient
   * (async-context) language, else the framework default.
   */
  protected resolveLanguage(language?: string): string {
    return (language ? language : guessLanguage()) ?? defaultLanguage();
  }

  /**
   * Whether a cached template must be recompiled on every render. Defaults to
   * `false`; engines can override to force recompilation in dev mode.
   */
  protected shouldRecompile(): boolean {
    return false;
  }

  /**
   * Build the locals object passed to the compiled template - the model merged
   * with any engine-specific helpers (translation functions, `lang`, ...).
   */
  protected abstract buildContext(model: unknown, language: string): Record<string, unknown>;

  /**
   * Compile the template at `path` and store the resulting delegate in
   * {@link Templates}, keyed by the (already normalized) path.
   */
  protected abstract compile(path: string): Promise<void>;
}
