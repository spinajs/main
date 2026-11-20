import { afterEach, describe, expect, it } from 'vitest';
import { apiUrl, appBase, appUrl, studioBase } from './base';

const setBase = (content: string) => {
  const meta = document.createElement('meta');
  meta.name = 'spina-studio-base';
  meta.content = content;
  document.head.append(meta);
};

const setAppBase = (content: string) => {
  const meta = document.createElement('meta');
  meta.name = 'spina-app-base';
  meta.content = content;
  document.head.append(meta);
};

afterEach(() => document.head.querySelectorAll('meta[name="spina-studio-base"], meta[name="spina-app-base"]').forEach((meta) => meta.remove()));

describe('studio base path', () => {
  it('defaults to /_studio without the meta S6 injects', () => {
    expect(studioBase()).toBe('/_studio');
    expect(apiUrl('/traces')).toBe('/_studio/api/traces');
  });

  it('follows the meta and drops a trailing slash', () => {
    setBase('/ops/studio/');
    expect(studioBase()).toBe('/ops/studio');
    expect(apiUrl('/capabilities')).toBe('/ops/studio/api/capabilities');
  });

  it('encodes parameters and leaves out empty ones', () => {
    expect(apiUrl('/traces', { route: '/x/:id', status: undefined, minDurationMs: 5, principalId: '', cursor: null })).toBe('/_studio/api/traces?route=%2Fx%2F%3Aid&minDurationMs=5');
  });

  it('keeps endpoints of other packages at the app root', () => {
    setBase('/ops/studio');
    expect(appUrl('/telemetry/timeline', { buckets: 60 })).toBe('/telemetry/timeline?buckets=60');
  });

  it('puts the app route prefix in front of endpoints of other packages', () => {
    setAppBase('/api');
    expect(appBase()).toBe('/api');
    expect(appUrl('/scheduler/runs', { limit: 50 })).toBe('/api/scheduler/runs?limit=50');
  });

  it('reads an empty app base, and a missing one, as no prefix', () => {
    expect(appBase()).toBe('');
    setAppBase('');
    expect(appBase()).toBe('');
    expect(appUrl('/telemetry/stats')).toBe('/telemetry/stats');
  });
});
