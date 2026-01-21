import { Browser, Page, LaunchOptions, default as puppeteer } from 'puppeteer';
import { TemplateRenderer, Templates } from '@spinajs/templates';
import { Config } from '@spinajs/configuration';
import { LazyInject } from '@spinajs/di';
import { basename, dirname, join } from 'path';
import { Log, Logger } from '@spinajs/log';
import Express from 'express';
import * as http from 'http';
import cors from 'cors';
import _ from 'lodash';
import { AddressInfo } from 'net';

export interface IPdfRendererOptions {
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
     * If true, browser will remain open after rendering for inspection
     * Use it with headless: false in args to see the browser window ( puppetter.launch args )
     */
    close?: boolean;
  };
}

export interface RenderContext {
  server: http.Server;
  browser: Browser;
  page: Page;
  compiledTemplate: string;
  renderTimeout?: NodeJS.Timeout;
  eventCleanup: () => void;
}

/**
 * Base class for PDF-based template renderers
 * Provides common functionality for rendering templates using Puppeteer
 */
export abstract class BasePdfTemplate extends TemplateRenderer {
  @Config('templates.pdf')
  protected Options: IPdfRendererOptions;

  @Logger('pdf-templates')
  protected Log: Log;

  @LazyInject()
  protected TemplatingService: Templates;

  protected static USED_PORTS: number[] = [];

  public async renderToFile(template: string, model: any, filePath: string, language?: string): Promise<void> {
    let context: Partial<RenderContext> = {};

    try {
      this.Log.timeStart(`template-rendering-${filePath}`);
      this.Log.trace(`Rendering template ${template} to file ${filePath}`);

      context = await this.setupRenderContext(template, model, language);
      await this.performRender(context as RenderContext, filePath);

      if (context.renderTimeout) {
        clearTimeout(context.renderTimeout);
      }

      if (context.eventCleanup) {
        context.eventCleanup();
      }
    } catch (err) {
      this.Log.error(err, `Error rendering template ${template} to file ${filePath}`);
      throw err;
    } finally {
      const duration = this.Log.timeEnd(`template-rendering-${filePath}`);
      if (duration > this.Options.renderDurationWarning) {
        this.Log.warn(`Rendering took too long: ${duration}ms`);
      }

      await this.cleanup(context);
    }
  }

  /**
   * Setup the rendering context (server, browser, page, compiled template)
   */
  protected async setupRenderContext(
    template: string,
    model: any,
    language?: string,
  ): Promise<RenderContext> {
    const templateBasePath = dirname(template);

    // Fire up local http server for serving images etc
    const server = await this.runLocalServer(templateBasePath);
    const httpPort = (server.address() as AddressInfo).port;

    const compiledTemplate = await this.TemplatingService.render(
      join(templateBasePath, basename(template, this.Extension)) + '.pug',
      {
        __http_template_port__: httpPort,
        __http_template_address__: `http://localhost:${httpPort}`,
        ...model,
      },
      language,
    );

    const launchOptions: LaunchOptions = {
      ...this.Options.args,
      ...(this.Options.executablePath && {
        executablePath: this.Options.executablePath,
      }),
    };

    const browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();

    // Skip timeouts in debug mode
    if (!this.Options.debug?.close) {
      page.setDefaultNavigationTimeout(this.Options.navigationTimeout || 30000);
      page.setDefaultTimeout(this.Options.renderTimeout || 30000);
    }

    // Set up render timeout (skip in debug mode)
    let renderTimeout: NodeJS.Timeout | undefined;
    if (!this.Options.debug?.close) {
      const timeoutMs = this.Options.renderTimeout || 30000;
      renderTimeout = setTimeout(async () => {
        this.Log.warn(`Render timeout (${timeoutMs}ms) - forcing cleanup`);
        try {
          if (page) await page.close().catch(() => {});
          if (browser) await this.forceCloseBrowser(browser);
        } catch (err) {
          this.Log.error('Error during timeout cleanup:', err);
        }
      }, timeoutMs);
    }

    const eventCleanup = this.addPageEventListeners(page);

    await page.setBypassCSP(true);
    await page.setContent(compiledTemplate);

    return {
      server,
      browser,
      page,
      compiledTemplate,
      renderTimeout,
      eventCleanup,
    };
  }

  /**
   * Perform the actual rendering operation - to be implemented by subclasses
   */
  protected abstract performRender(context: RenderContext, filePath: string): Promise<void>;

  /**
   * Cleanup resources after rendering
   */
  protected async cleanup(context: Partial<RenderContext>): Promise<void> {
    // Skip browser cleanup if debug.close is false
    if (context.browser && this.Options.debug?.close !== false) {
      await this.safeBrowserCleanup(context.browser);
    } else if (context.browser) {
      this.Log.info('Browser kept open for debugging (debug.close=false)');
    }

    if (context.server) {
      await this.safeServerCleanup(context.server);
    }
  }

  /**
   * Run local HTTP server for serving static assets
   */
  protected async runLocalServer(basePath: string): Promise<http.Server> {
    const self = this;
    const app = Express();
    app.use(cors());
    app.use(Express.static(basePath));

    return new Promise((resolve, reject) => {
      const server = app
        .listen(
          this.Options.static.portRange.length === 0
            ? 0
            : _.random(this.Options.static.portRange[0], this.Options.static.portRange[1]),
        )
        .on('listening', function () {
          self.Log.trace(`Static server started on port ${(this.address() as AddressInfo).port}`);
          self.Log.trace(`Static file dir at ${basePath}`);
          resolve(this);
        })
        .on('error', (err: any) => {
          self.Log.error(err, `Static server cannot start`);

          if (server) {
            server.close(() => {
              reject(err);
            });
          } else {
            reject(err);
          }
        });

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
      const pages = await browser.pages();
      await Promise.allSettled(pages.map((page) => page.close()));
      await browser.close();
    } catch (err) {
      this.Log.warn(`Error during normal browser cleanup: ${err.message}`);

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
  protected addPageEventListeners(page: Page): () => void {
    const listeners = {
      console: (message: any) => this.Log.trace(`${message.type().substr(0, 3).toUpperCase()} ${message.text()}`),
      pageerror: ({ message }: any) => this.Log.error(message),
      response: (response: any) => this.Log.trace(`${response.status()} ${response.url()}`),
      requestfailed: (request: any) => this.Log.error(`${request.failure().errorText} ${request.url()}`),
    };

    page.on('console', listeners.console);
    page.on('pageerror', listeners.pageerror);
    page.on('response', listeners.response);
    page.on('requestfailed', listeners.requestfailed);

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

  // No compilation at start
  protected async compile(_path: string) {}
}
