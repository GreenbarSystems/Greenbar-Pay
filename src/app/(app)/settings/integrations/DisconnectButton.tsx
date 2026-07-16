"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function DisconnectButton({
  action,
  label,
}: {
  action: string;
  label: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleDisconnect() {
    if (!confirm(`Disconnect ${label}? Existing exports will not be affected.`)) return;
    setLoading(true);
    try {
      await fetch(action, { method: "DELETE" });
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleDisconnect}
      disabled={loading}
      className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
    >
      {loading ? "Disconnecting…" : "Disconnect"}
    </button>
  );
}
