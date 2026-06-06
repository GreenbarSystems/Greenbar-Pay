/**
 * Long-running worker process. Run via:
 *   pnpm worker       — once
 *   pnpm worker:dev   — tsx watch
 *
 * docker-compose adds this as a dedicated service. Crashes restart the
 * container; pg-boss redelivers any uncommitted jobs.
 */
import "dotenv/config";
import { getQueue, stopQueue } from "@/lib/queue";
import { HANDLERS } from "@/jobs";
import { isInboxEnabled, startInboxPoller, stopInboxPoller } from "@/lib/inbox/sqs";
import { scrubError } from "@/lib/llm/scrub";

async function main() {
  const boss = await getQueue();
  console.log(`[worker] connected; registering ${HANDLERS.length} handlers`);

  for (const { name, options, handler } of HANDLERS) {
    await boss.work(name, options, async (job) => {
      const started = Date.now();
      try {
        await handler(job);
        console.log(
          `[worker] ${name} job=${job.id} ok in ${Date.now() - started}ms`,
        );
      } catch (err) {
        // §2.4 — never log raw payloads. Anthropic SDK + Drizzle error
        // messages can echo request content; route through scrubError.
        console.error(
          `[worker] ${name} job=${job.id} failed in ${Date.now() - started}ms`,
          scrubError(err),
        );
        throw err; // let pg-boss apply retry policy
      }
    });
  }

  // AP inbox SQS poller runs alongside pg-boss handlers in the same
  // process — same image, same deploy, same lifecycle. Disabled when
  // INBOX_SQS_QUEUE_URL is unset (local dev).
  if (isInboxEnabled()) {
    void startInboxPoller();
  }

  console.log("[worker] ready");

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] ${sig} received, draining…`);
    await stopInboxPoller();
    await stopQueue();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[worker] fatal", scrubError(err));
  process.exit(1);
});
