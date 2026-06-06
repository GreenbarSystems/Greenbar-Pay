import UploadForm from "./UploadForm";

export default function UploadPage() {
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-2 text-2xl font-semibold">Upload invoice</h1>
      <p className="mb-6 text-sm text-gray-600">
        Accepted: PDF, PNG, JPEG, TIFF. Max 25&nbsp;MB per file.
      </p>
      <UploadForm />
    </div>
  );
}
