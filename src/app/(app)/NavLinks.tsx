"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/inbox", label: "AP Inbox" },
  { href: "/review", label: "Review Queue" },
  { href: "/vendors", label: "Vendors" },
  { href: "/exports", label: "Exports" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/upload", label: "Upload" },
];

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-4 text-sm">
      {NAV.map((item) => {
        const isActive =
          pathname === item.href || pathname.startsWith(item.href + "/");
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            className={
              isActive
                ? "font-medium text-gray-900"
                : "text-gray-600 hover:text-gray-900"
            }
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
