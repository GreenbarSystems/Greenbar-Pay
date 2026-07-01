"use client";

/**
 * Route-group error boundary (L2 — code-quality audit finding).
 *
 * Next.js requires error.tsx to be a Client Component. Without this
 * file, an unhandled throw in any (app) page's server-side data
 * fetch (DB unreachable, withOrg failure, an unexpected RLS denial)
 * propagated to the nearest ancestor boundary or a bare 500 with no
 * recovery path for the user.
 *
 * `reset()` re-renders the segment — the right first move for
 * transient failures (a DB blip, a momentary connection-pool
 * exhaustion) without a full page reload, which would lose any
 * client-side state elsewhere on the page.
 *
 * Deliberately does not display `error.message` to the user: server
 * errors can carry details (SQL fragments, internal paths) that
 * shouldn't reach the browser. The digest (if present) is a safe,
 * non-sensitive correlation id for support / log lookup.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 text-center">
      <div className="rounded-md border border-red-200 bg-red-50 p-4">
        <p className="text-sm font-medium text-red-900">
          Something went wrong loading this page.
        </p>
        {error.digest && (
          <p className="mt-1 text-xs text-red-700">
            Reference: <span className="font-mono">{error.digest}</span>
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => reset()}
        className="rounded-md bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-800"
      >
        Try again
      </button>
    </div>
  );
}
