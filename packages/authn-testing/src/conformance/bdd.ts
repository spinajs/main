export interface TestThis {
  skip(): never;
  timeout(ms: number): void;
  readonly test?: { title: string };
}

export interface BddApi {
  describe(title: string, fn: () => void): void;
  it(title: string, fn: (this: TestThis) => Promise<void>): void;
  after(fn: () => void): void;
}
