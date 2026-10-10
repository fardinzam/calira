import Link from "next/link";
import WorkflowBuilder from "../workflow-builder";

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
    <main className="mx-auto max-w-3xl p-8">
      <Link href="/" className="text-sm underline">
        Home
      </Link>
      <h1 className="mt-6 text-2xl font-semibold">
        Add a consultation workflow
      </h1>
      <WorkflowBuilder initialError={error ? errors[error] : undefined} />
    </main>
  );
}
