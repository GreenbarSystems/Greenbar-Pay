import { redirect } from "next/navigation";
import { auth, signOut } from "@/lib/auth";
import { NavLinks } from "./NavLinks";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-6">
            <span className="text-lg font-semibold tracking-tight">Greenbar Pay</span>
            <NavLinks />
          </div>
          <div className="flex items-center gap-3 text-sm text-gray-600">
            <span>{session.user.email}</span>
            <span className="rounded bg-gray-100 px-2 py-0.5 text-xs uppercase tracking-wide">
              {session.user.role}
            </span>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/signin" });
              }}
            >
              <button className="text-gray-500 hover:text-gray-900">Sign out</button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
    </div>
  );
}
