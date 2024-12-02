# A DynamoDB Adapter For [lucia-auth](https://github.com/lucia-auth/lucia)

[![NPM Version][npm-image]][npm-url]
[![GitHub Actions][github-image]][github-url]

This is a fork of [lucida-adapter-dynamodb](https://github.com/choutianxius/lucia-adapter-dynamodb).

These modifications were made to suit some specific needs which include

- An exp column containing the seconds since epoch when the session expires which can be used with DynamoDB's TTL feature
- Support to fetch user data from an external source
- Support to fetch sessions with consistent read to DynamoDB
- Modifications to the original schema to reduce the number of calls to DynamoDB
- Modifications to table to reduce storage and data transfer requirements.
- Enforced field names to provide an opinionated schema

## Install

```shell
pnpm add @nr1e/lucia-adapter-dynamodb
```

## Usage

```javascript
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBAdapter} from 'lucia-adapter-dynamodb';

const client = new DynamoDBClient({});

const adapter = new DynamoDBAdapter(client, {
    // options
});

// pass the adapter to lucia
```

## DynamoDB Table Schemas

### Session Schema

| Field | Value      | Type   | Note     |
| :---- | :--------- | :----- | :------- |
| sid   | Session ID | string | Pk       |
| uid   | User ID    | string | Gs1 - pk |
| exp   | Expiration | number | Gs2 - sk |
| typ   | 'Session'  | string | Gs2 - pk |

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

await client.send(
    new UpdateTimeToLiveCommand({
        TableName: 'LuciaAuthTable',
        TimeToLiveSpecification: {
            AttributeName: 'exp',
            Enabled: true,
        },
    }),
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
| extraUserAttributes     | string[] | []             | Names of non-key attributes in the DynamoDB table to be excluded from DatabaseUser objects    |
| extraSessionAttributes  | string[] | []             | Names of non-key attributes in the DynamoDB table to be excluded from DatabaseSession objects |

[github-url]: https://github.com/nr1etech/lucia-adapter-dynamodb/actions
[github-image]: https://github.com/nr1etech/lucia-adapter-dynamodb/workflows/ci/badge.svg
[npm-url]: https://npmjs.org/package/@nr1e/lucia-adapter-dynamodb
[npm-image]: https://img.shields.io/npm/v/@nr1e/lucia-adapter-dynamodb.svg
