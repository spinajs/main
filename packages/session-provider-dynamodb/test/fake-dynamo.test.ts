import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { ConditionalCheckFailedException, CreateTableCommand, DeleteItemCommand, GetItemCommand, PutItemCommand, ScanCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { FakeDynamo } from './fake-dynamo.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const TableName = 't';

async function table(): Promise<FakeDynamo> {
  const fake = new FakeDynamo();
  await fake.send(new CreateTableCommand({ TableName, AttributeDefinitions: [{ AttributeName: 'SessionId', AttributeType: 'S' }], KeySchema: [{ AttributeName: 'SessionId', KeyType: 'HASH' }] }));
  return fake;
}

/** The fake is what the conformance runs against, so it must reject and accept what DynamoDB does for the commands the store sends. */
describe('FakeDynamo fidelity', () => {
  it('an UpdateItem without a condition creates a missing item, as DynamoDB does', async () => {
    const fake = await table();
    await fake.send(new UpdateItemCommand({ TableName, Key: { SessionId: { S: 'x' } }, UpdateExpression: 'SET #d = :d', ExpressionAttributeNames: { '#d': 'Data' }, ExpressionAttributeValues: { ':d': { S: 'v' } } }));
    expect(fake.items.get('x')).to.deep.equal({ SessionId: { S: 'x' }, Data: { S: 'v' } });
  });

  it('a failed ConditionExpression throws ConditionalCheckFailedException and writes nothing', async () => {
    const fake = await table();
    const update = new UpdateItemCommand({
      TableName,
      Key: { SessionId: { S: 'x' } },
      UpdateExpression: 'SET #d = :d',
      ConditionExpression: 'attribute_exists(#id) AND (attribute_not_exists(#e) OR #e > :now)',
      ExpressionAttributeNames: { '#d': 'Data', '#id': 'SessionId', '#e': 'Expiration' },
      ExpressionAttributeValues: { ':d': { S: 'v' }, ':now': { N: '100' } },
    });
    await expect(fake.send(update)).to.be.rejectedWith(ConditionalCheckFailedException);
    expect(fake.items.has('x')).to.be.false;

    fake.items.set('x', { SessionId: { S: 'x' }, Expiration: { N: '99' } });
    await expect(fake.send(update)).to.be.rejectedWith(ConditionalCheckFailedException);
    fake.items.set('x', { SessionId: { S: 'x' }, Expiration: { N: '101' } });
    await fake.send(update);
    expect(fake.items.get('x')!.Data).to.deep.equal({ S: 'v' });
  });

  it('numbers compare numerically, and a type mismatch is false', async () => {
    const fake = await table();
    fake.items.set('a', { SessionId: { S: 'a' }, E: { N: '9' } });
    fake.items.set('b', { SessionId: { S: 'b' }, E: { N: '10' } });
    fake.items.set('c', { SessionId: { S: 'c' }, E: { S: '99' } });
    fake.pageSize = 10;

    const page = (await fake.send(new ScanCommand({ TableName, FilterExpression: '#e > :n', ExpressionAttributeNames: { '#e': 'E' }, ExpressionAttributeValues: { ':n': { N: '9' } } }))) as { Items: { SessionId: { S: string } }[] };
    expect(page.Items.map((i) => i.SessionId.S)).to.deep.equal(['b']);
  });

  it('refuses unused or undefined placeholders and raw attribute names', async () => {
    const fake = await table();
    const scan = (input: Partial<ConstructorParameters<typeof ScanCommand>[0]>) => fake.send(new ScanCommand({ TableName, ...input }));

    await expect(scan({ FilterExpression: '#s = :v', ExpressionAttributeNames: { '#s': 'Subject' }, ExpressionAttributeValues: { ':v': { S: 'x' }, ':unused': { S: 'y' } } })).to.be.rejectedWith(/unused/);
    await expect(scan({ FilterExpression: '#s = :v', ExpressionAttributeNames: { '#s': 'Subject' } })).to.be.rejectedWith(/not defined/);
    await expect(scan({ FilterExpression: 'Data = :v', ExpressionAttributeValues: { ':v': { S: 'x' } } })).to.be.rejectedWith(/placeholders/);
  });

  it('a Scan filters after reading the page and pages through LastEvaluatedKey', async () => {
    const fake = await table();
    for (const id of ['a', 'b', 'c', 'd']) {
      fake.items.set(id, { SessionId: { S: id }, Keep: { S: id === 'd' ? 'yes' : 'no' } });
    }

    const filter = { FilterExpression: '#k = :y', ExpressionAttributeNames: { '#k': 'Keep' }, ExpressionAttributeValues: { ':y': { S: 'yes' } } };
    const first = (await fake.send(new ScanCommand({ TableName, ...filter }))) as { Items: unknown[]; LastEvaluatedKey?: Record<string, unknown> };
    expect(first.Items).to.deep.equal([]);
    expect(first.LastEvaluatedKey).to.deep.equal({ SessionId: { S: 'b' } });

    const second = (await fake.send(new ScanCommand({ TableName, ...filter, ExclusiveStartKey: first.LastEvaluatedKey as never }))) as { Items: unknown[]; LastEvaluatedKey?: unknown };
    expect(second.Items).to.have.length(1);
    expect(second.LastEvaluatedKey).to.equal(undefined);
  });

  it('DeleteItem with ReturnValues ALL_OLD returns the item it removed, and nothing for a missing one', async () => {
    const fake = await table();
    await fake.send(new PutItemCommand({ TableName, Item: { SessionId: { S: 'x' }, V: { S: '1' } } }));

    expect(await fake.send(new DeleteItemCommand({ TableName, Key: { SessionId: { S: 'x' } }, ReturnValues: 'ALL_OLD' }))).to.deep.equal({ Attributes: { SessionId: { S: 'x' }, V: { S: '1' } } });
    expect(await fake.send(new DeleteItemCommand({ TableName, Key: { SessionId: { S: 'x' } }, ReturnValues: 'ALL_OLD' }))).to.deep.equal({ Attributes: undefined });
    expect(await fake.send(new GetItemCommand({ TableName, Key: { SessionId: { S: 'x' } } }))).to.deep.equal({ Item: undefined });
  });

  it('item commands on a missing table fail with ResourceNotFoundException', async () => {
    await expect(new FakeDynamo().send(new GetItemCommand({ TableName, Key: { SessionId: { S: 'x' } } }))).to.be.rejected.and.eventually.have.property('name', 'ResourceNotFoundException');
  });
});
