import { DI } from '@spinajs/di';
import { renderPdfToProvider } from './render.js';
import { IRenderRequest, WorkerMessage } from './protocol.js';

/**
 * Render worker entrypoint. Forked by {@link RenderPdfJob} with an IPC channel:
 * the parent sends an {@link IRenderRequest}, the worker streams `progress`
 * messages and finishes with `done` or `error`, then exits so its process (and
 * the pooled Chromium) is fully reclaimed.
 */
function send(message: WorkerMessage): void {
  process.send?.(message);
}

process.on('message', async (req: IRenderRequest) => {
  try {
    const result = await renderPdfToProvider(req, (m) => send(m));
    send({ type: 'done', result });
    await DI.dispose();
    process.exit(0);
  } catch (err: any) {
    send({ type: 'error', message: err?.message ?? String(err) });
    try {
      await DI.dispose();
    } catch {
      /* best-effort cleanup on the error path */
    }
    process.exit(1);
  }
});
