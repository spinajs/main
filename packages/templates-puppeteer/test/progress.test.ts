import { EventEmitter } from 'events';
import * as chai from 'chai';
import { IRenderProgress, RenderPhase } from '@spinajs/templates';
import { RenderProgressReporter, parseProgressLine } from '../src/progress.js';

const expect = chai.expect;

// A puppeteer Page is an EventEmitter for our purposes: the reporter only uses
// on/off for 'request' / 'requestfinished' / 'requestfailed'. This lets us drive
// the resource lifecycle deterministically without launching a browser.
function fakePage(): EventEmitter {
  return new EventEmitter();
}

// Minimal stand-in for a puppeteer ConsoleMessage: the reporter only calls text().
function consoleMsg(text: string): { text: () => string } {
  return { text: () => text };
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

  it('parses the page progress protocol and drives percent from task totals', () => {
    const events: IRenderProgress[] = [];
    const reporter = new RenderProgressReporter('out.pdf', (p) => {
      events.push({ ...p });
    });
    const page = fakePage();

    reporter.attach(page as any);
    reporter.phase(RenderPhase.Loading);

    page.emit('console', consoleMsg('__spinajs_progress__:{"task":"images","done":0,"total":4}'));
    page.emit('console', consoleMsg('__spinajs_progress__:{"task":"images","done":2,"total":4}'));

    // phase() re-emit bypasses the 150ms throttle so the assertion is deterministic
    reporter.phase(RenderPhase.Loading);
    reporter.dispose();

    const last = events[events.length - 1];
    expect(last.tasks).to.deep.eq({ images: { done: 2, total: 4 } });
    // Loading band is [15, 80]: 15 + 65 * (2/4) = 47.5 -> 48
    expect(last.percent).to.eq(48);
    expect(last.message).to.eq('images 2/4');
  });

  it('aggregates multiple tasks into one ratio', () => {
    const events: IRenderProgress[] = [];
    const reporter = new RenderProgressReporter('out.pdf', (p) => {
      events.push({ ...p });
    });
    const page = fakePage();

    reporter.attach(page as any);
    reporter.phase(RenderPhase.Loading);
    page.emit('console', consoleMsg('__spinajs_progress__:{"task":"images","done":4,"total":4}'));
    page.emit('console', consoleMsg('__spinajs_progress__:{"task":"fonts","done":0,"total":4}'));
    reporter.phase(RenderPhase.Loading);
    reporter.dispose();

    const last = events[events.length - 1];
    // 15 + 65 * (4/8) = 47.5 -> 48
    expect(last.percent).to.eq(48);
    expect(last.tasks).to.deep.eq({ images: { done: 4, total: 4 }, fonts: { done: 0, total: 4 } });
  });

  it('ignores malformed and non-protocol console lines', () => {
    const events: IRenderProgress[] = [];
    const reporter = new RenderProgressReporter('out.pdf', (p) => {
      events.push({ ...p });
    });
    const page = fakePage();

    reporter.attach(page as any);
    reporter.phase(RenderPhase.Loading);
    page.emit('console', consoleMsg('hello world'));
    page.emit('console', consoleMsg('__spinajs_progress__:not-json'));
    page.emit('console', consoleMsg('__spinajs_progress__:{"task":"","done":1,"total":2}'));
    page.emit('console', consoleMsg('__spinajs_progress__:{"task":"images","done":"x","total":2}'));
    page.emit('console', consoleMsg('__spinajs_progress__:{"task":"images","done":-1,"total":2}'));
    reporter.phase(RenderPhase.Loading);
    reporter.dispose();

    const last = events[events.length - 1];
    expect(last.tasks).to.eq(undefined);
  });

  it('falls back to the request approximation when no tasks are reported', () => {
    const events: IRenderProgress[] = [];
    const reporter = new RenderProgressReporter('out.pdf', (p) => {
      events.push({ ...p });
    });
    const page = fakePage();

    reporter.attach(page as any);
    reporter.phase(RenderPhase.Loading);
    page.emit('request');
    page.emit('request');
    page.emit('requestfinished');
    reporter.phase(RenderPhase.Loading);
    reporter.dispose();

    const last = events[events.length - 1];
    // request approximation: 1 of 2 seen -> 15 + 65 * 0.5 = 47.5 -> 48
    expect(last.percent).to.eq(48);
    expect(last.tasks).to.eq(undefined);
  });

  it('detaches the console listener on dispose', () => {
    const reporter = new RenderProgressReporter('out.pdf', () => undefined);
    const page = fakePage();

    reporter.attach(page as any);
    expect(page.listenerCount('console')).to.eq(1);
    reporter.dispose();
    expect(page.listenerCount('console')).to.eq(0);
  });

  describe('parseProgressLine', () => {
    it('parses a valid protocol line', () => {
      expect(parseProgressLine('__spinajs_progress__:{"task":"images","done":3,"total":9}')).to.deep.eq({ task: 'images', done: 3, total: 9 });
    });

    it('returns null for non-protocol, malformed and invalid payloads', () => {
      expect(parseProgressLine('')).to.eq(null);
      expect(parseProgressLine('random line')).to.eq(null);
      expect(parseProgressLine('__spinajs_progress__:')).to.eq(null);
      expect(parseProgressLine('__spinajs_progress__:{"task":"x"}')).to.eq(null);
      expect(parseProgressLine('__spinajs_progress__:{"task":"x","done":1,"total":"y"}')).to.eq(null);
      expect(parseProgressLine('__spinajs_progress__:{"task":"x","done":1,"total":-2}')).to.eq(null);
    });
  });
});
