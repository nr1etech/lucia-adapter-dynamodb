import {test, beforeEach, afterEach} from 'vitest';
import {databaseUser, testAdapter} from '@lucia-auth/adapter-test';
import {DynamoDBAdapter} from './index';
import {
  CreateTableCommand,
  DynamoDBClient,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';
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
      TableName: 'LuciaAuthTable',
      AttributeDefinitions: [
        {AttributeName: 'sid', AttributeType: 'S'},
        {AttributeName: 'uid', AttributeType: 'S'},
        {AttributeName: 'typ', AttributeType: 'S'},
        {AttributeName: 'exp', AttributeType: 'N'},
      ],
      KeySchema: [
        {AttributeName: 'sid', KeyType: 'HASH'}, // primary key
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'Gs1',
          Projection: {ProjectionType: 'ALL'},
          KeySchema: [
            {AttributeName: 'uid', KeyType: 'HASH'}, // GSI primary key
          ],
        },
        {
          IndexName: 'Gs2',
          Projection: {ProjectionType: 'ALL'},
          KeySchema: [
            {AttributeName: 'typ', KeyType: 'HASH'}, // GSI primary key
            {AttributeName: 'exp', KeyType: 'RANGE'}, // GSI sort key
          ],
        },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );

  await context.client.send(
    new UpdateTimeToLiveCommand({
      TableName: TableName,
      TimeToLiveSpecification: {
        AttributeName: 'exp',
        Enabled: true,
      },
    }),
  );
}, 60000);

afterEach(async (context: LocalTestContext) => {
  if (context.client) {
    await context.container.stop();
  }
});

test('Test DynamoDBAdapter', async (context: LocalTestContext) => {
  const adapter = new DynamoDBAdapter({
    client: context.client,
    tableName: TableName,
    getUser: async () => {
      return {
        id: databaseUser.id,
        attributes: {
          ...databaseUser.attributes,
        },
      };
    },
  });
  await testAdapter(adapter);
});
