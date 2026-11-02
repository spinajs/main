import * as chai from 'chai';
import 'mocha';
import { compareMigrationNames } from '../src/migration-runner.js';

const expect = chai.expect;

describe('compareMigrationNames', () => {
  it('orders by the timestamp in the name', () => {
    expect(compareMigrationNames('B_2021_01_01_00_00_00', 'A_2021_01_02_00_00_00')).to.be.lessThan(0);
    expect(compareMigrationNames('A_2021_01_02_00_00_00', 'B_2021_01_01_00_00_00')).to.be.greaterThan(0);
  });

  it('ignores the free prefix when the timestamps differ', () => {
    const sorted = ['Alpha_2021_01_04_00_00_00', 'Zeta_2021_01_02_00_00_00'].sort(compareMigrationNames);

    expect(sorted).to.eql(['Zeta_2021_01_02_00_00_00', 'Alpha_2021_01_04_00_00_00']);
  });

  it('breaks a timestamp tie by name', () => {
    const sorted = ['B_2021_01_01_00_00_00', 'A_2021_01_01_00_00_00'].sort(compareMigrationNames);

    expect(sorted).to.eql(['A_2021_01_01_00_00_00', 'B_2021_01_01_00_00_00']);
    expect(compareMigrationNames('A_2021_01_01_00_00_00', 'A_2021_01_01_00_00_00')).to.equal(0);
  });

  it('compares the time of day, not only the date', () => {
    expect(compareMigrationNames('A_2021_01_01_09_00_00', 'A_2021_01_01_10_00_00')).to.be.lessThan(0);
  });

  it('sorts a name without a parsable timestamp after every parsable one, by name', () => {
    const sorted = ['b_unparsable', 'Z_2099_12_31_23_59_59', 'a_unparsable', 'A_2021_01_01_00_00_00', 'X_2021_13_45_00_00_00'].sort(compareMigrationNames);

    // 2021_13_45 matches the pattern but is not a date
    expect(sorted).to.eql(['A_2021_01_01_00_00_00', 'Z_2099_12_31_23_59_59', 'a_unparsable', 'b_unparsable', 'X_2021_13_45_00_00_00']);
  });
});
