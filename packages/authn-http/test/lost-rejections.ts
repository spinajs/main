// Mocha 10 drops an unhandled rejection that is not its own: it re-emits it on process, where nothing listens. One
// such rejection is mocha's own TypeError while it describes a hook failure whose value has no message, which is what
// a ts-node compile error becomes on its way out of Node's off-thread loader. The hook then never ends, the event loop
// drains, and the process exits 0 after the first describe. This listener fails the run instead.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection; the run is incomplete:', reason);
  process.exitCode = 1;
});
