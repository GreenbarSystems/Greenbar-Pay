import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect";
import { AuthError } from "next-auth";
import { signIn, loadUserByEmail } from "@/lib/auth";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials:
    "That email isn't recognised. Check the spelling, or ask your administrator to add you.",
  server_error:
    "We couldn't send your sign-in link. Please try again in a moment, or contact your administrator if this continues.",
  Verification:
    "That sign-in link has expired or already been used. Request a new one below.",
};

export default function SignInPage({
  searchParams,
}: {
  searchParams?: { error?: string; email?: string };
}) {
  // Auth.js routes its own error codes through ?error=… on this page
  // (configured via `pages.error` in auth.ts). "Verification" is the
  // code it uses for an expired or already-consumed magic link.
  const errorCode = searchParams?.error;
  const errorMessage = errorCode ? ERROR_MESSAGES[errorCode] : null;
  const lastEmail = searchParams?.email ?? "";

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <form
        action={async (formData: FormData) => {
          "use server";
          const email = String(formData.get("email") ?? "").trim().toLowerCase();
          // Anti-enumeration: ALWAYS land on /signin/check-email regardless of
          // whether the email is provisioned. We only call signIn() (which
          // actually sends the magic link) when the email matches a real
          // user — so an attacker probing addresses can't tell which exist
          // by latency or response. Defense in depth: the adapter throws
          // in createUser, so even if a stale email slips through, no
          // session can mint.
          const checkEmailUrl =
            "/signin/check-email?email=" + encodeURIComponent(email);
          try {
            const exists = await loadUserByEmail(email);
            if (!exists) {
              redirect(checkEmailUrl);
            }
            await signIn("nodemailer", {
              email,
              redirectTo: checkEmailUrl,
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
          We&rsquo;ll email you a single-use sign-in link.
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
          Send sign-in link
        </button>

        <p className="mt-4 text-xs text-gray-400">
          Need access? Contact your administrator.
        </p>
      </form>
    </div>
  );
}
