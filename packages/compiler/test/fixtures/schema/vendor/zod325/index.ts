export interface FakeSchema {
  readonly '~standard': { readonly version: 1; readonly vendor: 'zod'; readonly validate: (value: unknown) => { value: unknown } };
}
export declare function object(shape: object): FakeSchema;
