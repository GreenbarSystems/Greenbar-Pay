/**
 * F6 fix (2026-07-12 security audit): production-grade security headers.
 * Previously this file had no `headers()` at all — no CSP, HSTS,
 * X-Frame-Options, nosniff, or Referrer-Policy on any response.
 *
 * CSP notes (why it isn't a stricter nonce-based policy):
 *   - Next.js 14 App Router injects inline bootstrap/hydration <script>
 *     tags for the RSC payload; a strict `script-src` without
 *     'unsafe-inline' would require wiring a per-request nonce through
 *     middleware, which is a larger, separate change. This policy still
 *     blocks the actual attack class F6 exists to close — third-party
 *     script injection from XSS, clickjacking via framing, and MIME
 *     sniffing — while avoiding the risk of a nonce rollout breaking
 *     hydration in a security-header PR.
 *   - `img-src`/`connect-src` allow `https:` broadly (in addition to
 *     'self') because document previews load signed URLs from
 *     S3_ENDPOINT (src/lib/storage.ts), which is deployment-configurable
 *     (AWS S3, MinIO, or any S3-compatible host) — hardcoding one origin
 *     here would break previews on a different endpoint.
 *   - `worker-src 'self' blob:` for the PDF.js worker
 *     (public/pdf.worker.min.mjs, same-origin) plus the blob: URLs
 *     pdfjs-dist/react-pdf use internally for rendering.
 *   - `frame-ancestors 'none'` is the modern, un-bypassable version of
 *     X-Frame-Options: DENY (kept both for older browser coverage).
 *
 * HSTS: 2-year max-age + preload is only safe once every subdomain
 * genuinely serves HTTPS — confirm before enabling `preload` submission
 * to the HSTS preload list; the header itself is safe to ship regardless
 * since it's a no-op over plain HTTP.
 */
const SECURITY_HEADERS = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' https: data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' https:",
      "worker-src 'self' blob:",
      "frame-src 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: { bodySizeLimit: "26mb" }, // §2.6: 25 MB upload cap + headroom
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
