# `@spinajs/email-verification-dynamodb`

DynamoDB store for `@spinajs/email-verification` (AWS SDK v3). Select it with
`emailVerification.store: 'DynamoDbEmailVerificationStore'`. It creates the table `emailVerification.dynamodb.table`
(hash key `pk`, on-demand billing, TTL on `ExpiresAt`) unless `createTable` is false.
