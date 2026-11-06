import { Workflow, type Ctx } from '../src/api.js';

const APPROVED = 'approved';
const PERMISSION = 'orders:approve';
const SHIP = { permission: 'orders:ship' } as const;
const V3 = { version: 3 };
declare const runtimeVersion: number;
declare function options(): { version: number };

@Workflow('consts', V3)
export class Consts {
  public async run(ctx: Ctx): Promise<void> {
    await ctx.waitForEvent(APPROVED, { permission: PERMISSION });
    await ctx.waitForEvent('ship', SHIP);
    await ctx.step(`at:${Date.now()}`, () => Math.random());
  }
}

@Workflow('unread', { version: runtimeVersion })
export class UnreadVersion {
  public async run(): Promise<void> {}
}

@Workflow('unread', options())
export class UnreadOptions {
  public async run(): Promise<void> {}
}
