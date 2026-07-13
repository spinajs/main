import { EventEmitter } from 'events';
import * as chai from 'chai';
import { IRenderProgress, RenderPhase } from '@spinajs/templates';
import { RenderProgressReporter } from '../src/progress.js';

const expect = chai.expect;

// A puppeteer Page is an EventEmitter for our purposes: the reporter only uses
// on/off for 'request' / 'requestfinished' / 'requestfailed'. This lets us drive
// the resource lifecycle deterministically without launching a browser.
function fakePage(): EventEmitter {
  return new EventEmitter();
}

describe('RenderProgressReporter', () => {
  it('reports phases, resource counts and a monotonic percent ending at 100', () => {
    const events: IRenderProgress[] = [];
    const reporter = new RenderProgressReporter('out.pdf', (p) => {
      events.push({ ...p });
    });
    const page = fakePage();

    reporter.attach(page as any);
    reporter.phase(RenderPhase.Starting);
    reporter.phase(RenderPhase.Preparing);
    reporter.phase(RenderPhase.Loading);

    // three resources: seen then finished
    page.emit('request');
    page.emit('request');
    page.emit('request');
    page.emit('requestfinished');
    page.emit('requestfinished');
    page.emit('requestfinished');

    reporter.phase(RenderPhase.Rendering);
    reporter.phase(RenderPhase.Done);
    reporter.dispose();

    expect(events.length).to.be.greaterThan(0);

    // phases advance, never regress
    const order = [RenderPhase.Starting, RenderPhase.Preparing, RenderPhase.Loading, RenderPhase.Rendering, RenderPhase.Done];
    const seen = events.map((e) => order.indexOf(e.phase)).filter((i) => i >= 0);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).to.be.gte(seen[i - 1]);
    }

    // percent monotonic non-decreasing
    for (let i = 1; i < events.length; i++) {
      expect(events[i].percent).to.be.gte(events[i - 1].percent);
    }

    const last = events[events.length - 1];
    expect(last.phase).to.eq(RenderPhase.Done);
    expect(last.percent).to.eq(100);
    expect(last.resourcesLoaded).to.eq(3);
    expect(last.resourcesPending).to.eq(0);
  });

  it('counts failed resources', () => {
    const events: IRenderProgress[] = [];
    const reporter = new RenderProgressReporter('out.pdf', (p) => {
      events.push({ ...p });
    });
    const page = fakePage();

    reporter.attach(page as any);
    reporter.phase(RenderPhase.Loading);
    page.emit('request');
    page.emit('requestfailed');
    reporter.phase(RenderPhase.Done);
    reporter.dispose();

    expect(events[events.length - 1].resourcesFailed).to.eq(1);
  });

  it('reports a Failed phase', () => {
    const events: IRenderProgress[] = [];
    const reporter = new RenderProgressReporter('out.pdf', (p) => {
      events.push({ ...p });
    });

    reporter.phase(RenderPhase.Starting);
    reporter.phase(RenderPhase.Failed, 'boom');
    reporter.dispose();

    const last = events[events.length - 1];
    expect(last.phase).to.eq(RenderPhase.Failed);
    expect(last.message).to.eq('boom');
  });

  it('detaches page listeners on dispose', () => {
    const reporter = new RenderProgressReporter('out.pdf', () => undefined);
    const page = fakePage();

    reporter.attach(page as any);
    expect(page.listenerCount('requestfinished')).to.eq(1);

    reporter.dispose();
    expect(page.listenerCount('requestfinished')).to.eq(0);
  });

  it('is entirely inert without a callback (no listeners, no emissions)', () => {
    const reporter = new RenderProgressReporter('out.pdf');
    const page = fakePage();

    reporter.attach(page as any);
    reporter.phase(RenderPhase.Loading);
    page.emit('requestfinished');

    // no callback -> nothing subscribed, nothing to observe
    expect(page.listenerCount('request')).to.eq(0);
    expect(page.listenerCount('requestfinished')).to.eq(0);
    reporter.dispose();
  });

  it('swallows callback errors so a faulty listener cannot break the render', () => {
    const reporter = new RenderProgressReporter('out.pdf', () => {
      throw new Error('listener blew up');
    });

    // must not throw
    expect(() => reporter.phase(RenderPhase.Starting)).to.not.throw();
    reporter.dispose();
  });
});
