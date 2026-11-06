import * as chai from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { Column, Index, Model } from '../src/decorators.js';
import { extractModelDescriptor } from '../src/descriptor.js';
import { MODELS } from '../src/tokens.js';
import { ModelBase } from '../src/model.js';

const expect = chai.expect;

describe('@Column, @Index and @Model options', () => {
  it('@Column records the spec per property', () => {
    class Account extends ModelBase {
      @Column({ family: 'text', length: 320, unique: true })
      public Email: string;

      @Column()
      public Note: string;
    }
    expect(Object.fromEntries(extractModelDescriptor(Account)!.ColumnSpecs!)).to.deep.equal({ Email: { family: 'text', length: 320, unique: true }, Note: {} });
  });

  it('a subclass @Column does not reach the parent descriptor', () => {
    class Parent extends ModelBase {
      @Column({ length: 10 })
      public Code: string;
    }
    class Child extends Parent {
      @Column({ family: 'uuid' })
      public Ref: string;
    }
    expect([...extractModelDescriptor(Parent)!.ColumnSpecs!.keys()]).to.deep.equal(['Code']);
    expect([...extractModelDescriptor(Child)!.ColumnSpecs!.keys()]).to.deep.equal(['Code', 'Ref']);
  });

  it('@Index records indexes by name or by column list', () => {
    @Index(['Email'], { unique: true, name: 'people_email' })
    @Index(['LastName', 'FirstName'])
    class Person extends ModelBase {}
    expect(Object.fromEntries(extractModelDescriptor(Person)!.Indexes!)).to.deep.equal({
      people_email: { name: 'people_email', columns: ['Email'], unique: true },
      'LastName,FirstName': { columns: ['LastName', 'FirstName'], unique: false },
    });
  });

  it('@Index needs a column', () => {
    expect(() => Index([])).to.throw(InvalidArgument, '@Index needs at least one column');
  });

  describe('@Model options', () => {
    @Model('column_mode_exhaustive', { columns: 'exhaustive' })
    class ExhaustiveModel extends ModelBase {}

    @Model('column_mode_partial')
    class PartialModel extends ModelBase {}

    // @Model registers the class under the MODELS token into the root container; other suites resolve every registered model.
    // The single-argument `DI.unregister(X)` would remove X registered as its own type, not under MODELS (`di/src/container.ts:402`).
    after(() => {
      DI.unregister(MODELS.key, ExhaustiveModel);
      DI.unregister(MODELS.key, PartialModel);
    });

    it('sets the columns mode only when given', () => {
      expect(extractModelDescriptor(ExhaustiveModel)!.ColumnsMode).to.equal('exhaustive');
      expect(extractModelDescriptor(PartialModel)!.ColumnsMode).to.equal(undefined);
    });
  });
});
