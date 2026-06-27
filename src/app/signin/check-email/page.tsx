import Link from "next/link";

export default function CheckEmailPage({
  searchParams,
}: {
  searchParams?: { email?: string };
}) {
  const email = searchParams?.email ?? "";
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <h1 className="mb-1 text-xl font-semibold">Check your email</h1>
        <p className="mb-4 text-sm text-gray-600">
          We sent a sign-in link
          {email ? (
            <>
              {" "}
              to <span className="font-medium">{email}</span>
            </>
          ) : (
            ""
          )}
          . Click the link to finish signing in.
        </p>
        <p className="mb-5 text-xs text-gray-500">
          The link expires in 15 minutes. If you don&rsquo;t see it within a
          minute or two, check your spam folder.
        </p>
        <Link
          href={`/signin${email ? `?email=${encodeURIComponent(email)}` : ""}`}
          className="block w-full rounded-md border border-gray-300 px-3 py-2 text-center text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Use a different email
        </Link>
      </div>
    </div>
  );
}
