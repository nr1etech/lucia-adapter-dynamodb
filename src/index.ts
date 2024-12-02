import {
  BatchWriteItemCommand,
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
  type DynamoDBClient,
  type QueryCommandInput,
} from '@aws-sdk/client-dynamodb';
import {marshall, unmarshall} from '@aws-sdk/util-dynamodb';
import type {Adapter, DatabaseSession, DatabaseUser} from 'lucia';

const MAX_BATCH_SIZE = 25;

export type GetUserFn = (
  client: DynamoDBClient,
  userId: string,
) => Promise<DatabaseUser | null>;

export interface DynamoDBAdapterOptions {
  /**
   * The name of the DynamoDB table to use. Default is 'LuciaAuthTable'.
   */
  tableName?: string;

  /**
   * Attribute name on the DynamoDB table to hold the partition key. Default is 'Pk'.
   */
  pk?: string;

  /**
   * Attribute name on the DynamoDB table to hold the sort key. Default is 'Sk'.
   */
  sk?: string;

  /**
   * Name of the first GSI to use. Default is 'Gs1'.
   */
  gsi1Name?: string;

  /**
   * Attribute name on the DynamoDB table to hold the GSI1 partition key. Default is 'Gs1Pk'.
   */
  gsi1pk?: string;

  /**
   * Attribute name on the DynamoDB table to hold the GSI1 sort key. Default is 'Gs1Sk'.
   */
  gsi1sk?: string;

  /**
   * Name of the second GSI to use. Default is 'Gs2'.
   */
  gsi2Name?: string;

  /**
   * Attribute name on the DynamoDB table to hold the GSI2 partition key. Default is 'Gs2Pk'.
   */
  gsi2pk?: string;

  /**
   * Attribute name on the DynamoDB table to hold the GSI2 sort key. Default is 'Gs2Sk'.
   */
  gsi2sk?: string;

  /**
   * Extra attributes to exclude from the user object. Default is an empty array.
   */
  extraUserAttributes?: string[];

  /**
   * Extra attributes to exclude from the session object. Default is an empty array.
   */
  extraSessionAttributes?: string[];

  /**
   * Attribute name on the DynamoDB table to hold the expires value. Default is 'Expires'.
   */
  expires?: string;

  /**
   * Overrides the default implementation to retrieve user data.
   *
   * @param client the DynamoDBClient
   * @param userId the user ID
   */
  getUser?: GetUserFn;

  /**
   * Whether to use consistent read when querying the table during getSessionAndUser. Default is false.
   */
  consistentRead?: boolean;
}

/**
 * Adapter using two GSIs
 */
export class DynamoDBAdapter implements Adapter {
  private client: DynamoDBClient;
  private tableName: string = 'LuciaAuthTable';
  private pk: string = 'Pk';
  private sk: string = 'Sk';
  private gsi1Name: string = 'Gs1';
  private gsi1pk: string = 'Gs1Pk';
  private gsi1sk: string = 'Gs1Sk';
  private gsi2Name: string = 'Gs2';
  private gsi2pk: string = 'Gs2Pk';
  private gsi2sk: string = 'Gs2Sk';
  private extraUserAttributes: string[] = [];
  private extraSessionAttributes: string[] = [];
  private expires: string;
  private getUser?: GetUserFn;
  private consistentRead: boolean;

  constructor(client: DynamoDBClient, options?: DynamoDBAdapterOptions) {
    this.client = client;
    if (options?.tableName) this.tableName = options.tableName;
    if (options?.pk) this.pk = options.pk;
    if (options?.sk) this.sk = options.sk;
    if (options?.gsi1Name) this.gsi1Name = options.gsi1Name;
    if (options?.gsi1pk) this.gsi1pk = options.gsi1pk;
    if (options?.gsi1sk) this.gsi1sk = options.gsi1sk;
    if (options?.gsi2Name) this.gsi2Name = options.gsi2Name;
    if (options?.gsi2pk) this.gsi2pk = options.gsi2pk;
    if (options?.gsi2sk) this.gsi2sk = options.gsi2sk;
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
    this.expires = options?.expires ?? 'Expires';
    this.getUser = options?.getUser;
    this.consistentRead = options?.consistentRead ?? false;
  }

  public async deleteSession(sessionId: string): Promise<void> {
    await this.client.send(
      new DeleteItemCommand({
        TableName: this.tableName,
        Key: {
          [this.pk]: {S: `Session#${sessionId}`},
          [this.sk]: {S: 'Session'},
        },
      }),
    );
  }

