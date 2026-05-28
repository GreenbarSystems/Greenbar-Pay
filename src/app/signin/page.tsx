import { signIn } from "@/lib/auth";

export default function SignInPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <form
        action={async (formData: FormData) => {
          "use server";
          await signIn("credentials", {
            email: formData.get("email"),
            redirectTo: "/inbox",
          });
        }}
        className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-6 shadow-sm"
      >
        <h1 className="mb-1 text-xl font-semibold">Sign in</h1>
        <p className="mb-4 text-sm text-gray-500">
          Phase 1 dev login — enter a seeded user email.
        </p>
        <label className="mb-2 block text-sm font-medium">Email</label>
        <input
          type="email"
          name="email"
          required
          autoFocus
          className="mb-4 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
        />
        <button className="w-full rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800">
          Continue
        </button>
      </form>
    </div>
  );
}
