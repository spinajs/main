import 'mocha';
// Mocha 10 drops an unhandled rejection that is not its own: it re-emits it on process, where nothing listens. One
// such rejection is mocha's own TypeError while it describes a hook failure whose value has no message, which is what
// a ts-node compile error becomes on its way out of Node's off-thread loader. The hook then never ends, the event loop
// drains, and the process exits 0 after the first describe.
// The exitCode below only counts when the run never ends: mocha overwrites it on exit once a run finishes. A run that
// finishes fails through the root after() hook instead. A rejection raised after that hook is only logged.
// Keyed by the promise: mocha's re-emit passes the same one, while two promises may reject with the same value.
const lost = new Set<Promise<unknown>>();

process.on('unhandledRejection', (reason, promise) => {
  if (lost.has(promise)) return;
  lost.add(promise);
  console.error('Unhandled rejection:', reason);
  process.exitCode = 1;
});

after(function () {
  if (lost.size > 0) throw new Error(`${lost.size} unhandled rejection(s) during the run`);
});
