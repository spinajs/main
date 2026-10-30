// Boots the example compiled without decorator metadata ( lib/no-metadata ) in plain node and runs one socket command.
// Out of process: ts-node, which runs the suites, emits decorator metadata, and the suite's own copy of the example
// would register the same socket controllers twice in one process.
const out = {};
let server;
let notes;
try {
  const { startNotesServer } = await import('../../lib/no-metadata/server.js');
  const { connectNotes } = await import('../../lib/no-metadata/client.js');
  server = await startNotesServer();
  notes = connectNotes(server.url, server.path, 'alice-token');
  out.opened = await notes.command('notes.open', { docId: 'meta' }, { whenOffline: 'wait' });
  out.edited = await notes.command('notes.edit', { docId: 'meta', entity: { id: 'meta-0', text: 'changed' } });
  out.invalid = await notes.command('notes.open', { docId: '' }).then(
    () => undefined,
    (err) => ({ code: err.code }),
  );
} catch (err) {
  out.error = { name: err?.name, message: err?.message };
} finally {
  notes?.close();
  await server?.close();
}
process.stdout.write(`<<JSON\n${JSON.stringify(out)}\nJSON>>\n`);
process.exit(0);
