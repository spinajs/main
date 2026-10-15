import { execFile } from 'child_process';
import { promisify } from 'util';
import WebSocket from 'ws';
import { BROKER_CONTAINER, STOMP_LOGIN, STOMP_PASSWORD, STOMP_URL, sleep, waitFor } from './env.js';

const execFileAsync = promisify(execFile);

export async function docker(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('docker', args);
  return stdout.trim();
}

export async function dockerControlAvailable(): Promise<boolean> {
  try {
    return (await docker('inspect', '--format', '{{.State.Running}}', BROKER_CONTAINER)) === 'true';
  } catch {
    return false;
  }
}

function stompHandshake(timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(STOMP_URL, ['v12.stomp']);
    const done = (ok: boolean) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on('error', () => undefined);
      socket.terminate();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.on('open', () => socket.send(`CONNECT\naccept-version:1.2\nhost:localhost\nlogin:${STOMP_LOGIN}\npasscode:${STOMP_PASSWORD}\n\n\0`));
    socket.on('message', (data) => done(String(data).startsWith('CONNECTED')));
    socket.on('error', () => done(false));
  });
}

/**
 * Docker Desktop accepts on the published host port before it can forward to a just-started container,
 * so an open port alone proved nothing here: require a few full STOMP handshakes in a row.
 */
export async function waitForBroker(timeoutMs = 120000): Promise<void> {
  await waitFor(async () => (await docker('inspect', '--format', '{{.State.Health.Status}}', BROKER_CONTAINER).catch(() => '')) === 'healthy', timeoutMs, `${BROKER_CONTAINER} healthy`);

  let streak = 0;
  await waitFor(
    async () => {
      streak = (await stompHandshake()) ? streak + 1 : 0;
      if (streak < 3) {
        await sleep(500);
      }
      return streak >= 3;
    },
    timeoutMs,
    'three consecutive STOMP handshakes through the published port',
  );
}

export async function ensureBrokerUp(): Promise<void> {
  await docker('start', BROKER_CONTAINER).catch(() => undefined);
  await waitForBroker();
}
