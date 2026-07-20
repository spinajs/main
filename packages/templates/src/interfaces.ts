import { IMappableService } from '@spinajs/di';
import { AsyncService } from '@spinajs/di';
import { Logger, Log } from '@spinajs/log';
import { fs, IStat, URI } from '@spinajs/fs';
import { readFile, stat as localStat } from 'fs/promises';
import { normalize } from 'path';

/**
 * How aggressively compiled templates are reused.
 *
 * cache      - compile once, reuse forever. Default.
 * revalidate - stat() the source and recompile only when its change token differs.
 * always     - recompile on every render.
 */
export type TemplateCacheMode = 'cache' | 'revalidate' | 'always';

export interface ITemplateCacheEntry {
  compiled: unknown;

  /**
   * Change token captured when this entry was compiled. Null when the mode does
   * not track one, or when the source could not be stat-ed.
   */
  token: string | null;
}

export abstract class TemplateRenderer extends AsyncService implements IMappableService {
  @Logger('renderer')
  protected Log: Log;

  @Config('templates.cache.mode')
  protected ConfiguredCacheMode: TemplateCacheMode;

  @Config('configuration.isDevelopment', { defaultValue: false })
  protected DevMode: boolean;

  protected Cache: Map<string, ITemplateCacheEntry> = new Map<string, ITemplateCacheEntry>();

  public abstract get Type(): string;

  public abstract get Extension(): string;

  public get ServiceName() {
    // we map this service by extension
    return this.Extension;
  }

  public abstract render(templatePath: string, model: unknown, language?: string, options?: IRenderOptions): Promise<string>;
  public abstract renderToFile(templatePath: string, model: unknown, filePath: string, language?: string, options?: IRenderOptions): Promise<void>;

  /**
   * Explicit config wins; otherwise dev mode implies always-recompile.
   */
  protected get CacheMode(): TemplateCacheMode {
    if (this.ConfiguredCacheMode) {
      return this.ConfiguredCacheMode;
    }

    return this.DevMode ? 'always' : 'cache';
  }

  protected isUri(template: string): boolean {
    return /^fs:\/\//.test(template);
  }

  /**
   * Bare paths are normalized as before. URIs must be left alone - path.normalize
   * would turn fs://name/x into fs:\name\x on windows and break URI parsing.
   */
  protected normalizeTemplate(template: string): string {
    return this.isUri(template) ? template : normalize(template);
  }

  /**
   * Template source as text. Bare paths read from local disk exactly as before -
   * routing them through the default provider would re-resolve relative paths
   * against its basePath and break existing callers.
   */
  protected async resolveContent(template: string): Promise<string> {
    if (!this.isUri(template)) {
      return await readFile(template, 'utf-8');
    }

    const content = await fs.read(new URI(template), 'utf-8');
    return Buffer.isBuffer(content) ? content.toString('utf-8') : content;
  }

  /**
   * A real local path. For renderers that cannot compile from a string (pug),
   * remote sources are materialised to temp storage.
   */
  protected async resolveLocalPath(template: string): Promise<string> {
    if (!this.isUri(template)) {
      return template;
    }

    return await fs.download(new URI(template));
  }

  /**
   * Opaque token that changes when the source changes. Null means "cannot tell" -
   * callers must then trust whatever they already have cached.
   */
  protected async changeToken(template: string): Promise<string | null> {
    try {
      if (this.isUri(template)) {
        return this.tokenFromStat(await fs.stat(new URI(template)));
      }

      const s = await localStat(template);
      return `${s.mtimeMs}|${s.size}`;
    } catch (err) {
      this.Log.warn(`Cannot stat template ${template}, serving cached version. ${err}`);
      return null;
    }
  }

  protected tokenFromStat(s: IStat): string {
    if (s.Version) {
      return s.Version;
    }

    return `${s.ModifiedTime?.toMillis() ?? 0}|${s.Size ?? 0}`;
  }

  /**
   * Compiled-template cache honouring CacheMode. `compile` runs only on a miss.
   */
  protected async withCache<T>(template: string, compile: () => Promise<T>): Promise<T> {
    const mode = this.CacheMode;

    if (mode === 'always') {
      return await compile();
    }

    const key = this.normalizeTemplate(template);
    const entry = this.Cache.get(key);
    let token: string | null = null;

    if (mode === 'revalidate') {
      token = await this.changeToken(template);

      // null token => stat failed; prefer a stale entry over failing the render
      if (entry && (token === null || token === entry.token)) {
        return entry.compiled as T;
      }
    } else if (entry) {
      return entry.compiled as T;
    }

    const compiled = await compile();
    this.Cache.set(key, { compiled, token });

    return compiled;
  }
}
