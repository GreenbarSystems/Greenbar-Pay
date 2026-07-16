/**
 * /settings/integrations/intacct
 *
 * Credential form for connecting Sage Intacct. Unlike QBO/Xero (OAuth
 * redirect), Intacct uses Company ID + User credentials authenticated
 * against their XML Web Services API.
 *
 * Submits to POST /api/integrations/intacct/connect; on success redirects
 * to /settings/integrations?connected=intacct.
 */
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function IntacctConnectPage() {
  const router = useRouter();
  const [companyId, setCompanyId] = useState("");
  const [userId, setUserId] = useState("");
  const [userPassword, setUserPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/integrations/intacct/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, userId, userPassword }),
      });

      const data = (await res.json()) as { error?: string; message?: string };

      if (!res.ok) {
        setError(data.message ?? data.error ?? "Connection failed. Check your credentials and try again.");
        return;
      }

      router.push("/settings/integrations?connected=intacct");
    } catch {
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-md">
      <div className="mb-6">
        <Link
          href="/settings/integrations"
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          ← Back to Integrations
        </Link>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md border border-gray-100 bg-gray-50">
            <IntacctLogo />
          </div>
          <div>
            <h1 className="font-semibold text-gray-900">Connect Sage Intacct</h1>
            <p className="text-sm text-gray-500">Sync approved invoices as AP Bills</p>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="companyId" className="block text-sm font-medium text-gray-700">
              Company ID
            </label>
            <input
              id="companyId"
              type="text"
              required
              autoComplete="off"
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
              placeholder="Your Intacct company ID"
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600"
            />
          </div>

          <div>
            <label htmlFor="userId" className="block text-sm font-medium text-gray-700">
              User ID
            </label>
            <input
              id="userId"
              type="text"
              required
              autoComplete="username"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="Your Intacct user ID"
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600"
            />
          </div>

          <div>
            <label htmlFor="userPassword" className="block text-sm font-medium text-gray-700">
              Password
            </label>
            <input
              id="userPassword"
              type="password"
              required
              autoComplete="current-password"
              value={userPassword}
              onChange={(e) => setUserPassword(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-green-600 focus:outline-none focus:ring-1 focus:ring-green-600"
            />
          </div>

          <p className="text-xs text-gray-400">
            Your credentials are encrypted at rest and never stored in plain text.
            Greenbar Pay uses your Intacct Web Services API to create AP Bills only.
          </p>

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-green-700 px-4 py-2 text-sm font-medium text-white hover:bg-green-800 disabled:opacity-50"
          >
            {submitting ? "Connecting…" : "Connect"}
          </button>
        </form>
      </div>
    </div>
  );
}

function IntacctLogo() {
  return (
    <svg viewBox="0 0 32 32" className="h-6 w-6" aria-hidden="true">
      <rect width="32" height="32" rx="6" fill="#00A86B" />
      <text x="16" y="22" fontSize="14" fontWeight="bold" fill="white" textAnchor="middle">
        SI
      </text>
    </svg>
  );
}
