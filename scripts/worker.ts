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
        console.error(
          `[worker] ${name} job=${job.id} failed in ${Date.now() - started}ms`,
          err,
        );
        throw err; // let pg-boss apply retry policy
      }
    });
  }

  console.log("[worker] ready");

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] ${sig} received, draining…`);
    await stopQueue();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
