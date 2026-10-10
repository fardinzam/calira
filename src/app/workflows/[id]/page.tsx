import Link from "next/link";
import { notFound } from "next/navigation";
import { getWorkflow } from "@/lib/workflows";
import { hasCompleteWorkflowFields } from "@/lib/workflow-config";
import WorkflowBuilder from "../workflow-builder";
import { toggleWorkflow } from "../actions";

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
      <p className="mt-1 text-sm text-gray-700">
        Configuration:{" "}
        {hasCompleteWorkflowFields(workflow.config) ? "Complete" : "Incomplete"}
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
      <form
        action={toggleWorkflow}
        className="mt-8 border-t border-gray-300 pt-5"
      >
        <input type="hidden" name="id" value={workflow.id} />
        <input
          type="hidden"
          name="enabled"
          value={workflow.enabled ? "false" : "true"}
        />
        <button
          type="submit"
          disabled={
            !workflow.enabled && !hasCompleteWorkflowFields(workflow.config)
          }
          className="rounded border border-gray-500 px-4 py-2 text-sm disabled:opacity-50"
        >
          {workflow.enabled ? "Disable polling" : "Enable polling"}
        </button>
        <p className="mt-2 text-sm text-gray-700">
          Polling records new responses. The worker processes eligible runs
          while this workflow is enabled.
        </p>
      </form>
    </main>
  );
}
