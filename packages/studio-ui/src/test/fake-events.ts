import { act } from '@testing-library/react';
import { vi } from 'vitest';

type Listener = (event: MessageEvent<string>) => void;

export class FakeEventSource {
  static instances: FakeEventSource[] = [];

  static install(): void {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  }

  static last(): FakeEventSource {
    const source = FakeEventSource.instances.at(-1);
    if (!source) throw new Error('no EventSource was opened');
    return source;
  }

  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly listeners = new Map<string, Set<Listener>>();
  closed = false;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  get readyState(): number {
    return this.closed ? FakeEventSource.CLOSED : FakeEventSource.OPEN;
  }

  /** The connection drops for good: the browser fires `error` with `readyState` CLOSED and stops reconnecting. */
  fail(): void {
    this.closed = true;
    act(() => this.onerror?.(new Event('error')));
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    act(() => {
      for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data: JSON.stringify(data) }));
    });
  }
}
