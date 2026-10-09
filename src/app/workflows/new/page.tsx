import Link from "next/link";
import { createWorkflow } from "../actions";

export const dynamic = "force-dynamic";

const errors: Record<string, string> = {
  name: "Workflow name is required.",
  formId: "Form ID is required.",
  save: "Could not save the workflow. Please try again.",
};

export default async function NewWorkflow({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <main className="mx-auto max-w-2xl p-8">
      <Link href="/" className="text-sm underline">
        Home
      </Link>
      <h1 className="mt-6 text-2xl font-semibold">Add a Form workflow</h1>
      <p className="mt-3 text-sm text-gray-700">
        Save a Form to detect new responses. This milestone records submissions
        as queued runs; it does not execute actions.
      </p>
      {error && errors[error] && (
        <p role="alert" className="mt-6 text-sm text-red-700">
          {errors[error]}
        </p>
      )}
      <form action={createWorkflow} className="mt-6 space-y-5">
        <div>
          <label htmlFor="name" className="block text-sm font-medium">
            Workflow name
          </label>
          <input
            id="name"
            name="name"
            required
            className="mt-1 block w-full rounded border border-gray-400 p-2"
          />
        </div>
        <div>
          <label htmlFor="formId" className="block text-sm font-medium">
            Google Form ID
          </label>
          <input
            id="formId"
            name="formId"
            required
            className="mt-1 block w-full rounded border border-gray-400 p-2"
          />
        </div>
        <button
          type="submit"
          className="rounded bg-black px-4 py-2 text-sm text-white"
        >
          Save workflow
        </button>
      </form>
    </main>
  );
}
