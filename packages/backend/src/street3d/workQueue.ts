/**
 * The durable work queue, as a GoWay interface, and its SQS adapter.
 *
 * ## What the queue is for, and what it is not
 *
 * Two queues connect the backend to the external worker (see
 * `docs/STREET3D_PIPELINE.md`): `jobs` carries job envelopes out, `events`
 * carries heartbeats, completions and failures back. Delivery is AT LEAST ONCE,
 * which is why every consumer of this interface is idempotent — a job by its
 * `jobId`, an event by its `eventId` — and why nothing here promises ordering.
 *
 * The queue is never the system of record. PostgreSQL holds the canonical job
 * state; the queue only carries a pointer to it. A lost message is recovered by
 * the scheduler's lease sweep, and a duplicated one is absorbed by the
 * consumer's idempotency. Database rows are never serialized into a message.
 *
 * ## Why SQS's JSON protocol, signed by hand
 *
 * `AmazonSQS.SendMessage`, `ReceiveMessage`, `DeleteMessage` and
 * `GetQueueAttributes` over `application/x-amz-json-1.0` are four POSTs. The
 * AWS SDK for them is the dependency `aws/sigv4.ts` exists to avoid; the
 * interface below is what keeps that a reversible choice.
 */

import { createHash } from 'node:crypto';
import { signRequest, type AwsCredentials, type AwsFetch } from '../aws/sigv4';

/** One received message. `receiptHandle` is what deletes it; it is not an id. */
export interface QueueMessage {
  messageId: string;
  receiptHandle: string;
  body: string;
  /** How many times SQS has delivered this message, this one included. */
  receiveCount: number;
  attributes: Record<string, string>;
}

/** Approximate depth, as the queue reports it. Approximate is all SQS offers. */
export interface QueueStats {
  visible: number;
  inFlight: number;
  delayed: number;
}

export interface ReceiveOptions {
  /** 1–10, SQS's own ceiling per call. */
  maxMessages: number;
  /** Long-poll wait, 0–20 seconds. */
  waitSeconds: number;
}

export interface WorkQueue {
  send(body: string, attributes?: Record<string, string | number>): Promise<{ messageId: string }>;
  receive(options: ReceiveOptions): Promise<QueueMessage[]>;
  /** Idempotent: deleting an already-deleted receipt is not an error. */
  delete(receiptHandle: string): Promise<void>;
  stats(): Promise<QueueStats>;
}

/** A failed queue call. Carries the SQS error TYPE only, never the message body. */
export class QueueRequestError extends Error {
  constructor(
    readonly status: number,
    readonly errorType: string | undefined,
    operation: string,
  ) {
    super(`The queue answered ${status}${errorType ? ` (${errorType})` : ''} for ${operation}.`);
    this.name = 'QueueRequestError';
  }
}

export interface SqsWorkQueueOptions {
  queueUrl: string;
  region: string;
  /** An explicit endpoint (an emulator); absent means the queue URL's origin. */
  endpoint?: string;
  resolveCredentials: () => Promise<AwsCredentials>;
  fetchImpl?: AwsFetch;
  now?: () => Date;
}

interface SqsReceivedMessage {
  MessageId?: string;
  ReceiptHandle?: string;
  Body?: string;
  Attributes?: Record<string, string>;
  MessageAttributes?: Record<string, { StringValue?: string }>;
}

export function createSqsWorkQueue(options: SqsWorkQueueOptions): WorkQueue {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const endpoint = `${new URL(options.endpoint ?? options.queueUrl).origin}/`;

  async function call<T>(
    action: string,
    payload: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<T> {
    const body = JSON.stringify({ QueueUrl: options.queueUrl, ...payload });
    const headers = signRequest({
      method: 'POST',
      service: 'sqs',
      region: options.region,
      url: endpoint,
      credentials: await options.resolveCredentials(),
      now: now(),
      headers: {
        'content-type': 'application/x-amz-json-1.0',
        'x-amz-target': `AmazonSQS.${action}`,
      },
      body,
    });
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      let errorType: string | undefined;
      try {
        const parsed = JSON.parse(text) as { __type?: unknown };
        if (typeof parsed.__type === 'string')
          errorType = parsed.__type.split('#').pop()?.slice(0, 80);
      } catch {
        // Not JSON; the status alone is reported.
      }
      throw new QueueRequestError(response.status, errorType, action);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  return {
    async send(body, attributes = {}) {
      const messageAttributes = Object.fromEntries(
        Object.entries(attributes).map(([name, value]) => [
          name,
          { DataType: typeof value === 'number' ? 'Number' : 'String', StringValue: String(value) },
        ]),
      );
      const result = await call<{ MessageId?: string; MD5OfMessageBody?: string }>('SendMessage', {
        MessageBody: body,
        ...(Object.keys(messageAttributes).length > 0
          ? { MessageAttributes: messageAttributes }
          : {}),
      });
      // The queue's own digest of what it stored. A mismatch is a body that was
      // altered or truncated between here and the queue; refusing it lets the
      // caller retry rather than dispatching a job the worker cannot parse.
      const expected = createHash('md5').update(body, 'utf8').digest('hex');
      if (!result.MessageId || (result.MD5OfMessageBody && result.MD5OfMessageBody !== expected)) {
        throw new QueueRequestError(200, 'MessageIntegrity', 'SendMessage');
      }
      return { messageId: result.MessageId };
    },

    async receive({ maxMessages, waitSeconds }) {
      const result = await call<{ Messages?: SqsReceivedMessage[] }>(
        'ReceiveMessage',
        {
          MaxNumberOfMessages: Math.min(Math.max(Math.trunc(maxMessages), 1), 10),
          WaitTimeSeconds: Math.min(Math.max(Math.trunc(waitSeconds), 0), 20),
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          MessageAttributeNames: ['All'],
        },
        (waitSeconds + 15) * 1000,
      );
      return (result.Messages ?? []).flatMap((message): QueueMessage[] => {
        if (!message.MessageId || !message.ReceiptHandle || typeof message.Body !== 'string')
          return [];
        const attributes: Record<string, string> = {};
        for (const [name, value] of Object.entries(message.MessageAttributes ?? {})) {
          if (typeof value.StringValue === 'string') attributes[name] = value.StringValue;
        }
        return [
          {
            messageId: message.MessageId,
            receiptHandle: message.ReceiptHandle,
            body: message.Body,
            receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? '1') || 1,
            attributes,
          },
        ];
      });
    },

    async delete(receiptHandle) {
      try {
        await call('DeleteMessage', { ReceiptHandle: receiptHandle });
      } catch (error) {
        // An expired receipt means the message is already back in the queue or
        // gone; either way there is nothing left for this receipt to delete.
        if (error instanceof QueueRequestError && error.errorType === 'ReceiptHandleIsInvalid')
          return;
        throw error;
      }
    },

    async stats() {
      const result = await call<{ Attributes?: Record<string, string> }>('GetQueueAttributes', {
        AttributeNames: [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
          'ApproximateNumberOfMessagesDelayed',
        ],
      });
      const read = (name: string) => Number(result.Attributes?.[name] ?? '0') || 0;
      return {
        visible: read('ApproximateNumberOfMessages'),
        inFlight: read('ApproximateNumberOfMessagesNotVisible'),
        delayed: read('ApproximateNumberOfMessagesDelayed'),
      };
    },
  };
}
