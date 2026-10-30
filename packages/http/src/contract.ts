import type Express from 'express';
import { DI, token } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Exception } from '@spinajs/exceptions';
import { Log } from '@spinajs/log';
import { isProblem, PROBLEM_DETAILS_SCHEMA } from './problem.js';

export interface ContractRoute {
  controller: string;
  handler: string;
}

/** Ajv errors, or any list that explains why the body breaks the schema. */
export type ContractErrors = readonly unknown[];

export interface ContractValidator {
  /** `null`: the body matches, or the route has no schema that can be checked. */
  checkResponse(route: ContractRoute, body: unknown, status?: number): ContractErrors | null;
  checkSchema(schema: object, body: unknown): ContractErrors | null;
}

export interface ContractViolation extends ContractRoute {
  kind: 'response' | 'problem';
  status: number;
  errors: ContractErrors;
}

export interface ContractViolations {
  readonly count: number;
  readonly list: readonly ContractViolation[];
  record(violation: ContractViolation): void;
}

export const CONTRACT_VALIDATOR = token<ContractValidator>('__http_contract_validator__');
export const CONTRACT_VIOLATIONS = token<ContractViolations>('__http_contract_violations__');

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class ResponseContractViolation extends Exception {
  public constructor(public readonly violation: ContractViolation) {
    super(`${violation.controller}.${violation.handler} answered ${violation.status} with a body that breaks its contract: ${safeStringify(violation.errors)}`);
  }
}

interface ContractSettings {
  enabled?: boolean;
  mode?: 'throw' | 'log';
}

function check(res: Express.Response, route: ContractRoute | undefined, body: unknown, validator: ContractValidator): ContractViolation | undefined {
  const problem = isProblem(body);
  const where = { controller: route?.controller ?? '', handler: route?.handler ?? '', kind: problem ? ('problem' as const) : ('response' as const), status: res.statusCode };

  let sent: unknown;
  try {
    sent = JSON.parse(JSON.stringify(body));
  } catch (err) {
    return { ...where, errors: [{ message: `body cannot be serialized to JSON: ${(err as Error).message}` }] };
  }

  const errors = problem ? validator.checkSchema(PROBLEM_DETAILS_SCHEMA, sent) : route ? validator.checkResponse(route, sent, res.statusCode) : null;
  return errors && errors.length > 0 ? { ...where, errors } : undefined;
}

/**
 * Validates the JSON body of this response when `http.contractTesting.enabled` is set and a validator is registered
 * in `container` (the one serving the request). A problem document must match PROBLEM_DETAILS_SCHEMA; any other body
 * must match the schema the route declares for its status. In `throw` mode a response violation fails the request
 * with a 500; a problem violation is only recorded, since the error path has no other answer to give.
 * Only `res.json` is observed: file, stream and other non-JSON bodies are not checked.
 */
export function guardResponseContract(res: Express.Response, container: IContainer, route?: ContractRoute): void {
  const settings = container.get(Configuration)?.get<ContractSettings>('http.contractTesting', {}) ?? {};
  const validator = container.get(CONTRACT_VALIDATOR);
  if (!settings.enabled || !validator) {
    return;
  }

  const json = res.json;
  res.json = function (this: Express.Response, body?: unknown) {
    // One shot: a thrown violation must not trap the error response that follows in the same guard.
    res.json = json;

    const violation = body === undefined || body === null ? undefined : check(res, route, body, validator);
    if (violation) {
      container.get(CONTRACT_VIOLATIONS)?.record(violation);
      DI.resolve(Log, ['http']).error({ violation }, 'Response contract violation in ${violation.controller}.${violation.handler}');
      if (violation.kind === 'response' && settings.mode !== 'log') {
        throw new ResponseContractViolation(violation);
      }
    }
    return json.call(this, body);
  } as Express.Response['json'];
}
