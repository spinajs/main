# `@spinajs/session-provider-dynamodb`

DynamoDB session store for `@spinajs/authn-session`: `DynamoDbSessionProvider` keeps one item per session, through the AWS SDK v3 client. Select it with `authn.session.service: 'DynamoDbSessionProvider'` and name the table in `authn.session.aws.table`.

## Documentation

- [Package overview](../../docs/session-provider-dynamodb/README.md)
- [DynamoDB session store](../../docs/session-provider-dynamodb/01-dynamodb-session-store.md)
- [Client and table provisioning](../../docs/session-provider-dynamodb/02-client-and-table-provisioning.md)
- [Subject lookup](../../docs/session-provider-dynamodb/03-subject-lookup.md)
