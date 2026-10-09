import Link from "next/link";
import { listRuns } from "@/lib/runs";
import RunList from "./runs/run-list";
import { listWorkflows } from "@/lib/workflows";
import { toggleWorkflow } from "./workflows/actions";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string }>;
} = {}) {
  const [workflows, runs, params] = await Promise.all([
    listWorkflows(),
    listRuns(),
    searchParams ?? Promise.resolve<{ error?: string }>({}),
  ]);

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-semibold">Automator</h1>
      <p className="mt-3 text-sm text-gray-700">
        Detect new Google Form responses and record them as queued runs. Actions
        are not executed in this milestone.
      </p>
      <div className="mt-6 flex gap-4 text-sm">
        <Link href="/workflows/new" className="underline">
          Add workflow
        </Link>
        <Link href="/runs" className="underline">
          View all runs
        </Link>
      </div>
      {params.error === "update" && (
        <p role="alert" className="mt-6 text-sm text-red-700">
          Could not update the workflow. Please try again.
        </p>
      )}

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Workflows</h2>
        {workflows.length === 0 ? (
          <p className="mt-3 text-sm text-gray-700">No workflows saved yet.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {workflows.map((workflow) => (
              <li
                key={workflow.id}
                className="rounded border border-gray-300 p-4"
              >
                <h3 className="font-medium">{workflow.name}</h3>
                <p className="mt-1 text-sm">Form ID: {workflow.formId}</p>
                <p className="mt-1 text-sm">
                  State: {workflow.enabled ? "Enabled" : "Disabled"}
                </p>
                <form action={toggleWorkflow} className="mt-3">
                  <input type="hidden" name="id" value={workflow.id} />
                  <input
                    type="hidden"
                    name="enabled"
                    value={workflow.enabled ? "false" : "true"}
                  />
                  <button
                    type="submit"
                    className="rounded border border-gray-500 px-3 py-1 text-sm"
                  >
                    {workflow.enabled ? "Disable" : "Enable"}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Recent detected runs</h2>
        <RunList runs={runs.slice(0, 10)} />
      </section>
    </main>
  );
}
