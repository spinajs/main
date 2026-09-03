import 'mocha';
import { expect } from 'chai';

import { isProductionEnv } from '../src/redirect.js';

describe('isProductionEnv', () => {
  it('matches both production spellings', () => {
    expect(isProductionEnv('production')).to.equal(true);
    expect(isProductionEnv('prod')).to.equal(true);
  });

  it('tolerates case and surrounding whitespace', () => {
    // APP_ENV arrives from a shell, a Dockerfile or an ECS task definition, any of which
    // can introduce padding or capitals. A guard that misses those is not a guard.
    expect(isProductionEnv('  PROD ')).to.equal(true);
    expect(isProductionEnv('Production')).to.equal(true);
  });

  it('rejects every non-production environment', () => {
    expect(isProductionEnv('development')).to.equal(false);
    expect(isProductionEnv('local')).to.equal(false);
    expect(isProductionEnv('staging')).to.equal(false);
  });

  it('rejects empty and missing values', () => {
    // Not defaulting to production: an unset APP_ENV means a dev box, and defaulting the
    // other way would make the feature silently inert everywhere it is meant to work.
    expect(isProductionEnv('')).to.equal(false);
    expect(isProductionEnv('   ')).to.equal(false);
    expect(isProductionEnv(undefined)).to.equal(false);
  });

  it('does not match a name that merely contains production', () => {
    expect(isProductionEnv('preproduction')).to.equal(false);
    expect(isProductionEnv('prod-eu')).to.equal(false);
  });
});
