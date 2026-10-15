export interface SseMessage {
  id?: string;
  event?: string;
  data: string;
}

/** Incremental `text/event-stream` parser: frames may arrive split across chunks. */
export class SseParser {
  protected buffer = '';
  protected current: { id?: string; event?: string; data: string[] } = { data: [] };

  public push(text: string): SseMessage[] {
    this.buffer += text;
    const out: SseMessage[] = [];
    let idx: number;
    while ((idx = this.buffer.search(/\r\n|\r|\n/)) >= 0) {
      // a trailing '\r' may be the first half of a '\r\n' split across chunks
      if (this.buffer[idx] === '\r' && idx === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, idx);
      const width = this.buffer[idx] === '\r' && this.buffer[idx + 1] === '\n' ? 2 : 1;
      this.buffer = this.buffer.slice(idx + width);

      if (line === '') {
        if (this.current.data.length || this.current.id !== undefined) {
          out.push({ id: this.current.id, event: this.current.event, data: this.current.data.join('\n') });
        }
        this.current = { data: [] };
        continue;
      }
      if (line.startsWith(':')) continue;

      const colon = line.indexOf(':');
      const field = colon >= 0 ? line.slice(0, colon) : line;
      let value = colon >= 0 ? line.slice(colon + 1) : '';
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') this.current.data.push(value);
      else if (field === 'id') this.current.id = value;
      else if (field === 'event') this.current.event = value;
    }
    return out;
  }
}
