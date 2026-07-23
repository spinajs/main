import { InvalidArgument } from '@spinajs/exceptions';
import { guessLanguage, defaultLanguage } from '@spinajs/intl';
import * as fs from 'fs';
import { TemplateRenderer } from './interfaces.js';
import { ensureParentDir } from './io.js';

/**
 * A compiled template delegate: takes a locals/context object and returns the
 * rendered string. Both pug's `compileTemplate` and handlebars' template
 * delegate satisfy this shape.
 */
export type CompiledTemplate = (locals: any) => string;

/**
 * Base class for template engines that compile a template file into a reusable
 * delegate (pug, handlebars). It captures the render skeleton - validation,
 * lazy compile + caching, language resolution, timing/logging and writing to
 * file - leaving engines to supply only what actually differs:
 *
 *  - {@link buildContext} - the locals object passed to the compiled delegate
 *    (model merged with engine-specific helpers).
 *  - {@link compile} - how a template source is compiled into a delegate.
 *
 * Caching (including dev-mode recompilation) is owned by the base
 * {@link TemplateRenderer.withCache} machinery, not this class.
 */
export abstract class CompiledTemplateRenderer<TDelegate extends CompiledTemplate = CompiledTemplate> extends TemplateRenderer {
  public async renderToFile(template: string, model: unknown, filePath: string, language?: string): Promise<void> {
    const content = await this.render(template, model, language);
    ensureParentDir(filePath);
    fs.writeFileSync(filePath, content);
  }

  public async render(templateName: string, model: unknown, language?: string): Promise<string> {
    if (!templateName) {
      throw new InvalidArgument('template parameter cannot be null or empty');
    }

    const label = `${this.constructor.name}.render.${templateName}`;
    this.Log.trace(`Rendering template ${templateName}`);
    this.Log.timeStart(label);

    const delegate = await this.withCache(templateName, () => this.compile(templateName));
    const content = delegate(this.buildContext(model, this.resolveLanguage(language)));

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
   * Build the locals object passed to the compiled template - the model merged
   * with any engine-specific helpers (translation functions, `lang`, ...).
   */
  protected abstract buildContext(model: unknown, language: string): Record<string, unknown>;

  /**
   * Compile the template identified by `template` (a bare path or `fs://` URI)
   * into a reusable delegate. Called only on a cache miss; the returned delegate
   * is cached by {@link TemplateRenderer.withCache}.
   */
  protected abstract compile(template: string): Promise<TDelegate>;
}
