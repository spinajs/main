import { Browser, default as puppeteer, LaunchOptions } from 'puppeteer';
import { Log } from '@spinajs/log';

/**
 * Lazily launches and pools a single Chromium browser, reused across renders and
 * relaunched if it crashes/disconnects. Concurrent first-callers share one launch.
 * The browser is closed only on {@link dispose}.
 */
export class BrowserPool {
  private pooled: Browser | null = null;
  private launchPromise: Promise<Browser> | null = null;

  /**
   * @param log - logger for lifecycle warnings
   * @param launchOptions - supplies puppeteer launch options at acquire time
   *   (resolved lazily so DI-injected config is available).
   */
  constructor(private readonly log: Log, private readonly launchOptions: () => LaunchOptions) {}

  /** The currently pooled browser, or null when none is live. */
  public get browser(): Browser | null {
    return this.pooled;
  }

  /**
   * Return the pooled browser, launching it on first use and relaunching if it
   * has crashed/disconnected. Concurrent callers share a single launch.
   */
  public async acquire(): Promise<Browser> {
    if (this.pooled?.connected) {
      return this.pooled;
    }

    // drop a disconnected/crashed browser so we relaunch a fresh one
    this.pooled = null;

    if (!this.launchPromise) {
      this.launchPromise = puppeteer
        .launch(this.launchOptions())
        .then((b) => (this.pooled = b))
        // reset so a failed launch is retried on the next call
        .finally(() => (this.launchPromise = null));
    }

    return this.launchPromise;
  }

  /** Close and drop the pooled browser. Best-effort: force-kills if a graceful close fails. */
  public async dispose(): Promise<void> {
    if (!this.pooled) {
      return;
    }

    const browser = this.pooled;
    this.pooled = null;
    await this.safeClose(browser);
  }

  private async safeClose(browser: Browser): Promise<void> {
    try {
      // close all pages first, then the browser itself
      const pages = await browser.pages();
      await Promise.allSettled(pages.map((page) => page.close()));
      await browser.close();
    } catch (err) {
      this.log.warn(`Error during normal browser cleanup: ${err.message}`);

      try {
        this.forceClose(browser);
      } catch (killErr) {
        this.log.error(`Failed to force kill browser: ${killErr.message}`);
      }
    }
  }

  private forceClose(browser: Browser): void {
    const proc = browser.process();
    if (proc) {
      proc.kill('SIGKILL');
      this.log.warn('Browser process force killed');
    }
  }
}
