import { Browser, Page, default as puppeteer, LaunchOptions } from 'puppeteer';
import { NotSupported } from '@spinajs/exceptions';
import { TemplateRenderer, Templates } from '@spinajs/templates';
import { LazyInject } from '@spinajs/di';
import { basename, dirname, join } from 'path';
import { Log, Logger } from '@spinajs/log';
import Express from 'express';
import * as http from 'http';
import cors from 'cors';

import '@spinajs/templates-pug';
import _ from 'lodash';
import { AddressInfo } from 'net';

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

export abstract class PuppeteerRenderer extends TemplateRenderer {
  protected abstract Options: IPuppeteerRendererOptions;

  @Logger('puppeteer-templates')
  protected Log: Log;

  @LazyInject()
  protected TemplatingService: Templates;

  /**
   * Pooled browser instance, launched lazily and reused across renders.
   * Closed only on dispose(). One instance per options-set (see @PerInstanceCheck on subclasses).
   */
  protected pooledBrowser: Browser | null = null;

  /**
   * In-flight launch, shared by concurrent first-renders so we only ever launch one browser.
   */
  private browserLaunchPromise: Promise<Browser> | null = null;

  /**
   * Returns the pooled browser, launching it on first use and relaunching
   * if it has crashed/disconnected. Concurrent callers share one launch.
   */
  protected async getBrowser(): Promise<Browser> {
    if (this.pooledBrowser?.connected) {
      return this.pooledBrowser;
    }

    // drop a disconnected/crashed browser so we relaunch a fresh one
    this.pooledBrowser = null;

    if (!this.browserLaunchPromise) {
      const launchOptions: LaunchOptions = {
        ...(this.Options?.args || {}),
        ...(this.Options?.executablePath && {
          executablePath: this.Options.executablePath,
        }),
      };

      this.browserLaunchPromise = puppeteer
        .launch(launchOptions)
        .then((b) => (this.pooledBrowser = b))
        // reset so a failed launch is retried on the next call
        .finally(() => (this.browserLaunchPromise = null));
    }

    return this.browserLaunchPromise;
  }

