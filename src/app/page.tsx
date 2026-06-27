import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

// Single-hop landing. Unauthenticated visitors used to bounce through
// /inbox (the default app landing) before the (app) layout's session
// check kicked them to /signin — two server redirects and a visible
// browser-bar flicker. Checking session here lets us route directly:
//   signed in     → /inbox
//   signed out    → /signin
//
// The (app)/layout.tsx still runs auth() on every render under (app), so
// this isn't the security boundary — it's only the landing optimisation.
export default async function HomePage() {
  const session = await auth();
  redirect(session?.user ? "/inbox" : "/signin");
}
