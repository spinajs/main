-- The SQL Server image has no MSSQL_DATABASE equivalent to the mysql image's, so the schema
-- the orm-mssql suite connects to has to be created explicitly
-- ( packages/orm-mssql/test/mssql.test.ts -> Database: 'test' ).
--
-- Without it `tedious` reports "Login failed for user 'sa'", which is misleading: the login
-- itself is fine, it is the database context that cannot be established.
IF DB_ID('test') IS NULL
  CREATE DATABASE [test];
GO
