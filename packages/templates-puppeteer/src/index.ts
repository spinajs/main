import { Page, LaunchOptions, ConsoleMessage, HTTPRequest, HTTPResponse } from 'puppeteer';
import { NotSupported } from '@spinajs/exceptions';
import { TemplateRenderer, Templates, IRenderOptions, RenderPhase, RenderProgressCallback } from '@spinajs/templates';
import { IInstanceCheck, LazyInject } from '@spinajs/di';
import { basename, dirname, join } from 'path';
import { Log, Logger } from '@spinajs/log';
import * as http from 'http';

import '@spinajs/templates-pug';
import { AddressInfo } from 'net';
import { RenderProgressReporter } from './progress.js';
import { LocalAssetServer } from './asset-server.js';
import { BrowserPool } from './browser-pool.js';

export * from './progress.js';
export * from './asset-server.js';
export * from './browser-pool.js';

export interface IPuppeteerRendererOptions {
  static: {
    portRange: number[];
  };
  args: LaunchOptions;

  /**
   * Optional path to Chrome/Chromium executable.
   * Useful when running in environments where Puppeteer cannot download Chromium.
   * If provided, overrides args.executablePath.
   */
  executablePath?: string;
  renderDurationWarning: number;
  navigationTimeout?: number;
  renderTimeout?: number;

  /**
   * Debug options
   */
  debug?: {

    /**
     * Controls whether the browser is closed after rendering.
     * Defaults to closing. Set to `false` to keep the browser open after rendering
     * for inspection ( use with headless: false in args to see the browser window ).
     */
    close?: boolean;
  }
}

/** Default navigation/render timeout when none is configured (ms). */
const DEFAULT_RENDER_TIMEOUT_MS = 30000;

/** Watchdog canceller used when timeouts are disabled (debug mode). */
const noop = () => {
  /* nothing to cancel */
};

export abstract class PuppeteerRenderer extends TemplateRenderer implements IInstanceCheck {
  protected abstract Options: IPuppeteerRendererOptions;

  /**
   * Per-instance options that give this renderer its identity for the DI
   * @PerInstanceCheck pooling (see subclasses). Renderers that are not pooled
   * per-instance inherit the `undefined` default.
   */
  protected get instanceOptions(): unknown {
    return undefined;
  }

  /**
   * DI @PerInstanceCheck hook: an existing instance is reused only when it was
   * created with the same options.
   */
  public __checkInstance__(creationOptions: any): boolean {
    return JSON.stringify(this.instanceOptions) === JSON.stringify(creationOptions);
  }

  @Logger('puppeteer-templates')
  protected Log: Log;

  @LazyInject()
  protected TemplatingService: Templates;

  private _assetServer?: LocalAssetServer;
  private _browserPool?: BrowserPool;

  /** Local static server used so Chromium can load relative asset URLs. Lazily created. */
  protected get assetServer(): LocalAssetServer {
    return (this._assetServer ??= new LocalAssetServer(this.Log, () => this.Options?.static?.portRange));
  }

  /**
   * Pooled browser, launched lazily and reused across renders, closed on dispose().
   * One pool per options-set (see @PerInstanceCheck on subclasses). Lazily created.
   */
  protected get browserPool(): BrowserPool {
    return (this._browserPool ??= new BrowserPool(this.Log, () => this.buildLaunchOptions()));
  }

  private buildLaunchOptions(): LaunchOptions {
    return {
      ...(this.Options?.args || {}),
      ...(this.Options?.executablePath && {
        executablePath: this.Options.executablePath,
      }),
    };
  }

  public async renderToFile(template: string, model: any, filePath: string, language?: string, options?: IRenderOptions): Promise<void> {
    const templateBasePath = dirname(template);

    await this.renderContentToFile(filePath, { assetBasePath: templateBasePath, onProgress: options?.onProgress }, async (page, httpPort, markLoading) => {
      const compiledTemplate = await this.TemplatingService.render(
        join(templateBasePath, basename(template, this.Extension)) + '.pug',
        {
          // add template temporary server port so templates can reference local images
          __http_template_port__: httpPort,
          // for convenience add full url to local http server
          __http_template_address__: `http://localhost:${httpPort}`,
          ...model,
        },
        language,
      );

      // template is compiled; resource loading starts with setContent
      markLoading();
      await page.setContent(compiledTemplate);
    });
  }

