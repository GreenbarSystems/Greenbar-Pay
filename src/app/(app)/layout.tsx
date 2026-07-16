import { redirect } from "next/navigation";
import { auth, signOut } from "@/lib/auth";
import { NavLinks } from "./NavLinks";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      {/* Sidebar */}
      <aside className="flex w-52 flex-shrink-0 flex-col border-r border-gray-200 bg-white">
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-4 pt-4 pb-2">
          <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md bg-green-700">
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="white"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-3.5 w-3.5"
            >
              <path d="M1.5 4.5h13v8a1 1 0 01-1 1h-11a1 1 0 01-1-1v-8z" />
              <path d="M1.5 4.5l5.7 4.7a1.4 1.4 0 001.6 0l5.7-4.7" />
            </svg>
          </div>
          <span className="text-sm font-semibold tracking-tight text-gray-900">Greenbar Pay</span>
        </div>

        {/* Nav */}
        <div className="flex-1 overflow-y-auto">
          <NavLinks />
        </div>

        {/* User section */}
        <div className="border-t border-gray-100 px-4 py-3">
          <p className="truncate text-xs font-medium text-gray-700">{session.user.email}</p>
          <p className="mt-0.5 text-[10px] uppercase tracking-wider text-gray-400">
            {session.user.role}
          </p>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/signin" });
            }}
          >
            <button className="mt-2 text-xs text-gray-400 hover:text-gray-700 transition-colors">
              Sign out
            </button>
          </form>
        </div>
      </aside>

      {/* Content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <main className="flex-1 overflow-y-auto px-8 py-7">{children}</main>
      </div>
    </div>
  );
}
