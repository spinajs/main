import { ChildProcess, fork } from 'child_process';
import { join } from 'path';
import { STOMP_LOGIN, STOMP_PASSWORD, STOMP_URL, waitFor } from './env.js';

const HARNESS = join(process.cwd(), 'test', 'integration', 'harness', 'replica.mjs');

export interface IReplicaEvent {
  type: 'ready' | 'failed' | 'started' | 'succeeded';
  replica: string;
  jobId?: string;
  message?: string;
}

export function replicaEnv(o: { channel: string; dbFile: string; instanceId?: string; prefetch?: number }): Record<string, string> {
  return {
    STOMP_URL,
    STOMP_LOGIN,
    STOMP_PASSWORD,
    CHANNEL: o.channel,
    DB_FILE: o.dbFile,
    PREFETCH: String(o.prefetch ?? 1),
    QUEUE_INSTANCE_ID: o.instanceId ?? '',
  };
}

export class Replica {
  public readonly events: IReplicaEvent[] = [];
  public exited = false;

  private constructor(
    public readonly name: string,
    private readonly proc: ChildProcess,
  ) {
    proc.on('message', (m) => this.events.push(m as IReplicaEvent));
    proc.on('exit', () => {
      this.exited = true;
    });
  }

  public static async start(name: string, env: Record<string, string>): Promise<Replica> {
    const proc = fork(HARNESS, [], { env: { ...process.env, ...env, REPLICA_NAME: name }, execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const r = new Replica(name, proc);

    await waitFor(() => r.exited || r.events.some((e) => e.type === 'ready' || e.type === 'failed'), 30000, `replica ${name} to start`);

    const failure = r.events.find((e) => e.type === 'failed');
    if (failure || !r.events.some((e) => e.type === 'ready')) {
      proc.kill('SIGKILL');
      throw new Error(`replica ${name} failed to start: ${failure?.message ?? 'exited before ready'}`);
    }

    return r;
  }

  public jobs(type: 'started' | 'succeeded'): string[] {
    return this.events.filter((e) => e.type === type).map((e) => e.jobId!);
  }

  public async kill(): Promise<void> {
    this.proc.kill('SIGKILL');
    await waitFor(() => this.exited, 10000, `replica ${this.name} to exit`);
  }

  public async stop(): Promise<void> {
    if (this.exited) {
      return;
    }
    this.proc.send({ type: 'stop' });
    try {
      await waitFor(() => this.exited, 15000, `replica ${this.name} to stop`);
    } catch {
      await this.kill();
    }
  }
}