  public async deleteUserSessions(userId: string): Promise<void> {
    const keys = [];
    let _lastEvaluatedKey: Record<string, AttributeValue> | undefined =
      undefined;

    // get all keys to delete
    do {
      const commandInput: QueryCommandInput = {
        TableName: this.tableName,
        IndexName: this.gsi1Name,
        KeyConditionExpression:
          '#gs1pk = :gs1pk AND begins_with(#gs1sk, :gs1sk_prefix)',
        ExpressionAttributeNames: {
          '#gs1pk': this.gsi1pk,
          '#gs1sk': this.gsi1sk,
          '#pk': this.pk,
          '#sk': this.sk,
        },
        ExpressionAttributeValues: {
          ':gs1pk': {S: `User#${userId}`},
          ':gs1sk_prefix': {S: 'Expires#'},
        },
        Select: 'SPECIFIC_ATTRIBUTES',
        ProjectionExpression: '#pk, #sk',
      };
      if (_lastEvaluatedKey) commandInput.ExclusiveStartKey = _lastEvaluatedKey;
      const res = await this.client.send(new QueryCommand(commandInput));
      if (res?.Items?.length) {
        keys.push(
          ...res.Items.map((item) => ({
            [this.pk]: item[this.pk],
            [this.sk]: item[this.sk],
          })),
        );
      }
      _lastEvaluatedKey = res?.LastEvaluatedKey;
    } while (_lastEvaluatedKey);

    // delete all keys
    for (let i = 0; i < keys.length; i += MAX_BATCH_SIZE) {
      const batch = keys.slice(i, i + MAX_BATCH_SIZE);
      await this.client.send(
        new BatchWriteItemCommand({
          RequestItems: {
            [this.tableName]: batch.map((key) => ({
              DeleteRequest: {Key: key},
            })),
          },
        }),
      );
    }
  }

