import type {
  Adapter,
  DatabaseSession,
  DatabaseUser,
} from 'lucia';
import {
  BatchWriteItemCommand,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
  type AttributeValue,
  type DynamoDBClient,
  type QueryCommandInput,
  type ScanCommandInput,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';


export class DynamoDBAdapter implements Adapter {
  private client: DynamoDBClient;
  private tableName: string = 'LuciaAuthTable';
  private pk: string = 'pk';
  private sk: string = 'sk';
  private gsiName: string = 'GSI1';
  private gsi1pk: string = 'GSI1PK';
  private gsi1sk: string = 'GSI1SK';
  private expiresAt: string = 'expiresAt';
  private extraUserAttributes: string[] = [];
  private extraSessionAttributes: string[] = [];

  constructor(client: DynamoDBClient, options?: {
    tableName?: string;
    pk?: string;
    sk?: string;
    gsiName?: string,
    gsi1pk?: string;
    gsi1sk?: string;
    expiresAt?: string;
    extraUserAttributes?: string[];
    extraSessionAttributes?: string[];
  }) {
    this.client = client;
    if (options?.tableName) this.tableName = options.tableName;
    if (options?.pk) this.pk = options.pk;
    if (options?.sk) this.sk = options.sk;
    if (options?.gsiName) this.gsiName = options.gsiName;
    if (options?.gsi1pk) this.gsi1pk = options.gsi1pk;
    if (options?.gsi1sk) this.gsi1sk = options.gsi1sk;
    if (options?.expiresAt) this.expiresAt = options.expiresAt;
    if (options?.extraUserAttributes) {
      this.extraUserAttributes = [
        ...this.extraUserAttributes,
        ...options.extraUserAttributes,
      ];
    }
    if (options?.extraSessionAttributes) {
      this.extraSessionAttributes = [
        ...this.extraSessionAttributes,
        ...options.extraSessionAttributes,
      ];
    }
  }

  public async deleteSession(sessionId: string): Promise<void> {
    // get key of the session to delete
    const [session, user] = await this.getSessionAndUser(sessionId);
    if (!session) return;

    await this.client.send(new DeleteItemCommand({
      TableName: this.tableName,
      Key: {
        [this.pk]: { S: `USER#${session.userId}` },
        [this.sk]: { S: `SESSION#${sessionId}` },
      },
    }));
  }

  public async deleteUserSessions(userId: string): Promise<void> {
    const keys = [];
    let _lastEvaluatedKey: Record<string, AttributeValue> | undefined = undefined;

    // get all keys to delete
    do {
      const commandInput: QueryCommandInput = {
        TableName: this.tableName,
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :sk_prefix)',
        ExpressionAttributeNames: {
          '#pk': this.pk,
          '#sk': this.sk,
        },
        ExpressionAttributeValues: {
          ':pk': { S: `USER#${userId}` },
          ':sk_prefix': { S: 'SESSION#' },
        },
        Select: 'SPECIFIC_ATTRIBUTES',
        ProjectionExpression: '#pk, #sk',
      };
      if (_lastEvaluatedKey) commandInput.ExclusiveStartKey = _lastEvaluatedKey;
      const res = await this.client.send(new QueryCommand(commandInput));
      if (res?.Items?.length) {
        keys.push(...res.Items.map((item) => ({
          [this.pk]: item[this.pk],
          [this.sk]: item[this.sk],
        })));
      }
      _lastEvaluatedKey = res?.LastEvaluatedKey;
    } while (_lastEvaluatedKey)

    // delete all keys
    const BATCH_SIZE = 25; // AWS DynamoDB rejects whole batch if batch size exceeds this limit
    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
      const batch = keys.slice(i, i + BATCH_SIZE);
      await this.client.send(new BatchWriteItemCommand({
        RequestItems: {
          [this.tableName]: batch.map((key) => ({
            DeleteRequest: { Key: key },
          })),
        },
      }));
    }
  }

  public async getSessionAndUser(
    sessionId: string
  ): Promise<[session: DatabaseSession | null, user: DatabaseUser | null]> {
    const sessionRes = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      IndexName: this.gsiName,
      KeyConditionExpression: '#gsi1pk = :gsi1pk AND #gsi1sk = :gsi1sk',
      ExpressionAttributeNames: {
        '#gsi1pk': this.gsi1pk,
        '#gsi1sk': this.gsi1sk,
      },
      ExpressionAttributeValues: {
        ':gsi1pk': { S: `SESSION#${sessionId}` },
        ':gsi1sk': { S: `SESSION#${sessionId}` },
      },
    }));
    if (!sessionRes?.Items?.length) return [null, null];
    const session = this.itemToSession(sessionRes.Items[0]);
  
    const userRes = await this.client.send(new GetItemCommand({
      TableName: this.tableName,
      Key: {
        [this.pk]: { S: `USER#${session.userId}` },
        [this.sk]: { S: `USER#${session.userId}` },
      },
    }));
    if (!userRes?.Item) return [session, null];
    const user = this.itemToUser(userRes.Item);

    return [session, user];
  }

  public async getUserSessions(userId: string): Promise<DatabaseSession[]> {
    const sessions: DatabaseSession[] = [];
    let _lastEvaluatedKey: Record<string, AttributeValue> | undefined = undefined;

    do {
      const commandInput: QueryCommandInput = {
        TableName: this.tableName,
        ExpressionAttributeNames: {
          '#pk': this.pk,
          '#sk': this.sk,
        },
        ExpressionAttributeValues: {
          ':pk': { S: `USER#${userId}` },
          ':sk_prefix': { S: 'SESSION#' },
        },
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :sk_prefix)',
      };
      if (_lastEvaluatedKey) commandInput.ExclusiveStartKey = _lastEvaluatedKey;
      const res = await this.client.send(new QueryCommand(commandInput));
      if (res?.Items?.length) {
        sessions.push(...res.Items.map((x) => this.itemToSession(x)));
      }
      _lastEvaluatedKey = res?.LastEvaluatedKey;
    } while (_lastEvaluatedKey)

    return sessions;
  }

  public async setSession(databaseSession: DatabaseSession): Promise<void> {
    await this.client.send(new PutItemCommand({
      TableName: this.tableName,
      Item: marshall({
        [this.pk]: `USER#${databaseSession.userId}`,
        [this.sk]: `SESSION#${databaseSession.id}`,
        [this.expiresAt]: Math.floor(databaseSession.expiresAt.getTime() / 1000).toString(),
        [this.gsi1pk]: `SESSION#${databaseSession.id}`,
        [this.gsi1sk]: `SESSION#${databaseSession.id}`,
        ...databaseSession.attributes,
      }),
    }));
  }

  public async updateSessionExpiration(sessionId: string, expiresAt: Date): Promise<void> {
    // get key of the session to update
    const sessionRes = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      IndexName: this.gsiName,
      KeyConditionExpression: '#gsi1pk = :gsi1pk AND #gsi1sk = :gsi1sk',
      ExpressionAttributeNames: {
        '#gsi1pk': this.gsi1pk,
        '#gsi1sk': this.gsi1sk,
      },
      ExpressionAttributeValues: {
        ':gsi1pk': { S: `SESSION#${sessionId}` },
        ':gsi1sk': { S: `SESSION#${sessionId}` },
      },
    }));
    if (!sessionRes?.Items?.length) return;
    const session = this.itemToSession(sessionRes.Items[0]);

    // update the session
    await this.client.send(new UpdateItemCommand({
      TableName: this.tableName,
      Key: {
        [this.pk]: { S: `USER#${session.userId}` },
        [this.sk]: { S: `SESSION#${sessionId}` },
      },
      UpdateExpression: 'SET #expiresAt = :expiresAt',
      ExpressionAttributeNames: {
        '#expiresAt': this.expiresAt,
      },
      ExpressionAttributeValues: {
        ':expiresAt': { N: Math.floor(expiresAt.getTime() / 1000).toString() },
      },
    }));
  }

  public async deleteExpiredSessions(): Promise<void> {
    // get all expired session keys to delete
    let _lastEvaluatedKey: Record<string, AttributeValue> | undefined = undefined;
    const keys = [];

    do {
      const commandInput: ScanCommandInput = {
        TableName: this.tableName,
        ExpressionAttributeNames: {
          '#pk': this.pk,
          '#sk': this.sk,
          '#expires_at': this.expiresAt,
        },
        ExpressionAttributeValues: {
          ':sk_prefix': { S: 'SESSION#' },
        },
        FilterExpression: 'begins_with(#sk, :sk_prefix)', // unable to use two filters in the same scan?
        Select: 'SPECIFIC_ATTRIBUTES',
        ProjectionExpression: '#pk, #sk, #expires_at',
      }
      if (_lastEvaluatedKey) commandInput.ExclusiveStartKey = _lastEvaluatedKey;
      const res = await this.client.send(new ScanCommand(commandInput));
      if (res?.Items?.length) {
        const expiredSessions = res.Items
          .map((x) => unmarshall(x))
          .filter((x) => x[this.expiresAt] < Math.floor(Date.now() / 1000));

        keys.push(...expiredSessions.map((x) => ({
          [this.pk]: { S: x[this.pk] },
          [this.sk]: { S: x[this.sk] },
        })));
      }
      _lastEvaluatedKey = res?.LastEvaluatedKey;
    } while (_lastEvaluatedKey)

    // delete all expired session keys
    const BATCH_SIZE = 25; // AWS DynamoDB rejects whole batch if batch size exceeds this limit
    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
      const batch = keys.slice(i, i + BATCH_SIZE);
      await this.client.send(new BatchWriteItemCommand({
        RequestItems: {
          [this.tableName]: batch.map((key) => ({
            DeleteRequest: { Key: key },
          })),
        },
      }));
    }
  }

  private itemToUser(item: Record<string, any>): DatabaseUser {
    const unmarshalled = unmarshall(item);
    const {
      [this.pk]: pk,
      [this.sk]: sk,
      [this.gsi1pk]: gsi1pk,
      [this.gsi1sk]: gsi1sk,
      ...rest
    } = unmarshalled;

    const attributes = {};
    for (const key in rest) {
      if (!this.extraUserAttributes.includes(key)) {
        Object.assign(attributes, { [key]: rest[key] });
      }
    }

    return {
      id: pk.split('#')[1],
      attributes,
    };
  }

  private itemToSession(item: Record<string, AttributeValue>): DatabaseSession {
    const unmarshalled = unmarshall(item);
    const {
      [this.pk]: pk,
      [this.sk]: sk,
      [this.gsi1pk]: gsi1pk,
      [this.gsi1sk]: gsi1sk,
      [this.expiresAt]: expiresAt,
      ...rest
    } = unmarshalled;

    const attributes = {};
    for (const key in rest) {
      if (!this.extraSessionAttributes.includes(key)) {
        Object.assign(attributes, { [key]: rest[key] });
      }
    }

    return {
      id: sk.split('#')[1],
      userId: pk.split('#')[1],
      expiresAt: new Date(parseInt(expiresAt) * 1000),
      attributes,
    };
  }

}