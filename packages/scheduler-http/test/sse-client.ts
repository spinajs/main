import http from 'node:http';
import { appPort } from './common.js';

export interface ISseFrame {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
}

export interface ISseConnection {
  status: number;
  headers: http.IncomingHttpHeaders;
  frames: ISseFrame[];
  ended: Promise<void>;
  waitFor(predicate: (frames: ISseFrame[]) => boolean, timeoutMs?: number): Promise<ISseFrame[]>;
  close(): void;
}

export function parseFrames(buffer: string): { frames: ISseFrame[]; rest: string } {
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() ?? '';
  const frames = blocks.map((block) => {
    const frame: ISseFrame = {};
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) {
        frame.comment = line.slice(1).trim();
        continue;
      }
      const colon = line.indexOf(':');
      const field = line.slice(0, colon);
      const value = line.slice(colon + 1).replace(/^ /, '');
      if (field === 'data') {
        frame.data = frame.data === undefined ? value : `${frame.data}\n${value}`;
      } else if (field === 'id' || field === 'event') {
        frame[field] = value;
      }
    }
    return frame;
  });

  return { frames, rest };
}

/**
 * Raw streaming client; chai-http buffers the whole body, which never ends for a live stream.
 */
export function openSse(path: string, headers: Record<string, string> = {}): Promise<ISseConnection> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port: appPort(), path, agent: false, headers: { Accept: 'text/event-stream', ...headers } }, (res) => {
      const frames: ISseFrame[] = [];
      const waiters = new Set<() => void>();
      let buffer = '';

      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        const parsed = parseFrames(buffer + chunk);
        buffer = parsed.rest;
        frames.push(...parsed.frames);
        waiters.forEach((check) => check());
      });

      const ended = new Promise<void>((done) => {
        res.on('end', done);
        res.on('close', done);
      });

      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        frames,
        ended,
        waitFor(predicate, timeoutMs = 3000) {
          return new Promise((ok, fail) => {
            const timer = setTimeout(() => {
              waiters.delete(check);
              fail(new Error(`SSE wait timed out, received ${JSON.stringify(frames)}`));
            }, timeoutMs);
            const check = () => {
              if (predicate(frames)) {
                clearTimeout(timer);
                waiters.delete(check);
                ok(frames);
              }
            };
            waiters.add(check);
            check();
          });
        },
        close() {
          request.destroy();
        },
      });
    });

    request.on('error', reject);
  });
}

export async function eventually(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

export const events = (frames: ISseFrame[]) => frames.filter((f) => f.event !== undefined);
