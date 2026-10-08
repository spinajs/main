import 'mocha';
import { expect } from 'chai';

import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { DataValidator } from '@spinajs/validation';

import { CreateUserDto, UpdateUserDto } from '../src/admin/controllers/Users/Users.js';

import { TestConfiguration } from './admin-common.js';

/**
 * The JSON schemas applied to the admin bodies, run through the real validator.
 *
 * `users-controller.test.ts` calls handlers directly and walks past them; PATCH once
 * shared the creation schema, so every documented partial update was rejected. The
 * route descriptors (`@Access`, policies, verbs) are pinned in
 * `test/v3/route-contract-access.test.ts`. No server is started.
 */

describe('Admin route contract', function () {
  this.timeout(25000);

  before(async () => {
    DI.setESMModuleSupport();
    DI.register(TestConfiguration).as(Configuration);

    await DI.resolve(Configuration);
  });

  after(() => {
    DI.clearCache();
  });

  describe('body schemas', () => {
    let validator: DataValidator;

    before(async () => {
      validator = await DI.resolve(DataValidator);
    });

    it('accepts a partial update', () => {
      expect(() => validator.validate(new UpdateUserDto({ Login: 'renamed' }))).to.not.throw();
      expect(() => validator.validate(new UpdateUserDto({ Email: 'renamed@spinajs.pl' }))).to.not.throw();
      expect(() => validator.validate(new UpdateUserDto({}))).to.not.throw();
    });

    it('rejects an update carrying fields this endpoint does not manage', () => {
      // Metadata used to be merged here from arbitrary request keys, which is
      // how a caller could write `user:pwd_reset:token` or a `*` glob.
      expect(() => validator.validate(new UpdateUserDto({ Metadata: { 'user:pwd_reset:token': 'x' } } as any))).to.throw();
    });

    it('still requires the full set of fields on creation', () => {
      expect(() => validator.validate(new CreateUserDto({ Login: 'newbie' } as any))).to.throw();
      expect(() => validator.validate(new CreateUserDto({ Login: 'newbie', Email: 'newbie@spinajs.pl', Role: 'user' }))).to.not.throw();
    });

    it('rejects a malformed email on creation', () => {
      expect(() => validator.validate(new CreateUserDto({ Login: 'newbie', Email: 'not-an-email', Role: 'user' }))).to.throw();
    });

    it('accepts one role name or a list of them', () => {
      expect(() => validator.validate(new CreateUserDto({ Login: 'newbie', Email: 'newbie@spinajs.pl', Role: ['user', 'guest'] }))).to.not.throw();
      expect(() => validator.validate(new UpdateUserDto({ Role: 'user' }))).to.not.throw();
      expect(() => validator.validate(new UpdateUserDto({ Role: ['user', 'guest'] }))).to.not.throw();
    });

    /**
     * An account that holds no role at all can do nothing and can only be
     * repaired by another administrator, so a list naming no role is refused
     * rather than applied. `[]` is caught by `minItems`; `['  ', '']` is the
     * case `minLength` cannot see — every entry is a valid string of allowed
     * length — and is why the role name carries a pattern that refuses blanks.
     */
    it('refuses a role list that names no role', () => {
      expect(() => validator.validate(new CreateUserDto({ Login: 'blank', Email: 'blank@spinajs.pl', Role: [] }))).to.throw();
      expect(() => validator.validate(new CreateUserDto({ Login: 'blank', Email: 'blank@spinajs.pl', Role: ['  ', ''] }))).to.throw();
      expect(() => validator.validate(new CreateUserDto({ Login: 'blank', Email: 'blank@spinajs.pl', Role: ' ' }))).to.throw();

      expect(() => validator.validate(new UpdateUserDto({ Role: [] }))).to.throw();
      expect(() => validator.validate(new UpdateUserDto({ Role: ['  ', ''] }))).to.throw();
      expect(() => validator.validate(new UpdateUserDto({ Role: ' ' }))).to.throw();
    });

    /**
     * Edge whitespace is banned so `uniqueItems` stays honest: `'user'` and
     * `' user '` denote ONE role, and the role guard is charged per entry.
     */
    it('refuses padded and duplicated role names', () => {
      expect(() => validator.validate(new UpdateUserDto({ Role: [' user ', 'guest'] }))).to.throw();
      expect(() => validator.validate(new UpdateUserDto({ Role: ['user', 'user'] }))).to.throw();
    });

    it('takes a role name by the rule the configuration applies (ROLE_NAME_PATTERN, ROLE_NAME_MAX_LENGTH)', () => {
      expect(() => validator.validate(new UpdateUserDto({ Role: ['Stock editor'] }))).to.not.throw();
      expect(() => validator.validate(new UpdateUserDto({ Role: 'r'.repeat(128) }))).to.not.throw();
      for (const bad of [' admin', '7up', 'true', '-1', 'r'.repeat(129)]) {
        expect(() => validator.validate(new UpdateUserDto({ Role: [bad] })), bad).to.throw();
      }
    });

    /** Every entry costs a guard check, so the list has a ceiling. */
    it('refuses more roles than one account may be given', () => {
      const tooMany = Array.from({ length: 17 }, (_, i) => `role${i}`);

      expect(() => validator.validate(new UpdateUserDto({ Role: tooMany }))).to.throw();
    });
  });
});
