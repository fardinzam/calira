import Link from "next/link";
import { notFound } from "next/navigation";
import { getWorkflow } from "@/lib/workflows";
import WorkflowBuilder from "../workflow-builder";

export const dynamic = "force-dynamic";

export default async function EditWorkflow({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ saved?: string }>;
}) {
  const { id } = await params;
  const workflow = await getWorkflow(id);
  if (!workflow) notFound();
  const { saved } = (await searchParams) ?? {};

  return (
    <main className="mx-auto max-w-3xl p-8">
      <Link href="/" className="text-sm underline">
        Home
      </Link>
      <h1 className="mt-6 text-2xl font-semibold">Edit {workflow.name}</h1>
      <p className="mt-2 text-sm text-gray-700">
        Status: {workflow.enabled ? "Enabled" : "Disabled"}
      </p>
      {saved && ["draft", "complete"].includes(saved) && (
        <p
          role="status"
          className="mt-4 rounded border border-green-300 p-3 text-sm text-green-800"
        >
          {saved === "complete" ? "Complete workflow saved." : "Draft saved."}
        </p>
      )}
      <WorkflowBuilder
        workflow={{
          id: workflow.id,
          name: workflow.name,
          formId: workflow.formId,
          config: workflow.config,
          enabled: workflow.enabled,
        }}
      />
    </main>
  );
}
