/**
 * SQS poller for the AP inbox (addendum §3.1 + §3.4).
 *
 * SES delivers each inbound message to S3 (raw RFC 822) then notifies an
 * SNS topic which fans out to our SQS queue. Each SQS message body is the
 * SNS envelope wrapping the S3 event record.
 *
 * Loop:
 *   ReceiveMessage (long poll, 20s) →
 *     for each: decode S3 key → ingestEmlMessage → DeleteMessage on success.
 *
 * Failure handling:
 *   - Don't ack on throw. SQS visibility timeout (configured at queue
 *     creation, §3.4 says 5 min) returns the message; pg-boss-style
 *     retry-count is owned by SQS.
 *   - After max receives (§3.4 = 5) AWS routes to ap-inbox-dlq. A
 *     separate Lambda / cron posts a Slack alert with metadata only —
 *     never body or attachments (§3.4).
 *
 * No-op when INBOX_SQS_QUEUE_URL is unset (local dev).
 */
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  type Message,
} from "@aws-sdk/client-sqs";
import { ingestEmlMessage } from "./ingest";
import { scrub } from "@/lib/llm/scrub";

interface SesVerdict {
  status?: "PASS" | "FAIL" | "GRAY" | "PROCESSING_FAILED";
}

interface SesNotification {
  Records?: Array<{
    s3?: {
      bucket?: { name?: string };
      object?: { key?: string };
    };
    ses?: {
      receipt?: {
        recipients?: string[];
        // 2026-07-13 audit F11 — SES evaluates these on every inbound
        // message; we were reading `recipients` from this same object
        // and discarding the rest. See src/lib/inbox/authentication.ts.
        spfVerdict?: SesVerdict;
        dkimVerdict?: SesVerdict;
        dmarcVerdict?: SesVerdict;
        dmarcPolicy?: "none" | "quarantine" | "reject";
      };
    };
  }>;
}

const LONG_POLL_WAIT_SECONDS = 20;
const MAX_RECEIVE_PER_LOOP = 5;

let stopRequested = false;
let runningTask: Promise<void> | null = null;

export function isInboxEnabled(): boolean {
  return Boolean(process.env.INBOX_SQS_QUEUE_URL);
}

export function startInboxPoller(): Promise<void> {
  if (!isInboxEnabled()) {
    console.log("[inbox] INBOX_SQS_QUEUE_URL unset; poller disabled");
    return Promise.resolve();
  }
  if (runningTask) return runningTask;

  const queueUrl = process.env.INBOX_SQS_QUEUE_URL!;
  const region = process.env.S3_REGION ?? "us-east-1";
  const client = new SQSClient({
    region,
    endpoint: process.env.SQS_ENDPOINT, // for LocalStack-style overrides
    credentials:
      process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.S3_ACCESS_KEY_ID,
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
          }
        : undefined,
  });

  stopRequested = false;
  runningTask = (async () => {
    console.log(`[inbox] poller started on ${queueUrl}`);
    while (!stopRequested) {
      try {
        const res = await client.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: MAX_RECEIVE_PER_LOOP,
            WaitTimeSeconds: LONG_POLL_WAIT_SECONDS,
            VisibilityTimeout: 5 * 60,
          }),
        );
        const messages = res.Messages ?? [];
        for (const msg of messages) {
          await handleSqsMessage(client, queueUrl, msg);
        }
      } catch (err) {
        // Network blip or transient failure — back off and try again.
        console.error("[inbox] receive failed", scrub(err));
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
    console.log("[inbox] poller stopped");
  })();

  return runningTask;
}

export function stopInboxPoller(): Promise<void> {
  stopRequested = true;
  return runningTask ?? Promise.resolve();
}

async function handleSqsMessage(
  client: SQSClient,
  queueUrl: string,
  msg: Message,
): Promise<void> {
  try {
    const notification = decodeSesNotification(msg.Body ?? "");
    if (!notification) {
      // Malformed — ack so it doesn't bounce forever.
      console.warn(`[inbox] could not decode SQS message ${msg.MessageId}`);
      await ack(client, queueUrl, msg);
      return;
    }

    for (const record of notification.Records ?? []) {
      const key = record.s3?.object?.key;
      if (!key) continue;
      // Recipients come from the SES envelope, not parsed MIME. Use the
      // first one as the mailbox indexed key; parseEml extracts all.
      const mailbox = record.ses?.receipt?.recipients?.[0] ?? "unknown";
      const receipt = record.ses?.receipt;
      const result = await ingestEmlMessage({
        rawMessageStorageKey: key,
        mailbox,
        authentication: receipt
          ? {
              spfVerdict: receipt.spfVerdict?.status,
              dkimVerdict: receipt.dkimVerdict?.status,
              dmarcVerdict: receipt.dmarcVerdict?.status,
              dmarcPolicy: receipt.dmarcPolicy,
            }
          : undefined,
      });
      // PR20 — log a short opaque suffix of the storage key instead
      // of the full path. The key is not direct PII but links the log
      // entry back to a specific inbound message; the suffix lets an
      // operator correlate without having the full S3 path in stdout.
      const keyTag = key.slice(-12);
      console.log(
        `[inbox] …${keyTag} → ${result.kind === "duplicate" ? "duplicate" : result.status}`,
      );
    }

    await ack(client, queueUrl, msg);
  } catch (err) {
    // Leave the message un-ack'd so SQS re-delivers up to maxReceiveCount.
    console.error(
      `[inbox] message ${msg.MessageId} failed; will retry`,
      scrub(err),
    );
  }
}

function decodeSesNotification(body: string): SesNotification | null {
  try {
    const outer = JSON.parse(body);
    // SES → SNS → SQS wraps the SES notification once via SNS. Unwrap.
    if (typeof outer.Message === "string") {
      return JSON.parse(outer.Message) as SesNotification;
    }
    return outer as SesNotification;
  } catch {
    return null;
  }
}

async function ack(
  client: SQSClient,
  queueUrl: string,
  msg: Message,
): Promise<void> {
  if (!msg.ReceiptHandle) return;
  await client.send(
    new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: msg.ReceiptHandle,
    }),
  );
}
