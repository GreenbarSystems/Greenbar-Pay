/**
 * Magic-link delivery for the Auth.js Email provider.
 *
 * Two transports, picked by env:
 *
 *   • SMTP — when SMTP_HOST is set. Operator-supplied; works against any
 *     SMTP service (SES, SendGrid, Mailgun, Postfix, etc.). AP Assurance's
 *     inbox poller already runs against AWS so SES is the natural prod
 *     choice, but we don't lock to it here.
 *
 *   • Console (dev) — when SMTP_HOST is unset. Logs a clearly-boxed
 *     "click here" line to stdout so a developer running `npm run dev`
 *     can complete a real sign-in flow without standing up a mail server.
 *     The link is also written to .next-auth-dev-link.txt at the repo
 *     root (gitignored) so an integration test runner can poll for it.
 *
 * Sender (`from`) defaults to `AUTH_EMAIL_FROM` env, falling back to
 * `noreply@greenbarpay.local` for dev. Override per-deployment.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

interface MailerArgs {
  to: string;
  url: string;            // the click-this magic link
  expiresMinutes: number;
}

const FROM = process.env.AUTH_EMAIL_FROM ?? "noreply@greenbarpay.local";
const PRODUCT = process.env.AUTH_EMAIL_PRODUCT_NAME ?? "Greenbar AP Assurance";
const DEV_LINK_FILE = path.join(process.cwd(), ".next-auth-dev-link.txt");

function buildPlainText({ url, expiresMinutes }: { url: string; expiresMinutes: number }): string {
  return [
    `Sign in to ${PRODUCT}`,
    "",
    `Click the link below to sign in. It expires in ${expiresMinutes} minutes.`,
    "",
    url,
    "",
    "If you didn't request this, you can ignore this email — no account",
    "will be created and no settings will change.",
  ].join("\n");
}

function buildHtml({ url, expiresMinutes }: { url: string; expiresMinutes: number }): string {
  // Inlined styles — most clients strip <style>. Kept narrow on purpose.
  return `<!doctype html>
<html><body style="font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; color: #15171b; max-width: 520px; margin: 32px auto; padding: 0 16px;">
  <h1 style="font-size: 18px; font-weight: 600; margin: 0 0 12px;">Sign in to ${PRODUCT}</h1>
  <p style="font-size: 14px; line-height: 1.55; margin: 0 0 20px; color: #475569;">
    Click the button below to sign in. The link expires in ${expiresMinutes} minutes.
  </p>
  <p style="margin: 0 0 24px;">
    <a href="${url}" style="display: inline-block; background: #15171b; color: white; text-decoration: none; padding: 10px 18px; border-radius: 6px; font-size: 14px; font-weight: 500;">Sign in</a>
  </p>
  <p style="font-size: 12px; color: #94a3b8; margin: 0 0 6px;">Or paste this URL into your browser:</p>
  <p style="font-size: 12px; color: #94a3b8; word-break: break-all; margin: 0 0 24px;">${url}</p>
  <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
  <p style="font-size: 11px; color: #94a3b8; margin: 0;">
    If you didn't request this, you can ignore this email — no account will be created and no settings will change.
  </p>
</body></html>`;
}

async function sendViaSmtp(args: MailerArgs): Promise<void> {
  // Lazy import — keeps the dependency out of the dev-mode hot path and
  // avoids loading nodemailer when SMTP isn't configured.
  const { createTransport } = await import("nodemailer");
  const transporter = createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    auth:
      process.env.SMTP_USER && process.env.SMTP_PASSWORD
        ? {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASSWORD,
          }
        : undefined,
  });
  await transporter.sendMail({
    from: FROM,
    to: args.to,
    subject: `Sign in to ${PRODUCT}`,
    text: buildPlainText({ url: args.url, expiresMinutes: args.expiresMinutes }),
    html: buildHtml({ url: args.url, expiresMinutes: args.expiresMinutes }),
  });
}

async function sendViaConsole(args: MailerArgs): Promise<void> {
  const banner = "═".repeat(72);
  const lines = [
    "",
    banner,
    `  Magic link for ${args.to}`,
    `  (no SMTP_HOST set — dev console transport)`,
    "",
    `  ${args.url}`,
    "",
    `  Expires in ${args.expiresMinutes} minutes.`,
    banner,
    "",
  ];
  console.log(lines.join("\n"));
  // Also write to a gitignored file so a test runner can poll for it.
  try {
    await fs.writeFile(
      DEV_LINK_FILE,
      JSON.stringify(
        { to: args.to, url: args.url, generatedAt: new Date().toISOString() },
        null,
        2,
      ),
      "utf8",
    );
  } catch {
    /* best-effort — console log is the source of truth */
  }
}

export async function deliverMagicLink(args: MailerArgs): Promise<void> {
  if (process.env.SMTP_HOST) {
    await sendViaSmtp(args);
  } else {
    await sendViaConsole(args);
  }
}
