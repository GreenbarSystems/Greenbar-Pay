/**
 * Route-group loading boundary (L2 — code-quality audit finding).
 *
 * Every page under (app) fetches via getServerSession() + withOrg()
 * before rendering anything. Without this file, a slow or momentarily
 * unavailable DB left the browser on a blank tab with no progress
 * signal — Next only shows a boundary like this one when a matching
 * loading.tsx exists for the segment.
 *
 * Kept deliberately generic (no per-page skeleton shapes) since this
 * is a route-group-wide fallback; page-specific skeletons can be added
 * per-segment later if a specific page's loading state is worth the
 * extra maintenance.
 */
export default function AppLoading() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="flex items-center gap-3 text-sm text-gray-500">
        <span
          className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600"
          aria-hidden="true"
        />
        Loading…
      </div>
    </div>
  );
}