  public async renderToFile(template: string, model: any, filePath: string, language?: string): Promise<void> {
    const templateBasePath = dirname(template);

    await this.renderContentToFile(filePath, { assetBasePath: templateBasePath }, async (page, httpPort) => {
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
    },
  ): Promise<void> {
    await this.renderContentToFile(
      filePath,
      { assetBasePath: options?.assetBasePath ?? dirname(filePath) },
      async (page, httpPort) => {
        if (options?.viewport) {
          await page.setViewport(options.viewport);
        }
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
    opts: { assetBasePath?: string },
    prepare: (page: Page, httpPort: number) => Promise<void>,
  ): Promise<void> {
    let server: http.Server = null as any;
    let page: Page = null as any;

    // When debug.close === false the page is intentionally kept open for
    // inspection, so timeouts must not be armed (the watchdog would close it).
    // The browser itself is pooled and only closed on dispose().
    const keepPageOpen = this.Options?.debug?.close === false;

    try {
      this.Log.timeStart(`puppeteer-template-rendering-${filePath}`);
      this.Log.trace(`Rendering to file ${filePath}`);

      // fire up local http server for serving images etc, because chromium
      // prevents reading local files when not using the file:// protocol
      server = await this.runLocalServer(opts.assetBasePath ?? process.cwd());
      const httpPort = (server.address() as AddressInfo).port;

      // reuse the pooled browser; open a fresh page per render
      const browser = await this.getBrowser();
      page = await browser.newPage();

      // Skip timeouts in debug mode
      if (!keepPageOpen) {
        page.setDefaultNavigationTimeout(this.Options?.navigationTimeout || 30000); // Default 30s
        page.setDefaultTimeout(this.Options?.renderTimeout || 30000); // Default 30s
      }

      // Set up render timeout (skip in debug mode). On timeout close only the
      // page - the pooled browser may be serving other concurrent renders.
      let renderTimeout: NodeJS.Timeout | undefined;
      if (!keepPageOpen) {
        const timeoutMs = this.Options?.renderTimeout || 30000;
        renderTimeout = setTimeout(() => {
          this.Log.warn(`Render timeout (${timeoutMs}ms) - closing page`);
          if (page) {
            page.close().catch(() => { /* page may already be closing */ });
          }
        }, timeoutMs);
      }

      // Add event listeners with explicit cleanup tracking
      const eventCleanup = this.addPageEventListeners(page);

      try {
        await page.setBypassCSP(true);
        await prepare(page, httpPort);

        // Call abstract method to perform specific rendering (PDF or image)
        await this.performRender(page, filePath);

        // Clear timeout on successful completion
        if (renderTimeout) {
          clearTimeout(renderTimeout);
          renderTimeout = undefined;
        }

        // Clean up event listeners
        eventCleanup();

      } catch (renderError) {
        // Clear timeout on error
        if (renderTimeout) {
          clearTimeout(renderTimeout);
          renderTimeout = undefined;
        }
        this.Log.error(renderError, `Error during rendering for ${filePath}`);
        throw renderError;
      }
    } catch (err) {
      this.Log.error(err, `Error rendering to file ${filePath}`);
      throw err;
    } finally {
      const duration = this.Log.timeEnd(`puppeteer-template-rendering-${filePath}`);
      this.Log.trace(`Ended rendering to file ${filePath}, took: ${duration}ms`);

      if (this.Options && duration > this.Options.renderDurationWarning) {
        this.Log.warn(`Rendering to file ${filePath} took too long.`);
      }

      // Close the page (not the pooled browser). Skip if debug.close is false
      // so the rendered page can be inspected.
      if (page && !keepPageOpen) {
        await page.close().catch((err) => this.Log.warn(`Error closing page: ${err.message}`));
      } else if (page) {
        this.Log.info('Page kept open for debugging (debug.close=false)');
      }

      if (server) {
        await this.safeServerCleanup(server);
      }
    }
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
    if (this.pooledBrowser) {
      await this.safeBrowserCleanup(this.pooledBrowser);
      this.pooledBrowser = null;
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

  // no compilation at start
  protected async compile(_path: string) { }

  protected async runLocalServer(basePath: string): Promise<http.Server> {
    const range = this.Options?.static?.portRange;
    const hasRange = !!range && range.length > 0;

    // With an OS-assigned port (0) a free port is guaranteed, so a single
    // attempt suffices. With a configured range a random pick can collide, so
    // retry on EADDRINUSE with a different port.
    const maxAttempts = hasRange ? 10 : 1;
    let lastErr: any;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const port = hasRange ? _.random(range![0], range![1]) : 0;

      try {
        return await this.listenOnce(basePath, port);
      } catch (err: any) {
        lastErr = err;

        if (err?.code === 'EADDRINUSE' && hasRange) {
          this.Log.trace(`Puppeteer image server port ${port} in use, retrying (${attempt + 1}/${maxAttempts})`);
          continue;
        }

        throw err;
      }
    }

    this.Log.error(lastErr, `Puppeteer image server cannot start - no free port in range after ${maxAttempts} attempts`);
    throw lastErr;
  }

  /**
   * Single attempt to start the static server on the given port (0 = OS-assigned).
   * Bound to loopback so the served template dir is not network-exposed.
   */
  protected listenOnce(basePath: string, port: number): Promise<http.Server> {
    const self = this;
    const app = Express();
    app.use(cors());
    app.use(Express.static(basePath));

    return new Promise((resolve, reject) => {
      const server = app
        .listen(port, '127.0.0.1')
        .on('listening', function () {
          self.Log.trace(`Puppeteer image server started on port ${(this.address() as AddressInfo).port}`);
          self.Log.trace(`Puppeteer static file dir at ${basePath}`);
          resolve(this);
        })
        .on('error', (err: any) => {
          // Clean up the failed server, then reject so the caller can retry.
          if (server) {
            server.close(() => reject(err));
          } else {
            reject(err);
          }
        });

      // Set a timeout for server startup
      setTimeout(() => {
        if (!server.listening) {
          server.close();
          reject(new Error('Server startup timeout'));
        }
      }, 10000);
    });
  }

  /**
   * Enhanced browser cleanup with error handling
   */
  protected async safeBrowserCleanup(browser: Browser): Promise<void> {
    try {
      // First try to close all pages
      const pages = await browser.pages();
      await Promise.allSettled(pages.map(page => page.close()));

      // Then close the browser normally
      await browser.close();
    } catch (err) {
      this.Log.warn(`Error during normal browser cleanup: ${err.message}`);

      // Force kill if normal close fails
      try {
        await this.forceCloseBrowser(browser);
      } catch (killErr) {
        this.Log.error(`Failed to force kill browser: ${killErr.message}`);
      }
    }
  }

  /**
   * Force close browser with process termination
   */
  protected async forceCloseBrowser(browser: Browser): Promise<void> {
    try {
      const process = browser.process();
      if (process) {
        process.kill('SIGKILL');
        this.Log.warn('Browser process force killed');
      }
    } catch (err) {
      this.Log.error(`Error force killing browser process: ${err.message}`);
    }
  }

  /**
   * Enhanced server cleanup with timeout
   */
  protected async safeServerCleanup(server: http.Server): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Server close timeout'));
        }, 5000);

        server.close((err) => {
          clearTimeout(timeout);
          if (err) reject(err);
          else resolve();
        });
      });
    } catch (err) {
      this.Log.warn(`Error closing server: ${err.message}`);

      // Force close connections if available
      try {
        if ('closeAllConnections' in server) {
          (server as any).closeAllConnections();
        }
      } catch (forceErr) {
        this.Log.error(`Error force closing server connections: ${forceErr.message}`);
      }
    }
  }

  /**
   * Add page event listeners with cleanup function
   */
  protected addPageEventListeners(page: any): () => void {
    const listeners = {
      console: (message: any) => this.Log.trace(`${message.type().substr(0, 3).toUpperCase()} ${message.text()}`),
      pageerror: ({ message }: any) => this.Log.error(message),
      response: (response: any) => this.Log.trace(`${response.status()} ${response.url()}`),
      requestfailed: (request: any) => {
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
        page.removeListener('console', listeners.console);
        page.removeListener('pageerror', listeners.pageerror);
        page.removeListener('response', listeners.response);
        page.removeListener('requestfailed', listeners.requestfailed);
      } catch (err) {
        this.Log.warn(`Error removing page listeners: ${err.message}`);
      }
    };
  }
}
