import 'mocha';
import { expect } from 'chai';
import { fingerprint, sanitizeSql } from '../src/explain/fingerprint.js';

describe('sanitizeSql', () => {
  it('replaces string and number literals with ?', () => {
    expect(sanitizeSql("SELECT * FROM `users` WHERE `Name` = 'ann' AND `Age` > 42 LIMIT 10")).to.equal('SELECT * FROM `users` WHERE `Name` = ? AND `Age` > ? LIMIT ?');
  });

  it('keeps backtick names, identifiers with digits and placeholders', () => {
    const sql = 'SELECT `col1`, t2.x FROM `Table 3` AS t2 WHERE t2.y = ?';
    expect(sanitizeSql(sql)).to.equal(sql);
  });

  it('reads a double-quoted token as a string unless the connection quotes identifiers that way', () => {
    const sql = 'SELECT "Name" FROM "users" WHERE "Kind" = \'admin\'';
    expect(sanitizeSql(sql)).to.equal('SELECT ? FROM ? WHERE ? = ?');
    expect(sanitizeSql(sql, true)).to.equal('SELECT "Name" FROM "users" WHERE "Kind" = ?');
  });

  it('treats a doubled quote as part of the literal', () => {
    expect(sanitizeSql("SELECT 'it''s', 1.5")).to.equal('SELECT ?, ?');
  });

  it('replaces exponent and hex number literals whole', () => {
    expect(sanitizeSql('SELECT * FROM t WHERE a = 1e10 AND b = 0xDEADBEEF AND c = 1.5e3 AND d = 1e-7')).to.equal('SELECT * FROM t WHERE a = ? AND b = ? AND c = ? AND d = ?');
  });

  it('replaces digit-separated, octal and binary number literals whole', () => {
    expect(sanitizeSql('SELECT * FROM t WHERE a = 1_000_000 AND b = 0o17 AND c = 0b101 AND d = 0xFF_FF AND e = 1_000.5')).to.equal('SELECT * FROM t WHERE a = ? AND b = ? AND c = ? AND d = ? AND e = ?');
  });

  it('keeps digits that are part of a name', () => {
    const sql = 'SELECT col_1, t2.x_0b1 FROM t_1_000 AS t2';
    expect(sanitizeSql(sql)).to.equal(sql);
  });

  it('drops the statement from the literal that holds a backslash on, whichever way the server reads the escape', () => {
    const mysql = "SELECT * FROM `users` WHERE `Kind` = 'a' AND `Name` = 'O\\'Brien' AND `Ssn` = '123-45-6789'";
    expect(sanitizeSql(mysql)).to.equal('SELECT * FROM `users` WHERE `Kind` = ? AND `Name` = ?');

    const postgres = 'SELECT "Id" FROM "users" WHERE "Name" = E\'O\\\'Brien\' AND "Ssn" = \'123-45-6789\'';
    expect(sanitizeSql(postgres, true)).to.equal('SELECT "Id" FROM "users" WHERE "Name" = E?');
  });

  it('drops the rest of a statement after a backslash outside a literal', () => {
    expect(sanitizeSql("SELECT 1 \\ 'secret'")).to.equal('SELECT ? ?');
  });
});

describe('fingerprint', () => {
  it('ignores literal values, whitespace and case', () => {
    expect(fingerprint('select * from t where a = 1')).to.equal(fingerprint("SELECT *\n  FROM t WHERE a = 'x'"));
  });

  it('treats IN lists of any length as one shape', () => {
    expect(fingerprint('SELECT * FROM t WHERE Id IN (?, ?, ?)')).to.equal(fingerprint('SELECT * FROM t WHERE Id IN (?)'));
  });

  it('treats multi-row VALUES as one shape', () => {
    expect(fingerprint('INSERT INTO t (a, b) VALUES (?, ?), (?, ?)')).to.equal(fingerprint('INSERT INTO t (a, b) VALUES (?, ?)'));
  });

  it('differs between tables', () => {
    expect(fingerprint('SELECT * FROM a')).to.not.equal(fingerprint('SELECT * FROM b'));
  });

  it('is 16 lowercase hex characters', () => {
    expect(fingerprint('SELECT 1')).to.match(/^[0-9a-f]{16}$/);
  });
});
