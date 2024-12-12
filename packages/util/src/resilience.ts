export interface RetryOptions {
  /**
   * What errors should be handled by retry
   * If empty - all errors
   */
  ShouldHandle?: Error[];

  /**
   *
   * How many retries until throw
   *
   */
  MaxAttempts?: number;

  /**
   * Delay between retries
   */
  Delay?: number;

  /**
   *
   * If set, delays between retries  will be calculate by this function
   *
   * @param attempt
   * @returns
   */
  DelayGenerator?: (attempt: number) => number;
}

export interface TimeoutOptions {
  /**
   * Time until timeout occurs in ms
   */
  timeout: number;
}

export interface FallbackOptions {
  /**
   * What errors should be handled by retry
   * If empty - all errors
   */
  ShouldHandle?: Error[];

  onFallback?: () => Promise<void>;
  fallback: <T>() => Promise<T>;
}

// export class Resilience<T> {
//   constructor() {}
//   public async execute(callback: (abortSignal: AbortSignal) => Promise<T>): Promise<T> {}
// }

// export class ResilienceBuilder<T> {
//   public fallback(options: FallbackOptions) {}
//   public timeout(options: TimeoutOptions) {}
//   public retry(options: RetryOptions) {}
//   public build(): Resilience<T> {
//     return new Resilience();
//   }
// }
