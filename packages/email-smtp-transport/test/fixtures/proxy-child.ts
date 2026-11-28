// Run in a fresh node process by proxy-url.test.ts: Node prints a DEP0170 warning only once per process.
import { DnsTripwire, SocketGuard } from '../network-guards.js';

const tripwire = new DnsTripwire();
const guard = new SocketGuard();
tripwire.install();
guard.install();

const warnings: string[] = [];
process.on('warning', (warning: Error & { code?: string }) => warnings.push(warning.code ?? warning.name));

const { attempt, configure } = await import('../proxy-attempt.js');
await configure();
const { thrown, logs, printed } = await attempt(process.argv[2]);

const report = {
  thrown: thrown instanceof Error ? thrown.constructor.name : typeof thrown,
  logs: logs.length,
  asked: tripwire.Asked,
  dialled: guard.Dialled,
  warnings,
  printed,
};
// stderr first, so the warning Node printed is flushed before the process exits
await new Promise((resolve) => process.stderr.write('', resolve));
process.stdout.write(JSON.stringify(report), () => process.exit(0));
