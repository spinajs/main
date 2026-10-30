import type Express from 'express';
import { DI, token } from '@spinajs/di';
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
  checkResponse(route: ContractRoute, body: unknown): ContractErrors | null;
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

export class ResponseContractViolation extends Exception {
  public constructor(public readonly violation: ContractViolation) {
    super(`${violation.controller}.${violation.handler} answered ${violation.status} with a body that breaks its contract: ${JSON.stringify(violation.errors)}`);
  }
}

interface ContractSettings {
  enabled?: boolean;
  mode?: 'throw' | 'log';
}

function check(res: Express.Response, route: ContractRoute | undefined, body: unknown, validator: ContractValidator): ContractViolation | undefined {
  const sent: unknown = JSON.parse(JSON.stringify(body));
  const problem = isProblem(body);
  const errors = problem ? validator.checkSchema(PROBLEM_DETAILS_SCHEMA, sent) : route && res.statusCode >= 200 && res.statusCode < 300 ? validator.checkResponse(route, sent) : null;

  if (!errors || errors.length === 0) {
    return undefined;
  }
  return { controller: route?.controller ?? '', handler: route?.handler ?? '', kind: problem ? 'problem' : 'response', status: res.statusCode, errors };
}

/**
 * Validates the JSON body of this response when `http.contractTesting.enabled` is set and a validator is registered.
 * A problem document must match PROBLEM_DETAILS_SCHEMA; a 2xx body must match the route's schema. In `throw` mode a
 * response violation fails the request with a 500; a problem violation is only recorded, since the error path has no
 * other answer to give.
 */
export function guardResponseContract(res: Express.Response, route?: ContractRoute): void {
  const settings = DI.get(Configuration)?.get<ContractSettings>('http.contractTesting', {}) ?? {};
  const validator = DI.get(CONTRACT_VALIDATOR);
  if (!settings.enabled || !validator) {
    return;
  }

  const json = res.json;
  res.json = function (this: Express.Response, body?: unknown) {
    // One shot: a thrown violation must not trap the error response that follows in the same guard.
    res.json = json;

    const violation = body === undefined || body === null ? undefined : check(res, route, body, validator);
    if (violation) {
      DI.get(CONTRACT_VIOLATIONS)?.record(violation);
      DI.resolve(Log, ['http']).error({ violation }, 'Response contract violation in ${violation.controller}.${violation.handler}');
      if (violation.kind === 'response' && settings.mode !== 'log') {
        throw new ResponseContractViolation(violation);
      }
    }
    return json.call(this, body);
  } as Express.Response['json'];
}
