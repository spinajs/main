import { connectNotes, loadSnapshot, toBytes } from './client.js';
import { startNotesServer } from './server.js';

const server = await startNotesServer({ verbose: process.argv.includes('--verbose') });
const notes = connectNotes(server.url, server.path, 'alice-token');

try {
  const opened = await notes.command('notes.open', { docId: 'welcome' }, { whenOffline: 'wait' });
  console.log(`opened ${opened.docId} v${opened.version} as ${opened.openedBy}, ${opened.chunks} chunks`);

  const snapshot = await loadSnapshot(notes, 'welcome', { credits: 4 });
  console.log(`snapshot v${snapshot.version}: ${snapshot.entities.length} notes`);

  const { hash } = await notes.command('blob.put', { bytes: new TextEncoder().encode('hello blob') });
  const back = await notes.command('blob.get', { hash });
  console.log(`blob ${hash.slice(0, 12)}: ${new TextDecoder().decode(toBytes(back))}`);
} finally {
  await notes.close();
  await server.close();
}
