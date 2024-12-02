import {test, beforeEach, afterEach} from 'vitest';
import {testAdapter, databaseUser} from '@lucia-auth/adapter-test';
import {DynamoDBAdapter} from '../src/index.js';
import {
  CreateTableCommand,
  DynamoDBClient,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import {marshall} from '@aws-sdk/util-dynamodb';
import {StartedTestContainer, GenericContainer, Wait} from 'testcontainers';

const TableName = 'LuciaAuthTable';

interface LocalTestContext {
  container: StartedTestContainer;
  client: DynamoDBClient;
}

beforeEach(async (context: LocalTestContext) => {
  context.container = await new GenericContainer('amazon/dynamodb-local:latest')
    .withExposedPorts({container: 8000, host: 8000})
    .withCommand(['-jar', 'DynamoDBLocal.jar', '-sharedDb', '-inMemory'])
    .withWorkingDir('/home/dynamodblocal')
    .withWaitStrategy(Wait.forListeningPorts())
    .start();

  context.client = new DynamoDBClient({
    credentials: {
      accessKeyId: 'dummy',
      secretAccessKey: 'dummy',
    },
    region: 'dummy',
    endpoint: process.env.DYNAMODB_ENDPOINT_URL ?? `http://127.0.0.1:8000`,
  });

  await context.client.send(
    new CreateTableCommand({
      TableName: TableName,
      AttributeDefinitions: [
        {AttributeName: 'Pk', AttributeType: 'S'},
        {AttributeName: 'Sk', AttributeType: 'S'},
        {AttributeName: 'Gs1Pk', AttributeType: 'S'},
        {AttributeName: 'Gs1Sk', AttributeType: 'S'},
        {AttributeName: 'Gs2Pk', AttributeType: 'S'},
        {AttributeName: 'Gs2Sk', AttributeType: 'S'},
      ],
      KeySchema: [
        {AttributeName: 'Pk', KeyType: 'HASH'}, // primary key
        {AttributeName: 'Sk', KeyType: 'RANGE'}, // sort key
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'Gs1',
          Projection: {ProjectionType: 'ALL'},
          KeySchema: [
            {AttributeName: 'Gs1Pk', KeyType: 'HASH'}, // GSI primary key
            {AttributeName: 'Gs1Sk', KeyType: 'RANGE'}, // GSI sort key
          ],
          ProvisionedThroughput: {
            ReadCapacityUnits: 5,
            WriteCapacityUnits: 5,
          },
        },
        {
          IndexName: 'Gs2',
          Projection: {ProjectionType: 'ALL'},
          KeySchema: [
            {AttributeName: 'Gs2Pk', KeyType: 'HASH'}, // GSI primary key
            {AttributeName: 'Gs2Sk', KeyType: 'RANGE'}, // GSI sort key
          ],
          ProvisionedThroughput: {
            ReadCapacityUnits: 5,
            WriteCapacityUnits: 5,
          },
        },
      ],
      ProvisionedThroughput: {
        ReadCapacityUnits: 5,
        WriteCapacityUnits: 5,
      },
    }),
  );

  await context.client.send(
    new PutItemCommand({
      TableName: TableName,
      Item: marshall({
        Pk: `User#${databaseUser.id}`,
        Sk: 'User',
        HashedPassword: '123456',
        ...databaseUser.attributes,
      }),
    }),
  );
}, 60000);

afterEach(async (context: LocalTestContext) => {
  if (context.client) {
    await context.container.stop();
  }
});

test('Test DynamoDBAdapter', async (context: LocalTestContext) => {
  const adapter = new DynamoDBAdapter(context.client, {
    tableName: TableName,
    extraUserAttributes: ['HashedPassword'],
  });
  await testAdapter(adapter);
});
