# `@spinajs/authz-fs`

Checks every file action of `@spinajs/fs` providers with `@spinajs/authz` (`AuthzFsMiddleware`) and keeps per-file
rights in the ORM table `fs_acl`.

## Documentation

- [Package overview](../../docs/authz-fs/README.md)
- [Access modes and configuration](../../docs/authz-fs/01-access-modes-and-configuration.md)
- [Checks on file actions](../../docs/authz-fs/02-checks-on-file-actions.md)
- [File ACL](../../docs/authz-fs/03-file-acl.md)
- [Relation grants](../../docs/authz-fs/04-relation-grants.md)
- [Managing ACL rows](../../docs/authz-fs/05-managing-acl-rows.md)
- [Uploads and routes](../../docs/authz-fs/06-uploads-and-routes.md)
- [ACL store](../../docs/authz-fs/07-acl-store.md)

## Tests

`npm run test` runs the behaviour fixture B28 once per provider kind, in suites titled `local` (fsNative), `temp`
(fsTemp over fsNative) and `s3` (fsS3). The `s3` suites need localstack at `AUTHZ_FS_S3_ENDPOINT` (default
`http://localhost:4566`):

```sh
docker run --rm -d -p 4566:4566 -e SERVICES=s3 localstack/localstack
```

Without it they are skipped with a message. Set `AUTHZ_FS_S3=required` (the release gate job does) to make an
unreachable localstack fail them instead. Cases that cannot hold on S3 for a provider reason are listed, with the
reason, as pending tests (`test/support/on-s3.ts`). The ORM store suite runs on SQLite, and on Postgres and MySQL with
`AUTHZ_FS_DB=postgres,mysql` and the orm packages' test containers.
