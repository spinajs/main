import { Socket } from 'net';
import { rmSync } from 'fs';

export const STOMP_URL = process.env.QUEUE_IT_STOMP_URL ?? 'ws://127.0.0.1:61614/ws';
export const STOMP_LOGIN = process.env.QUEUE_IT_STOMP_LOGIN ?? 'spinajs';
export const STOMP_PASSWORD = process.env.QUEUE_IT_STOMP_PASSWORD ?? 'spinajs';
export const BROKER_CONTAINER = process.env.QUEUE_IT_ACTIVEMQ_CONTAINER ?? 'spinajs-queue-test-activemq';
const REQUIRE_BROKER = process.env.QUEUE_IT_REQUIRE_BROKER === '1';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for: ${label}`);
    }
    await sleep(50);
  }
}

let sequence = 0;

export function uniqueQueue(prefix: string): string {
  return `/queue/it.${prefix}.${Date.now()}.${++sequence}`;
}

export function uniqueTopic(prefix: string): string {
  return `/topic/it.${prefix}.${Date.now()}.${++sequence}`;
}

export function brokerReachable(timeoutMs = 2000): Promise<boolean> {
  const url = new URL(STOMP_URL);
  return new Promise((resolve) => {
    const socket = new Socket();
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('error', () => done(false));
    socket.connect(Number(url.port || 80), url.hostname, () => done(true));
  });
}

export async function requireBroker(ctx: Mocha.Context): Promise<void> {
  if (await brokerReachable()) {
    return;
  }
  if (REQUIRE_BROKER) {
    throw new Error(`QUEUE_IT_REQUIRE_BROKER=1 but nothing listens at ${STOMP_URL}. Start it with: docker compose --profile test up -d activemq`);
  }
  ctx.skip();
}

export function removeTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // sqlite can still hold the file open on Windows; the OS temp cleaner gets it later
  }
}
