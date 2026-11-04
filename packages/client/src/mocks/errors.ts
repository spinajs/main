/** Where a schema node sits: the schema name in the mock schema table and a JSON pointer into it. */
export interface MockIssue {
  schema: string;
  pointer: string;
  message: string;
}

/** `MOCK001`: the schema uses something the sampler cannot honour, so it gives no value rather than a wrong one. */
export class MockUnsupported extends Error {
  public readonly code = 'MOCK001';

  constructor(
    public readonly mock: string,
    public readonly issue: MockIssue,
  ) {
    super(`MOCK001: cannot mock ${mock}: ${issue.message} (at ${issue.schema}#${issue.pointer})`);
    this.name = 'MockUnsupported';
  }
}

export class MockNotImplemented extends Error {
  constructor(public readonly route: string) {
    super(`createMockAppClient: ${route} is not implemented; pass it in the first argument`);
    this.name = 'MockNotImplemented';
  }
}

/** The sampler found no value for a schema it supports, such as an empty number range or a format longer than `maxLength`. */
export class MockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MockError';
  }
}