  /**
   * Render a raw HTML string to a file (image/pdf per the concrete renderer).
   * Intended for CI (e.g. screenshot comparison) where HTML is already produced.
   *
   * @param html - the HTML content to render
   * @param filePath - output file path
   * @param options.assetBasePath - directory served over the local http server so
   *   relative asset URLs in the HTML resolve (defaults to the output file's dir)
   * @param options.viewport - fixed viewport for deterministic captures
   */
  public async renderHtmlToFile(
    html: string,
    filePath: string,
    options?: {
      assetBasePath?: string;
      viewport?: { width: number; height: number; deviceScaleFactor?: number };
      onProgress?: RenderProgressCallback;
    },
  ): Promise<void> {
    await this.renderContentToFile(
      filePath,
      { assetBasePath: options?.assetBasePath ?? dirname(filePath), onProgress: options?.onProgress },
      async (page, httpPort, markLoading) => {
        if (options?.viewport) {
          await page.setViewport(options.viewport);
        }
        // resource loading starts with setContent
        markLoading();
        // inject a <base href> so relative asset URLs resolve via the local server
        await page.setContent(this.injectBaseHref(html, `http://127.0.0.1:${httpPort}/`));
      },
    );
  }

  /**
   * Shared render orchestration: local static server + pooled browser + page +
   * timeout watchdog + cleanup. `prepare` populates the page content (template-compiled
   * HTML, or raw HTML). The pooled browser survives; only the page is closed.
   */
  protected async renderContentToFile(
    filePath: string,
    opts: { assetBasePath?: string; onProgress?: RenderProgressCallback },
    prepare: (page: Page, httpPort: number, markLoading: () => void) => Promise<void>,
  ): Promise<void> {
    const timerLabel = `puppeteer-template-rendering-${filePath}`;
    const progress = new RenderProgressReporter(filePath, opts.onProgress);
    let server: http.Server = null as any;
    let page: Page = null as any;

    // When debug.close === false the page is intentionally kept open for
    // inspection, so timeouts must not be armed (the watchdog would close it).
    // The browser itself is pooled and only closed on dispose().
    const keepPageOpen = this.Options?.debug?.close === false;

    try {
      this.Log.timeStart(timerLabel);
      this.Log.trace(`Rendering to file ${filePath}`);
      progress.phase(RenderPhase.Starting);

      // fire up local http server for serving images etc, because chromium
      // prevents reading local files when not using the file:// protocol
      server = await this.assetServer.serve(opts.assetBasePath ?? process.cwd());
      const httpPort = (server.address() as AddressInfo).port;

      // reuse the pooled browser; open a fresh page per render
      const browser = await this.browserPool.acquire();
      page = await browser.newPage();
      progress.attach(page);

      // In debug mode neither timeouts nor the watchdog are armed, so the page
      // can be inspected indefinitely.
      const cancelWatchdog = keepPageOpen ? noop : this.armRenderWatchdog(page);
      if (!keepPageOpen) {
        this.configurePageTimeouts(page);
      }

      const removeListeners = this.addPageEventListeners(page);

      try {
        progress.phase(RenderPhase.Preparing);
        await page.setBypassCSP(true);
        // prepare compiles/builds the HTML then calls markLoading() right before
        // setContent, so template-compile time is separated from resource loading.
        await prepare(page, httpPort, () => progress.phase(RenderPhase.Loading));

        // perform the concrete rendering (PDF or image)
        progress.phase(RenderPhase.Rendering);
        await this.performRender(page, filePath);

        progress.phase(RenderPhase.Done);
      } catch (renderError) {
        this.Log.error(renderError, `Error during rendering for ${filePath}`);
        throw renderError;
      } finally {
        cancelWatchdog();
        removeListeners();
      }
    } catch (err) {
      progress.phase(RenderPhase.Failed, err?.message);
      this.Log.error(err, `Error rendering to file ${filePath}`);
      throw err;
    } finally {
      progress.dispose();

      const duration = this.Log.timeEnd(timerLabel);
      this.Log.trace(`Ended rendering to file ${filePath}, took: ${duration}ms`);
      this.warnIfSlow(filePath, duration);

      // Close the page (not the pooled browser). Skip if debug.close is false
      // so the rendered page can be inspected.
      if (page && !keepPageOpen) {
        await this.closePage(page);
      } else if (page) {
        this.Log.info('Page kept open for debugging (debug.close=false)');
      }

      if (server) {
        await this.assetServer.close(server);
      }
    }
  }

