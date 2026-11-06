import { DenyAllSignalAuthorizer, SignalAuthorizer } from '../../src/index.js';

type Decide = (principal: string | undefined, permission: string, resource: Record<string, unknown> | undefined, ctx: { instanceId: string; workflow: string; event: string }) => boolean;

/** Registered for the whole process; without `decide` it answers as DenyAllSignalAuthorizer does. */
export class TestSignalAuthorizer extends SignalAuthorizer {
  public static decide: Decide | undefined;
  public static calls: Parameters<Decide>[] = [];

  public static reset(): void {
    TestSignalAuthorizer.decide = undefined;
    TestSignalAuthorizer.calls = [];
  }

  public authorize(...args: Parameters<Decide>): Promise<boolean> {
    TestSignalAuthorizer.calls.push(args);
    return TestSignalAuthorizer.decide ? Promise.resolve(TestSignalAuthorizer.decide(...args)) : new DenyAllSignalAuthorizer().authorize();
  }
}
