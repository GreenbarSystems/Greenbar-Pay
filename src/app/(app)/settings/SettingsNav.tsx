"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/settings/workflow", label: "Approval workflow" },
  { href: "/settings/po", label: "PO matching" },
  { href: "/settings/integrations", label: "Integrations", prefix: true },
];

export function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-0.5" aria-label="Settings navigation">
      {NAV_ITEMS.map((item) => {
        const isActive = item.prefix
          ? pathname === item.href || pathname.startsWith(item.href + "/")
          : pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              isActive
                ? "bg-green-50 font-medium text-green-800"
                : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
