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
     * If true, browser will remain open after rendering for inspection
     * Use it with headless: false in args to see the browser window ( puppetter.launch args )
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

  public async renderToFile(template: string, model: any, filePath: string, language?: string): Promise<void> {
    let server: http.Server = null;
    let browser: Browser = null;
    try {
      this.Log.timeStart(`puppeteer-template-rendering-${filePath}`);
      this.Log.trace(`Rendering template ${template} to file ${filePath}`);

      const templateBasePath = dirname(template);

      // fire up local http server for serving images etc
      // becouse chromium prevents from reading local files when not
      // rendering file with file:// protocol for security reasons
      server = await this.runLocalServer(templateBasePath);
      const httpPort = (server.address() as AddressInfo).port;

      const compiledTemplate = await this.TemplatingService.render(
        join(templateBasePath, basename(template, this.Extension)) + '.pug',
        {
          // add template temporary server port
          // so we can use it to render images in template
          __http_template_port__: httpPort,

          // for convinience add full url to local http server
          __http_template_address__: `http://localhost:${httpPort}`,
          ...model,
        },
        language,
      );

      const launchOptions: LaunchOptions = {
        ...(this.Options?.args || {}),
        ...(this.Options?.executablePath && {
          executablePath: this.Options.executablePath,
        }),
      };

      browser = await puppeteer.launch(launchOptions);
      const page = await browser.newPage();

      // Skip timeouts in debug mode
      if (!this.Options?.debug?.close) {
        page.setDefaultNavigationTimeout(this.Options?.navigationTimeout || 30000); // Default 30s
        page.setDefaultTimeout(this.Options?.renderTimeout || 30000); // Default 30s
      }

      // Set up render timeout (skip in debug mode)
      let renderTimeout: NodeJS.Timeout | undefined;
      if (!this.Options?.debug?.close) {
        const timeoutMs = this.Options?.renderTimeout || 30000;
        renderTimeout = setTimeout(async () => {
          this.Log.warn(`Render timeout (${timeoutMs}ms) - forcing cleanup`);
          try {
            if (page) await page.close().catch(() => { });
            if (browser) await this.forceCloseBrowser(browser);
          } catch (err) {
            this.Log.error('Error during timeout cleanup:', err);
          }
        }, timeoutMs);
      }

      // Add event listeners with explicit cleanup tracking
      const eventCleanup = this.addPageEventListeners(page);

      try {
        await page.setBypassCSP(true);
        await page.setContent(compiledTemplate);
        
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
        this.Log.error(renderError, `Error during rendering for template ${template}`);
        throw renderError;
      }
    } catch (err) {
      this.Log.error(err, `Error rendering template ${template} to file ${filePath}`);
      throw err;
    } finally {
      const duration = this.Log.timeEnd(`puppeteer-template-rendering-${filePath}`);
      this.Log.trace(`Ended rendering template ${template} to file ${filePath}, took: ${duration}ms`);

      if (this.Options && duration > this.Options.renderDurationWarning) {
        this.Log.warn(`Rendering template ${template} to file ${filePath} took too long.`);
      }

      // Skip browser cleanup if debug.close is false (keep browser open for inspection)
      if (browser && (!this.Options || this.Options.debug?.close !== false)) {
        await this.safeBrowserCleanup(browser);
      } else if (browser) {
        this.Log.info('Browser kept open for debugging (debug.close=false)');
      }

      if (server) {
        await this.safeServerCleanup(server);
      }
    }
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
    const self = this;
    const app = Express();
    app.use(cors());
    app.use(Express.static(basePath));

    return new Promise((resolve, reject) => {
      const server = app
        // if no port is provided express will choose random port to start (available)
        // if not, we will get random from range in config
        .listen(
          !this.Options?.static?.portRange || this.Options.static.portRange.length === 0
            ? 0
            : _.random(this.Options.static.portRange[0], this.Options.static.portRange[1])
        )
        .on('listening', function () {
          self.Log.trace(`Puppeteer image server started on port ${(this.address() as AddressInfo).port}`);
          self.Log.trace(`Puppeteer static file dir at ${basePath}`);
          resolve(this);
        })
        .on('error', (err: any) => {
          self.Log.error(err, `Puppeteer image server cannot start`);

          // Clean up the failed server
          if (server) {
            server.close(() => {
              reject(err);
            });
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
      requestfailed: (request: any) => this.Log.error(`${request.failure().errorText} ${request.url()}`)
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
