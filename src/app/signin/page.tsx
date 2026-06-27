import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect";
import { AuthError } from "next-auth";
import { signIn } from "@/lib/auth";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials:
    "That email isn't recognised. Check the spelling, or ask your administrator to add you.",
  server_error:
    "We couldn't sign you in. Please try again in a moment, or contact your administrator if this continues.",
};

export default function SignInPage({
  searchParams,
}: {
  searchParams?: { error?: string; email?: string };
}) {
  const errorCode = searchParams?.error;
  const errorMessage = errorCode ? ERROR_MESSAGES[errorCode] : null;
  const lastEmail = searchParams?.email ?? "";

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <form
        action={async (formData: FormData) => {
          "use server";
          const email = String(formData.get("email") ?? "").trim().toLowerCase();
          try {
            await signIn("credentials", {
              email,
              redirectTo: "/inbox",
            });
          } catch (err) {
            if (isRedirectError(err)) {
              throw err;
            }
            if (err instanceof AuthError) {
              redirect(
                `/signin?error=invalid_credentials&email=${encodeURIComponent(email)}`,
              );
            }
            redirect(
              `/signin?error=server_error&email=${encodeURIComponent(email)}`,
            );
          }
        }}
        className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-6 shadow-sm"
      >
        <h1 className="mb-1 text-xl font-semibold">Sign in</h1>
        <p className="mb-4 text-sm text-gray-500">
          Use the email your administrator gave you.
        </p>

        {errorMessage && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
          >
            {errorMessage}
          </div>
        )}

        <label className="mb-2 block text-sm font-medium" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          type="email"
          name="email"
          required
          autoFocus
          defaultValue={lastEmail}
          className="mb-4 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
        />
        <button className="w-full rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800">
          Continue
        </button>

        <p className="mt-4 text-xs text-gray-400">
          Need access? Contact your administrator.
        </p>
      </form>
    </div>
  );
}
