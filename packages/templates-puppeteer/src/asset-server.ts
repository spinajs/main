import Express from 'express';
import * as http from 'http';
import cors from 'cors';
import { AddressInfo } from 'net';
import _ from 'lodash';
import { Log } from '@spinajs/log';

/** How long to wait for the local static server to start before giving up (ms). */
const SERVER_STARTUP_TIMEOUT_MS = 10000;
/** How long to wait for the local static server to close before forcing it (ms). */
const SERVER_CLOSE_TIMEOUT_MS = 5000;
/** Attempts to find a free port when a range is configured (a random pick can collide). */
const MAX_PORT_ATTEMPTS = 10;

/**
 * A short-lived local static HTTP server used so headless Chromium can load
 * relative asset URLs (images, css, fonts) - it refuses local files over the
 * file:// protocol. Bound to loopback so the served directory is never
 * network-exposed. One server is started per render and closed afterwards.
 */
export class LocalAssetServer {
  /**
   * @param log - logger for lifecycle traces
   * @param portRange - supplies the optional [min, max] port range; when absent
   *   an OS-assigned port (0) is used, which cannot collide.
   */
  constructor(private readonly log: Log, private readonly portRange: () => number[] | undefined) {}

  /**
   * Start a server for `basePath`. With an OS-assigned port a single attempt
   * suffices; with a configured range a random pick can collide, so retry on
   * EADDRINUSE with a different port.
   */
  public async serve(basePath: string): Promise<http.Server> {
    const range = this.portRange();
    const hasRange = !!range && range.length > 0;
    const maxAttempts = hasRange ? MAX_PORT_ATTEMPTS : 1;
    let lastErr: any;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const port = hasRange ? _.random(range![0], range![1]) : 0;

      try {
        return await this.listenOnce(basePath, port);
      } catch (err: any) {
        lastErr = err;

        if (err?.code === 'EADDRINUSE' && hasRange) {
          this.log.trace(`Puppeteer asset server port ${port} in use, retrying (${attempt + 1}/${maxAttempts})`);
          continue;
        }

        throw err;
      }
    }

    this.log.error(lastErr, `Puppeteer asset server cannot start - no free port in range after ${maxAttempts} attempts`);
    throw lastErr;
  }

  /** Close a server, forcing connections closed if a graceful close times out. */
  public async close(server: http.Server): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Server close timeout'));
        }, SERVER_CLOSE_TIMEOUT_MS);

        server.close((err) => {
          clearTimeout(timeout);
          if (err) reject(err);
          else resolve();
        });
      });
    } catch (err) {
      this.log.warn(`Error closing server: ${err.message}`);

      // Force close connections if available
      try {
        if ('closeAllConnections' in server) {
          (server as any).closeAllConnections();
        }
      } catch (forceErr) {
        this.log.error(`Error force closing server connections: ${forceErr.message}`);
      }
    }
  }

  /**
   * Single attempt to start the static server on the given port (0 = OS-assigned).
   * Bound to loopback so the served directory is not network-exposed.
   */
  private listenOnce(basePath: string, port: number): Promise<http.Server> {
    const log = this.log;
    const app = Express();
    app.use(cors());
    app.use(Express.static(basePath));

    return new Promise((resolve, reject) => {
      const server = app
        .listen(port, '127.0.0.1')
        .on('listening', function () {
          log.trace(`Puppeteer asset server started on port ${(this.address() as AddressInfo).port}`);
          log.trace(`Puppeteer static file dir at ${basePath}`);
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
      }, SERVER_STARTUP_TIMEOUT_MS);
    });
  }
}
