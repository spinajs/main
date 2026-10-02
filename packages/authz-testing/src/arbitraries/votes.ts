import * as fc from 'fast-check';

import { FALSE } from '@spinajs/authz';
import type { DenyReason, FieldSet, ResourceFilter, Vote } from '@spinajs/authz';

import { DEFAULT_FIELDS, DEFAULT_ROLES, dateInRange, fromPool, sparse, word } from './common.js';
import type { NowOption } from './common.js';
import { filter } from './filters.js';
import type { FilterOptions } from './filters.js';

export interface DenyReasonOptions {
  /** Code pool; `[]` leaves custom codes only. */
  readonly codes?: readonly string[];
  readonly model?: string;
}

const CORE_CODES = ['no_access', 'ceiling', 'role_too_low', 'tag_missing', 'provenance', 'residual_false'];

/** `priority` and `sortKey` are each absent or set; extra payload keys never collide with the named ones. */
export function denyReason(opts: DenyReasonOptions = {}): fc.Arbitrary<DenyReason> {
  const codes = opts.codes ?? CORE_CODES;
  const custom = word().map((w) => `custom_${w}`);
  const code = codes.length ? fc.oneof({ weight: 4, arbitrary: fromPool(codes) }, { weight: 1, arbitrary: custom }) : custom;
  return fc.record(
    {
      code,
      ...(opts.model === undefined ? {} : { model: fc.constant(opts.model) }),
      priority: fc.integer({ min: 0, max: 999 }),
      sortKey: fromPool(['a', 'b', 'c']),
      needed: fromPool(DEFAULT_ROLES),
      tag: word(),
    },
    { requiredKeys: opts.model === undefined ? ['code'] : ['code', 'model'] },
  ) as fc.Arbitrary<DenyReason>;
}

export interface VoteOptions extends FilterOptions, NowOption {
  /** Default 'm'. */
  readonly model?: string;
  readonly maxDenies?: number;
  readonly codes?: readonly string[];
  /** false: never set `error`. Otherwise about 1 vote in 10 carries one. */
  readonly errors?: boolean;
}

const fieldSet = (fields: readonly string[]): fc.Arbitrary<FieldSet> =>
  fc.record({ read: fc.subarray([...fields]), write: fc.subarray([...fields]), hide: fc.subarray([...fields]) }, { requiredKeys: [] });

interface VoteParts {
  permitWhen: ResourceFilter;
  denyWhen: ResourceFilter;
  cacheable: boolean;
  denies?: { when: ResourceFilter; reason: DenyReason }[];
  error?: string;
  reason?: DenyReason;
  fields?: FieldSet;
  validUntil?: Date;
  roles?: Record<string, string>;
}

/**
 * With `denies`, `denyWhen` is exactly the OR of their `when`s (the contract's "OR = denyWhen");
 * without, `denyWhen` is a free filter or FALSE. Every reason carries the vote's model.
 * Optional parts are present about a third of the time, `error` about one time in ten, so most
 * votes are normal ones.
 */
export function vote(opts: VoteOptions = {}): fc.Arbitrary<Vote> {
  const model = opts.model ?? 'm';
  const f = filter(opts);
  const reason = denyReason({ codes: opts.codes, model });
  const denies = fc.array(fc.record({ when: f, reason }), { maxLength: opts.maxDenies ?? 3 });
  const denyWhen = fc.oneof({ weight: 1, arbitrary: fc.constant(FALSE) }, { weight: 2, arbitrary: f });

  return sparse(
    {
      permitWhen: f,
      denyWhen,
      cacheable: fc.boolean(),
      denies,
      error: fromPool(['boom', 'timeout']),
      reason,
      fields: fieldSet(opts.fields ?? DEFAULT_FIELDS),
      validUntil: dateInRange(opts.now),
      roles: fc.dictionary(fromPool(['project', 'org']), fromPool(DEFAULT_ROLES), { maxKeys: 2 }),
    },
    { permitWhen: 100, denyWhen: 100, cacheable: 100, denies: 50, error: opts.errors === false ? 0 : 10 },
  ).map((r): Vote => {
    const { denies: ds, denyWhen: dw, ...rest } = r as unknown as VoteParts;
    const combined: ResourceFilter = ds && ds.length > 0 ? { op: 'or', args: ds.map((d) => d.when) } : dw;
    return { model, ...rest, denyWhen: combined, ...(ds && ds.length > 0 ? { denies: ds } : {}) } as Vote;
  });
}
