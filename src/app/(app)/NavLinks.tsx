"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = { href: string; label: string; icon: React.ReactNode; prefix?: boolean };

const GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Overview",
    items: [
      {
        href: "/dashboard",
        label: "Dashboard",
        icon: (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-[15px] w-[15px] flex-shrink-0">
            <rect x="1.5" y="1.5" width="5" height="5" rx="1" />
            <rect x="9.5" y="1.5" width="5" height="5" rx="1" />
            <rect x="1.5" y="9.5" width="5" height="5" rx="1" />
            <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
          </svg>
        ),
      },
    ],
  },
  {
    label: "Processing",
    items: [
      {
        href: "/inbox",
        label: "Inbox",
        icon: (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-[15px] w-[15px] flex-shrink-0">
            <path d="M1.5 4.5h13v8a1 1 0 01-1 1h-11a1 1 0 01-1-1v-8z" />
            <path d="M1.5 4.5l5.7 4.7a1.4 1.4 0 001.6 0l5.7-4.7" />
          </svg>
        ),
        prefix: true,
      },
      {
        href: "/upload",
        label: "Upload",
        icon: (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-[15px] w-[15px] flex-shrink-0">
            <path d="M8 10.5V2.5" />
            <path d="M5 5.5L8 2.5l3 3" />
            <path d="M2.5 11.5v1a1 1 0 001 1h9a1 1 0 001-1v-1" />
          </svg>
        ),
      },
      {
        href: "/review",
        label: "Review queue",
        icon: (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-[15px] w-[15px] flex-shrink-0">
            <circle cx="8" cy="8" r="6" />
            <path d="M8 5v3l2 1.5" />
          </svg>
        ),
        prefix: true,
      },
    ],
  },
  {
    label: "Records",
    items: [
      {
        href: "/vendors",
        label: "Vendors",
        icon: (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-[15px] w-[15px] flex-shrink-0">
            <path d="M2 14V6l6-4 6 4v8" />
            <rect x="5.5" y="9" width="2.5" height="5" rx="0.5" />
            <rect x="8" y="9" width="2.5" height="5" rx="0.5" />
            <path d="M1.5 14h13" />
          </svg>
        ),
        prefix: true,
      },
      {
        href: "/exports",
        label: "Exports",
        icon: (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-[15px] w-[15px] flex-shrink-0">
            <path d="M8 2.5v8" />
            <path d="M5 8l3 3 3-3" />
            <path d="M2.5 11.5v1a1 1 0 001 1h9a1 1 0 001-1v-1" />
          </svg>
        ),
        prefix: true,
      },
    ],
  },
];

export function NavLinks() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-0 px-2" aria-label="Main navigation">
      {GROUPS.map((group) => (
        <div key={group.label} className="mb-1">
          <p className="mb-0.5 mt-3 px-2 text-[10px] font-semibold uppercase tracking-widest text-gray-400">
            {group.label}
          </p>
          {group.items.map((item) => {
            const isActive = item.prefix
              ? pathname === item.href || pathname.startsWith(item.href + "/")
              : pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                  isActive
                    ? "bg-green-50 font-medium text-green-800"
                    : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                }`}
              >
                {item.icon}
                {item.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
