import http from 'node:http';

export interface SseFrame {
  event?: string;
  id?: string;
  data: string;
}

export interface SseClient {
  next(): Promise<SseFrame>;
  close(): void;
}

function parseFrame(raw: string): SseFrame | undefined {
  let event: string | undefined;
  let id: string | undefined;
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7);
    else if (line.startsWith('id: ')) id = line.slice(4);
    else if (line.startsWith('data: ')) data.push(line.slice(6));
  }
  return data.length > 0 ? { ...(event ? { event } : {}), ...(id ? { id } : {}), data: data.join('\n') } : undefined;
}

function reader(res: http.IncomingMessage): () => Promise<SseFrame> {
  const frames: SseFrame[] = [];
  const waiting: ((frame: SseFrame) => void)[] = [];
  let buffer = '';
  res.setEncoding('utf8');
  res.on('data', (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
      const frame = parseFrame(buffer.slice(0, at));
      buffer = buffer.slice(at + 2);
      if (!frame) continue;
      const take = waiting.shift();
      if (take) take(frame);
      else frames.push(frame);
    }
  });
  return () =>
    new Promise<SseFrame>((resolve) => {
      const frame = frames.shift();
      if (frame) resolve(frame);
      else waiting.push(resolve);
    });
}

/** Opens an SSE stream and resolves once its headers arrived; comment frames (`: ping`) are skipped. */
export function openSse(port: number, path: string, user: string): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers: { accept: 'text/event-stream', 'x-user': user } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`the SSE stream answered ${String(res.statusCode)}`));
        return;
      }
      resolve({ next: reader(res), close: () => req.destroy() });
    });
    req.on('error', (e) => reject(e));
  });
}
