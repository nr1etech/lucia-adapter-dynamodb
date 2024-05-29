# A DynamoDB Adapter For [lucia-auth](https://github.com/lucia-auth/lucia)

This is a fork of [lucida-adapter-dynamodb](https://github.com/choutianxius/lucia-adapter-dynamodb).

These modifications were made to suit some specific needs which include

- An Expires column containing the seconds since epoch when the session expires which can be used with DynamoDB's TTL feature
- Support to override how user data is retrieved which could be from other data sources and not DynamoDB
- Support to fetch sessions with consistent read to DynamoDB
- Modifications to the original schema to reduce the number of calls needed to DynamoDB

## Install

```shell
npm i lucia-adapter-dynamodb
```

## Usage

```javascript
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBAdapter} from 'lucia-adapter-dynamodb';

const client = new DynamoDBClient({
  credentials: {
    accessKeyId: 'xxx',
    secretAccessKey: 'verysecret',
  },
  region: 'xx-xx-#',
});

const adapter = new DynamoDBAdapter(client, {
  // options
});

// pass the adapter to lucia
```

## DynamoDB Table Schemas

### Session Schema

| Field   | Pattern              |
| ------- | -------------------- |
| Pk      | Session#[Session ID] |
| Sk      | Session              |
| Gs1Pk   | User#[User ID]       |
| Gs1Sk   | Expires#[Expires]    |
| Gs2Pk   | Session              |
| Gs2Sk   | Expires#[Expires]    |
| Expires | Number               |

### User Schema

You may override the user schema by providing a custom `getUser` function to the adapter. The default schema is as
follows:

| Field | Pattern        |
| ----- | -------------- |
| Pk    | User#[User ID] |
| Sk    | User           |

### Table Creation Example

Here is an example of creating such a table
with [`@aws-sdk/client-dynamodb`](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/dynamodb/):

```typescript
const client = new DynamoDBClient({
  // DynamoDB configs
});

await client.send(
  new CreateTableCommand({
    TableName: 'LuciaAuthTable',
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
  })
);

await client.send(
  new UpdateTimeToLiveCommand({
    TableName: 'LuciaAuthTable',
    TimeToLiveSpecification: {
      AttributeName: 'Expires',
      Enabled: true,
    },
  })
);
```

## Constructor Options

The adapter constructor takes a `DynamoDBClient` instance from `@aws-sdk/client-dynamodb` as the first argument. A
configuration object can be passed as the second argument.

```typescript
class DynamoDBAdapter {
  constructor(client: DynamoDBClient, options?: DynamoDBAdapterOptions);
}
```

The configuration object can be specified as follows:

| Option Object Attribute | Type     | Default Value  | Usage                                                                                         |
| ----------------------- | -------- | -------------- | --------------------------------------------------------------------------------------------- |
| tableName               | string   | LuciaAuthTable | DynamoDB table name                                                                           |
| pk                      | string   | Pk             | Base table partition key name                                                                 |
| sk                      | string   | Sk             | Base table sort key name                                                                      |
| gsi1Name                | string   | Gs1            | Index name of the first GSI                                                                   |
| gsi1pk                  | string   | Gs1Pk          | First GSI partition key name                                                                  |
| gsi1sk                  | string   | Gs1Sk          | First GSI sort key name                                                                       |
| gsi2Name                | string   | Gs2            | Index name of the second GSI                                                                  |
| gsi2pk                  | string   | Gs2Pk          | Second GSI partition key name                                                                 |
| gsi2sk                  | string   | Gs2Sk          | Second GSI sort key name                                                                      |
| expires                 | string   | Expires        | Name of the column that stores the session expiration time in seconds since epoch             |
| extraUserAttributes     | string[] | []             | Names of non-key attributes in the DynamoDB table to be excluded from DatabaseUser objects    |
| extraSessionAttributes  | string[] | []             | Names of non-key attributes in the DynamoDB table to be excluded from DatabaseSession objects |