  public async getSessionAndUser(
    sessionId: string,
  ): Promise<[session: DatabaseSession | null, user: DatabaseUser | null]> {
    const sessionRes = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: '#pk = :pk AND #sk = :sk',
        ExpressionAttributeNames: {
          '#pk': this.pk,
          '#sk': this.sk,
        },
        ExpressionAttributeValues: {
          ':pk': {S: `Session#${sessionId}`},
          ':sk': {S: 'Session'},
        },
        ConsistentRead: this.consistentRead,
      }),
    );
    if (!sessionRes?.Items?.length) return [null, null];
    const session = this.itemToSession(sessionRes.Items[0]);

    let user: DatabaseUser | null = null;
    if (this.getUser) {
      user = await this.getUser(this.client, session.userId);
    } else {
      const userRes = await this.client.send(
        new GetItemCommand({
          TableName: this.tableName,
          Key: {
            [this.pk]: {S: `User#${session.userId}`},
            [this.sk]: {S: 'User'},
          },
        }),
      );
      if (!userRes?.Item) return [session, null];
      user = this.itemToUser(userRes.Item);
    }
    return [session, user];
  }

  public async getUserSessions(userId: string): Promise<DatabaseSession[]> {
    const sessions: DatabaseSession[] = [];
    let _lastEvaluatedKey: Record<string, AttributeValue> | undefined =
      undefined;

    do {
      const commandInput: QueryCommandInput = {
        TableName: this.tableName,
        IndexName: this.gsi1Name,
        ExpressionAttributeNames: {
          '#gs1pk': this.gsi1pk,
          '#gs1sk': this.gsi1sk,
        },
        ExpressionAttributeValues: {
          ':gs1pk': {S: `User#${userId}`},
          ':gs1sk_prefix': {S: 'Expires#'},
        },
        KeyConditionExpression:
          '#gs1pk = :gs1pk AND begins_with(#gs1sk, :gs1sk_prefix)',
      };
      if (_lastEvaluatedKey) commandInput.ExclusiveStartKey = _lastEvaluatedKey;
      const res = await this.client.send(new QueryCommand(commandInput));
      if (res?.Items?.length) {
        sessions.push(...res.Items.map((x) => this.itemToSession(x)));
      }
      _lastEvaluatedKey = res?.LastEvaluatedKey;
    } while (_lastEvaluatedKey);

    return sessions;
  }

  public async setSession(databaseSession: DatabaseSession): Promise<void> {
    const expires = Math.floor(databaseSession.expiresAt.getTime() / 1000);
    await this.client.send(
      new PutItemCommand({
        TableName: this.tableName,
        Item: marshall({
          [this.pk]: `Session#${databaseSession.id}`,
          [this.sk]: 'Session',
          [this.gsi1pk]: `User#${databaseSession.userId}`,
          [this.gsi1sk]: `Expires#${expires}`,
          [this.gsi2pk]: 'Session',
          [this.gsi2sk]: `Expires#${expires}`,
          [this.expires]: expires,
          ...databaseSession.attributes,
        }),
      }),
    );
  }

  public async updateSessionExpiration(
    sessionId: string,
    expiresAt: Date,
  ): Promise<void> {
    if (expiresAt.getTime() > Date.now()) {
      const expires = Math.floor(expiresAt.getTime() / 1000);
      // update the session
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: {
            [this.pk]: {S: `Session#${sessionId}`},
            [this.sk]: {S: 'Session'},
          },
          UpdateExpression:
            'SET #gs1sk = :gs1sk, #gs2sk = :gs2sk, #expires = :expires',
          ConditionExpression: '#pk = :pk AND #sk = :sk',
          ExpressionAttributeNames: {
            '#gs1sk': this.gsi1sk,
            '#gs2sk': this.gsi2sk,
            '#expires': this.expires,
            '#pk': this.pk,
            '#sk': this.sk,
          },
          ExpressionAttributeValues: {
            ':gs1sk': {S: `Expires#${expires}`},
            ':gs2sk': {S: `Expires#${expires}`},
            ':expires': {N: `${expires}`},
            ':pk': {S: `Session#${sessionId}`},
            ':sk': {S: 'Session'},
          },
        }),
      );
    } else {
      await this.deleteSession(sessionId);
    }
  }

  public async deleteExpiredSessions(): Promise<void> {
    const now = Math.floor(new Date().getTime() / 1000);
    // get all expired session keys to delete
    let _lastEvaluatedKey: Record<string, AttributeValue> | undefined =
      undefined;
    const keys = [];
    do {
      const commandInput: QueryCommandInput = {
        TableName: this.tableName,
        IndexName: this.gsi2Name,
        ExpressionAttributeNames: {
          '#pk': this.pk,
          '#sk': this.sk,
          '#gs2pk': this.gsi2pk,
          '#gs2sk': this.gsi2sk,
        },
        ExpressionAttributeValues: {
          ':gs2pk': {S: 'Session'},
          ':gs2sk_end': {S: `Expires#${now}`},
        },
        KeyConditionExpression: '#gs2pk = :gs2pk AND #gs2sk < :gs2sk_end',
        Select: 'SPECIFIC_ATTRIBUTES',
        ProjectionExpression: '#pk, #sk',
      };
      if (_lastEvaluatedKey) commandInput.ExclusiveStartKey = _lastEvaluatedKey;
      const res = await this.client.send(new QueryCommand(commandInput));
      if (res?.Items?.length) {
        const expiredSessions = res.Items.map((x) => unmarshall(x));
        keys.push(
          ...expiredSessions.map((x) => ({
            [this.pk]: {S: x[this.pk]},
            [this.sk]: {S: x[this.sk]},
          })),
        );
      }
      _lastEvaluatedKey = res?.LastEvaluatedKey;
    } while (_lastEvaluatedKey);

    // delete all expired session keys
    for (let i = 0; i < keys.length; i += MAX_BATCH_SIZE) {
      const batch = keys.slice(i, i + MAX_BATCH_SIZE);
      await this.client.send(
        new BatchWriteItemCommand({
          RequestItems: {
            [this.tableName]: batch.map((key) => ({
              DeleteRequest: {Key: key},
            })),
          },
        }),
      );
    }
  }

  private itemToUser(item: Record<string, AttributeValue>): DatabaseUser {
    const unmarshalled = unmarshall(item);
    const {
      [this.pk]: pk,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      [this.sk]: sk,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      [this.gsi1pk]: gsi1pk,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      [this.gsi1sk]: gsi1sk,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      [this.gsi2pk]: gsi2pk,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      [this.gsi2sk]: gsi2sk,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      [this.expires]: expires,
      ...rest
    } = unmarshalled;

    const attributes = {};
    for (const key in rest) {
      if (!this.extraUserAttributes.includes(key)) {
        Object.assign(attributes, {[key]: rest[key]});
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
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      [this.sk]: sk,
      [this.gsi1pk]: gsi1pk,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      [this.gsi1sk]: gsi1sk,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      [this.gsi2pk]: gsi2pk,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      [this.gsi2sk]: gsi2sk,
      [this.expires]: expires,
      ...rest
    } = unmarshalled;

    const attributes = {};
    for (const key in rest) {
      if (!this.extraSessionAttributes.includes(key)) {
        Object.assign(attributes, {[key]: rest[key]});
      }
    }

    return {
      id: pk.split('#')[1],
      userId: gsi1pk.split('#')[1],
      expiresAt: new Date(expires * 1000),
      attributes,
    };
  }
}