  /** Effective render timeout: configured value, else the default. */
  protected get renderTimeoutMs(): number {
    return this.Options?.renderTimeout || DEFAULT_RENDER_TIMEOUT_MS;
  }

  /** Apply the configured (or default) navigation and render timeouts to a page. */
  protected configurePageTimeouts(page: Page): void {
    page.setDefaultNavigationTimeout(this.Options?.navigationTimeout || DEFAULT_RENDER_TIMEOUT_MS);
    page.setDefaultTimeout(this.renderTimeoutMs);
  }

  /**
   * Arm a watchdog that closes the page if a render exceeds the configured
   * timeout - only the page is closed, the pooled browser may be serving other
   * concurrent renders. Returns a function that cancels the watchdog.
   */
  protected armRenderWatchdog(page: Page): () => void {
    const timeoutMs = this.renderTimeoutMs;
    const handle = setTimeout(() => {
      this.Log.warn(`Render timeout (${timeoutMs}ms) - closing page`);
      page.close().catch(() => { /* page may already be closing */ });
    }, timeoutMs);

    return () => clearTimeout(handle);
  }

  /** Warn if a render took longer than the configured warning threshold. */
  protected warnIfSlow(filePath: string, duration: number): void {
    if (this.Options && duration > this.Options.renderDurationWarning) {
      this.Log.warn(`Rendering to file ${filePath} took too long.`);
    }
  }

  /** Close a page, downgrading any close error to a warning (best-effort cleanup). */
  protected async closePage(page: Page): Promise<void> {
    await page.close().catch((err) => this.Log.warn(`Error closing page: ${err.message}`));
  }

  /**
   * Insert a <base href> into the HTML <head> so relative asset URLs resolve
   * against the local static server. No-op if the HTML already declares a <base>.
   */
  protected injectBaseHref(html: string, baseUrl: string): string {
    if (/<base\s/i.test(html)) {
      return html;
    }
    if (/<head[^>]*>/i.test(html)) {
      return html.replace(/<head([^>]*)>/i, `<head$1><base href="${baseUrl}">`);
    }
    if (/<html[^>]*>/i.test(html)) {
      return html.replace(/<html([^>]*)>/i, `<html$1><head><base href="${baseUrl}"></head>`);
    }
    return `<base href="${baseUrl}">${html}`;
  }

  /**
   * Close the pooled browser when the service is disposed (e.g. DI.dispose() at shutdown).
   * Callers that render one-shot (CLI, single email) should dispose so the process can exit.
   */
  public async dispose(): Promise<void> {
    if (this._browserPool) {
      await this._browserPool.dispose();
    }

    await super.dispose();
  }

  /**
   * Abstract method to perform specific rendering (PDF or image)
   */
  protected abstract performRender(page: Page, filePath: string): Promise<void>;

  public async render(_templateName: string, _model: unknown, _language?: string): Promise<string> {
    throw new NotSupported('cannot render puppeteer template to string');
  }

  /**
   * Add page event listeners with cleanup function
   */
  protected addPageEventListeners(page: Page): () => void {
    const listeners = {
      console: (message: ConsoleMessage) => this.Log.trace(`${message.type().slice(0, 3).toUpperCase()} ${message.text()}`),
      pageerror: (error: Error) => this.Log.error(error.message),
      response: (response: HTTPResponse) => this.Log.trace(`${response.status()} ${response.url()}`),
      requestfailed: (request: HTTPRequest) => {
        const failure = request.failure();
        this.Log.error(`${failure ? failure.errorText : 'request failed'} ${request.url()}`);
      }
    };

    // Add listeners
    page.on('console', listeners.console);
    page.on('pageerror', listeners.pageerror);
    page.on('response', listeners.response);
    page.on('requestfailed', listeners.requestfailed);

    // Return cleanup function
    return () => {
      try {
        page.off('console', listeners.console);
        page.off('pageerror', listeners.pageerror);
        page.off('response', listeners.response);
        page.off('requestfailed', listeners.requestfailed);
      } catch (err) {
        this.Log.warn(`Error removing page listeners: ${err.message}`);
      }
    };
  }
}
