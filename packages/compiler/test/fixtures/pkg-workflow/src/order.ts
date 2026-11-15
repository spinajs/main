import { Workflow, type Ctx } from './api.js';

const late = ['late', 'signal'].join('-');

@Workflow('order')
export class OrderV1 {
  public async run(ctx: Ctx): Promise<void> {
    await ctx.waitForEvent('approved');
  }
}

@Workflow('order', { version: 2 })
export class OrderV2 {
  public async run(ctx: Ctx): Promise<number> {
    const stamp = await ctx.step('stamp', () => Date.now());
    await ctx.waitForEvent('approved', { permission: 'orders:approve', timeout: '3d' });
    await ctx.waitForEvent('note');
    await ctx.waitForEvent('approved', { permission: 'orders:approve' });
    await ctx.waitForEvent(late);
    return stamp + new Date().getTime() + Math.random();
  }
}
