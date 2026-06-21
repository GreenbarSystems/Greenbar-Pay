/**
 * Long-running worker process. Run via:
 *   pnpm worker       — once
 *   pnpm worker:dev   — tsx watch
 *
 * docker-compose adds this as a dedicated service. Crashes restart the
 * container; pg-boss redelivers any uncommitted jobs.
 */
import "dotenv/config";
import type PgBoss from "pg-boss";
import { getQueue, stopQueue } from "@/lib/queue";
import { HANDLERS } from "@/jobs";
import { isInboxEnabled, startInboxPoller, stopInboxPoller } from "@/lib/inbox/sqs";
import { scrubError } from "@/lib/llm/scrub";

async function main() {
  const boss = await getQueue();
  console.log(`[worker] connected; registering ${HANDLERS.length} handlers`);

  for (const { name, options, handler } of HANDLERS) {
    // Typecheck-sweep — pg-boss v10's work callback always receives
    // Job[] (even when batchSize is 1). Iterate and Promise.all so
    // batched jobs run concurrently within a polling cycle, replacing
    // the prior teamConcurrency knob. A single job's throw still bubbles
    // up so pg-boss applies its per-job retry policy.
    await boss.work(name, options, async (jobs) => {
      await Promise.all(
        jobs.map(async (job) => {
          const j = job as PgBoss.Job<unknown>;
          const started = Date.now();
          try {
            await handler(j as PgBoss.Job<never>);
            console.log(
              `[worker] ${name} job=${j.id} ok in ${Date.now() - started}ms`,
            );
          } catch (err) {
            // §2.4 — never log raw payloads. Anthropic SDK + Drizzle error
            // messages can echo request content; route through scrubError.
            console.error(
              `[worker] ${name} job=${j.id} failed in ${Date.now() - started}ms`,
              scrubError(err),
            );
            throw err;
          }
        }),
      );
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
