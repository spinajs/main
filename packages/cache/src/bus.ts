import { Injectable, Singleton } from '@spinajs/di';
import type { TagBump } from './contracts.js';
import { cacheLog } from './log.js';

/**
 * Carries tag bumps between processes. A delivery may repeat or reorder bumps; stores make both cost a miss at most.
 * A bus never re-stamps: every subscriber, the publisher's own included, gets a bump with the `version` it was
 * published with, so a publisher tells its own bumps apart by the stamps it remembers. A bus carries tags and stamps
 * only, never a key or a value.
 */
export abstract class TagBus {
  abstract publish(bumps: readonly TagBump[]): Promise<void>;
  abstract subscribe(fn: (bumps: readonly TagBump[]) => void): () => void;
}

const ranks = new Map<string, number>([['InProcessTagBus', 0]]);

/** Makes the bus registered under `name` the default over every bus of a lower rank, while cache.bus is unset. */
export function preferTagBus(name: string, rank: number): void {
  ranks.set(name, rank);
}

/** The registered bus with the highest rank; a bus that no package ranked is never a default. */
export function preferredTagBus(registered: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestRank = Number.NEGATIVE_INFINITY;
  for (const name of registered) {
    const rank = ranks.get(name);
    if (rank !== undefined && rank > bestRank) {
      best = name;
      bestRank = rank;
    }
  }
  return best;
}

/** One process: the default of an application whose other packages rank no bus higher. Delivers inside publish(). */
@Singleton()
@Injectable(TagBus)
export class InProcessTagBus extends TagBus {
  private readonly subscribers = new Set<(bumps: readonly TagBump[]) => void>();

  public async publish(bumps: readonly TagBump[]): Promise<void> {
    // A snapshot: a subscriber may unsubscribe, or subscribe another, while it is called.
    for (const fn of [...this.subscribers]) {
      try {
        fn(bumps);
      } catch (error) {
        cacheLog.warn({ error }, 'cache: a tag bus subscriber failed');
      }
    }
  }

  public subscribe(fn: (bumps: readonly TagBump[]) => void): () => void {
    // A wrapper keeps two subscriptions of one function apart.
    const entry = (bumps: readonly TagBump[]): void => fn(bumps);
    this.subscribers.add(entry);
    return () => {
      this.subscribers.delete(entry);
    };
  }
}
