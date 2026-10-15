import type { ParityAction, ParityDriver, ParityResult, SchedulerErrorCode } from '@spinajs/scheduler';
import { asRole, req } from './common.js';

export interface IHttpCall {
  method: 'get' | 'post' | 'patch';
  path: string;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
}

const at = (value: string) => encodeURIComponent(value);

// an undefined field would reach the query string as "undefined"
function defined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

export function toHttpCall(a: ParityAction): IHttpCall {
  switch (a.action) {
    case 'listSchedules':
      return { method: 'get', path: 'scheduler/schedules' };
    case 'getSchedule':
      return { method: 'get', path: `scheduler/schedules/${at(a.name)}` };
    case 'runNow':
      return { method: 'post', path: `scheduler/schedules/${at(a.name)}/runs`, body: defined({ params: a.params, force: a.force }) };
    case 'listRuns':
      return { method: 'get', path: 'scheduler/runs', query: defined({ schedule: a.schedule, status: a.status }) };
    case 'getRun':
      return { method: 'get', path: `scheduler/runs/${at(a.runId)}` };
    case 'cancel':
      return { method: 'post', path: `scheduler/runs/${at(a.runId)}/cancel` };
    case 'retry':
      return { method: 'post', path: `scheduler/runs/${at(a.runId)}/retry`, body: defined({ fromStep: a.fromStep, resume: a.resume }) };
    case 'retryFailed':
      return { method: 'post', path: `scheduler/schedules/${at(a.name)}/retry-failed`, body: { since: a.since } };
    case 'pause':
      return { method: 'post', path: `scheduler/schedules/${at(a.name)}/pause`, body: defined({ hard: a.hard }) };
    case 'resume':
      return { method: 'post', path: `scheduler/schedules/${at(a.name)}/resume` };
    case 'listErrors':
      return { method: 'get', path: 'scheduler/errors', query: defined({ schedule: a.schedule, status: a.status }) };
    case 'setErrorStatus':
      return { method: 'patch', path: `scheduler/errors/${at(a.fingerprint)}`, body: { status: a.status } };
    case 'prune':
      return { method: 'post', path: 'scheduler/prune' };
    default: {
      // a new core action fails the build here instead of silently skipping the HTTP driver
      const unmapped: never = a;
      throw new Error(`no HTTP route for ${JSON.stringify(unmapped)}`);
    }
  }
}

// 409 is shared by conflict and invalid-state; only RunConflict carries runId
export function codeFromHttp(status: number, body: Record<string, unknown>): SchedulerErrorCode {
  switch (status) {
    case 404:
      return 'not-found';
    case 400:
      return 'invalid-params';
    case 409:
      return 'runId' in body ? 'conflict' : 'invalid-state';
    default:
      return 'error';
  }
}

export function httpParityDriver(role = 'scheduler-admin'): ParityDriver {
  return {
    name: 'http',
    async invoke(action: ParityAction): Promise<ParityResult> {
      const call = toHttpCall(action);
      const headers = asRole(role);

      const res =
        call.method === 'get'
          ? await req().get(call.path).query(call.query ?? {}).set(headers)
          : call.method === 'post'
            ? await req().post(call.path).set(headers).send(call.body ?? {})
            : await req().patch(call.path).set(headers).send(call.body ?? {});

      return res.status < 300 ? { ok: true, value: res.body } : { ok: false, code: codeFromHttp(res.status, res.body ?? {}) };
    },
  };
}
