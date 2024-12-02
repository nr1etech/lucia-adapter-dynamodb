import {
  BatchWriteItemCommand,
  DeleteItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type AttributeValue,
  type DynamoDBClient,
  type QueryCommandInput,
  GetItemCommand,
} from '@aws-sdk/client-dynamodb';
import {marshall, unmarshall} from '@aws-sdk/util-dynamodb';
import type {Adapter, DatabaseSession, DatabaseUser} from 'lucia';

const MAX_BATCH_SIZE = 25;

export type GetUserFn = (
  userId: string,
  client: DynamoDBClient,
) => Promise<DatabaseUser | null>;

export interface DynamoDBAdapterProps {
  /**
   * The DynamoDB client to use.
   */
  client: DynamoDBClient;

  /**
   * The name of the DynamoDB table to use. Default is 'LuciaAuthTable'.
   */
  tableName?: string;

  /**
   * Extra attributes to exclude from the user object. Default is an empty array.
   */
  extraUserAttributes?: string[];

  /**
   * Extra attributes to exclude from the session object. Default is an empty array.
   */
  extraSessionAttributes?: string[];

  /**
   * Overrides the default implementation to retrieve user data.
   *
   * @param client the DynamoDBClient
   * @param userId the user ID
   */
  getUser: GetUserFn;

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
  private getUser: GetUserFn;
  private consistentRead: boolean;

  constructor(options: DynamoDBAdapterProps) {
    this.client = options.client;
    if (options.tableName) this.tableName = options.tableName;
    this.getUser = options.getUser;
    this.consistentRead = options?.consistentRead ?? false;
  }

  public async deleteSession(sessionId: string): Promise<void> {
    await this.client.send(
      new DeleteItemCommand({
        TableName: this.tableName,
        Key: {
          sid: {S: sessionId},
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
        IndexName: 'Gs1',
        KeyConditionExpression: '#uid = :uid',
        ExpressionAttributeNames: {
          '#uid': 'uid',
          '#sid': 'sid',
        },
        ExpressionAttributeValues: {
          ':uid': {S: userId},
        },
        Select: 'SPECIFIC_ATTRIBUTES',
        ProjectionExpression: '#sid',
      };
      if (_lastEvaluatedKey) commandInput.ExclusiveStartKey = _lastEvaluatedKey;
      const res = await this.client.send(new QueryCommand(commandInput));
      if (res?.Items?.length) {
        const expiredSessions = res.Items.map((x) => unmarshall(x));
        keys.push(
          ...expiredSessions.map((item) => ({
            sid: {S: item.sid},
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
      new GetItemCommand({
        TableName: this.tableName,
        Key: {
          sid: {S: sessionId},
        },
        ConsistentRead: this.consistentRead,
      }),
    );
    if (!sessionRes.Item) return [null, null];
    const session = this.itemToSession(sessionRes.Item);
    const user: DatabaseUser | null = await this.getUser(
      session.userId,
      this.client,
    );
    return [session, user];
  }

  public async getUserSessions(userId: string): Promise<DatabaseSession[]> {
    const sessions: DatabaseSession[] = [];
    let _lastEvaluatedKey: Record<string, AttributeValue> | undefined =
      undefined;

    do {
      const commandInput: QueryCommandInput = {
        TableName: this.tableName,
        IndexName: 'Gs1',
        ExpressionAttributeNames: {
          '#uid': 'uid',
        },
        ExpressionAttributeValues: {
          ':uid': {S: userId},
        },
        KeyConditionExpression: '#uid = :uid',
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
          sid: databaseSession.id,
          uid: databaseSession.userId,
          exp: expires,
          typ: 'Session',
          attrs: databaseSession.attributes,
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
            sid: {S: sessionId},
          },
          UpdateExpression: 'SET #exp = :exp',
          ConditionExpression: '#sid = :sid',
          ExpressionAttributeNames: {
            '#sid': 'sid',
            '#exp': 'exp',
          },
          ExpressionAttributeValues: {
            ':exp': {N: `${expires}`},
            ':sid': {S: sessionId},
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
        IndexName: 'Gs2',
        ExpressionAttributeNames: {
          '#sid': 'sid',
          '#exp': 'exp',
          '#typ': 'typ',
        },
        ExpressionAttributeValues: {
          ':typ': {S: 'Session'},
          ':exp': {N: `${now}`},
        },
        KeyConditionExpression: '#typ = :typ AND #exp < :exp',
        Select: 'SPECIFIC_ATTRIBUTES',
        ProjectionExpression: '#sid',
      };
      if (_lastEvaluatedKey) commandInput.ExclusiveStartKey = _lastEvaluatedKey;
      const res = await this.client.send(new QueryCommand(commandInput));
      if (res?.Items?.length) {
        const expiredSessions = res.Items.map((x) => unmarshall(x));
        keys.push(
          ...expiredSessions.map((item) => ({
            sid: {S: item.sid},
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

  private itemToSession(item: Record<string, AttributeValue>): DatabaseSession {
    const unmarshalled = unmarshall(item);
    return {
      id: unmarshalled.sid,
      userId: unmarshalled.uid,
      expiresAt: new Date(unmarshalled.exp * 1000),
      attributes: unmarshalled.attrs,
    };
  }
}
