import { startNotesServer } from './server.js';

/** Entry of the single-file bundle ( scripts/bundle.mjs ): serves until a signal arrives. */
export async function startBundle(): Promise<void> {
  const server = await startNotesServer({ port: Number(process.env.PORT ?? 0), verbose: process.env.VERBOSE === '1' });
  console.log(`listening ${server.url}`);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void server.close().finally(() => process.exit(0)));
  }
}
