import { handlers } from "@/lib/auth";

export const GET = handlers.GET;

// 2026-07-13 audit F13: enforce a minimum response time on all auth POSTs.
// POST /api/auth/signin/nodemailer has a timing gap: unknown-email paths
// throw from createUser in ~5ms; known-email paths await SMTP delivery
// (~500-2000ms). A floor makes the two paths indistinguishable to an attacker.
const SIGNIN_MINIMUM_MS = 1_000;

export const POST: typeof handlers.POST = async (...args) => {
  const start = Date.now();
  const res = await handlers.POST(...args);
  const pad = SIGNIN_MINIMUM_MS - (Date.now() - start);
  if (pad > 0) await new Promise<void>((r) => setTimeout(r, pad));
  return res;
};
