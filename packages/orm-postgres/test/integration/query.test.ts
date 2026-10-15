/* eslint-disable @typescript-eslint/no-explicit-any */
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { RawQuery } from '@spinajs/orm';

import './migrations/PgCoreMigration_2026_10_15_00_00_00.js';
import { IPgSuite, openSuite } from './harness.js';
import { PgPerson, PgPet } from './models/core.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

const names = (rows: PgPerson[]) => rows.map((r) => r.Name);

describe('postgres integration - querying', function () {
  let suite: IPgSuite;

  before(async function () {
    suite = await openSuite(this, { name: 'query' });
  });

  beforeEach(async () => {
    await suite.reset('pg_pet', 'pg_person');
    await PgPerson.insert([
      { Name: 'Alice', Age: 30, City: 'Warsaw' },
      { Name: 'Bob', Age: 25, City: 'Krakow' },
      { Name: 'Carol', Age: 35, City: null },
      { Name: 'Dave', Age: 40, City: 'Warsaw' },
      { Name: 'Eve', Age: 22, City: 'Gdansk' },
    ] as any);
    await PgPet.insert([
      { Name: 'Rex', person_id: 1 },
      { Name: 'Tom', person_id: 1 },
      { Name: 'Kit', person_id: 4 },
    ] as any);
  });

  after(async () => {
    await suite?.close();
  });

  it('filters with comparison operators', async () => {
    expect(names(await PgPerson.where('Age', '>', 30).orderBy('Id'))).to.deep.equal(['Carol', 'Dave']);
  });

  it('filters by object, IN and NULL', async () => {
    expect(names(await PgPerson.where({ City: 'Warsaw' }).orderBy('Id'))).to.deep.equal(['Alice', 'Dave']);
    expect(names(await PgPerson.query().whereIn('Name', ['Bob', 'Eve']).orderBy('Id'))).to.deep.equal(['Bob', 'Eve']);
    expect(names(await PgPerson.query().whereNull('City'))).to.deep.equal(['Carol']);
    expect((await PgPerson.query().whereNotNull('City')).length).to.equal(4);
  });

  it('filters by BETWEEN', async () => {
    expect(names(await PgPerson.query().whereBetween('Age', [25, 35]).orderBy('Id'))).to.deep.equal(['Alice', 'Bob', 'Carol']);
  });

  it('matches LIKE', async () => {
    expect(names(await PgPerson.where('Name', 'like', 'A%'))).to.deep.equal(['Alice']);
  });

  it('groups OR conditions inside AND', async () => {
    const rows = await PgPerson.where(function () {
      this.where('City', 'Krakow').orWhere('City', 'Gdansk');
    })
      .where('Age', '<', 24)
      .orderBy('Id');

    expect(names(rows)).to.deep.equal(['Eve']);
  });

  it('accepts a raw predicate with bindings', async () => {
    expect(names(await PgPerson.where(RawQuery.create('"Age" % ? = 0', [10])).orderBy('Id'))).to.deep.equal(['Alice', 'Dave']);
  });

  it('pages with LIMIT and OFFSET', async () => {
    expect(names(await PgPerson.all().orderBy('Id').take(2).skip(1))).to.deep.equal(['Bob', 'Carol']);
  });

  it('skips without a limit (bare OFFSET)', async () => {
    expect(names(await PgPerson.all().orderBy('Id').skip(3))).to.deep.equal(['Dave', 'Eve']);
  });

  it('orders descending', async () => {
    expect(names(await PgPerson.all().orderByDescending('Age').take(2))).to.deep.equal(['Dave', 'Carol']);
  });

  it('filters by a sub-query', async () => {
    const owners = PgPet.query().select('person_id');
    expect(names(await PgPerson.query().whereIn('Id', owners as any).orderBy('Id'))).to.deep.equal(['Alice', 'Dave']);
  });

  it('filters by existence of a hasMany relation (EXISTS)', async () => {
    expect(names(await PgPerson.query().whereExist('Pets').orderBy('Id'))).to.deep.equal(['Alice', 'Dave']);
  });

  it('joins the owner of a belongsTo through populate', async () => {
    const pet = await PgPet.where('Name', 'Kit').populate('Owner').first();
    expect(pet.Owner.Value!.Name).to.equal('Dave');
  });

  it('populates a hasMany', async () => {
    const alice = await PgPerson.where({ Id: 1 }).populate('Pets').first();
    expect(alice.Pets.map((p) => p.Name).sort()).to.deep.equal(['Rex', 'Tom']);
  });

  it('counts per group', async () => {
    const rows = (await suite.driver
      .select()
      .from('pg_person')
      .count('*', 'n')
      .select('City')
      .whereNotNull('City')
      .groupBy('City')
      .orderBy('City')
      .asRaw()) as { City: string; n: string | number }[];

    expect(rows.map((r) => [r.City, Number(r.n)])).to.deep.equal([
      ['Gdansk', 1],
      ['Krakow', 1],
      ['Warsaw', 2],
    ]);
  });

  it('answers selectCount with a number', async () => {
    expect(await PgPerson.query().selectCount()).to.equal(5);
  });
});
