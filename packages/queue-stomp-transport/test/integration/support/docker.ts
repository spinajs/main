import { execFile } from 'child_process';
import { promisify } from 'util';
import { BROKER_CONTAINER, brokerReachable, waitFor } from './env.js';

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

export async function waitForBroker(timeoutMs = 120000): Promise<void> {
  await waitFor(async () => (await docker('inspect', '--format', '{{.State.Health.Status}}', BROKER_CONTAINER).catch(() => '')) === 'healthy', timeoutMs, `${BROKER_CONTAINER} healthy`);
  await waitFor(() => brokerReachable(), timeoutMs, 'STOMP port reachable');
}

export async function ensureBrokerUp(): Promise<void> {
  await docker('start', BROKER_CONTAINER).catch(() => undefined);
  await waitForBroker();
}
