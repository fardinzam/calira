import Link from "next/link";
import { listRuns } from "@/lib/runs";
import RunList from "./runs/run-list";
import { listWorkflows } from "@/lib/workflows";
import { hasCompleteWorkflowFields } from "@/lib/workflow-config";
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
        For consultation requests: read new Google Forms responses, continue
        when the Filter matches Consultation, then plan a Google Calendar event
        and Gmail acknowledgement. New responses are recorded by polling, then
        eligible runs are processed by the worker.
      </p>
      <div className="mt-6 flex gap-4 text-sm">
        <Link href="/workflows/new" className="underline">
          Build a workflow
        </Link>
        <Link href="/runs" className="underline">
          View all runs
        </Link>
      </div>
      {params.error &&
        ["update", "incomplete", "configuration", "form"].includes(
          params.error,
        ) && (
          <p role="alert" className="mt-6 text-sm text-red-700">
            {params.error === "incomplete"
              ? "Complete the workflow configuration before enabling polling."
              : params.error === "configuration"
                ? "Review the workflow configuration and current Form questions before enabling polling."
                : params.error === "form"
                  ? "Could not read current Form questions. Check owner access and Google authorization."
                  : "Could not update the workflow. Please try again."}
          </p>
        )}

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Workflows</h2>
        {workflows.length === 0 ? (
          <p className="mt-3 text-sm text-gray-700">
            No workflows saved yet. Build a consultation workflow to get
            started.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {workflows.map((workflow) => {
              const complete = hasCompleteWorkflowFields(workflow.config);
              return (
                <li
                  key={workflow.id}
                  className="rounded border border-gray-300 p-4"
                >
                  <h3 className="font-medium">{workflow.name}</h3>
                  <p className="mt-1 text-sm">Form ID: {workflow.formId}</p>
                  <p className="mt-1 text-sm">
                    Configuration: {complete ? "Complete" : "Incomplete"}
                  </p>
                  <p className="mt-1 text-sm">
                    Polling: {workflow.enabled ? "Enabled" : "Disabled"}
                  </p>
                  {!complete && (
                    <p className="mt-1 text-sm text-gray-700">
                      Finish setup before enabling polling.
                    </p>
                  )}
                  <div className="mt-3 flex items-center gap-3">
                    <Link
                      href={`/workflows/${workflow.id}`}
                      className="text-sm underline"
                    >
                      Edit and review
                    </Link>
                    <form action={toggleWorkflow}>
                      <input type="hidden" name="id" value={workflow.id} />
                      <input
                        type="hidden"
                        name="enabled"
                        value={workflow.enabled ? "false" : "true"}
                      />
                      <button
                        type="submit"
                        disabled={!workflow.enabled && !complete}
                        className="rounded border border-gray-500 px-3 py-1 text-sm disabled:opacity-50"
                      >
                        {workflow.enabled
                          ? "Disable polling"
                          : "Enable polling"}
                      </button>
                    </form>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Recent runs</h2>
        <p className="mt-1 text-sm text-gray-700">
          Queued means recorded and waiting for the worker. Older runs without a
          configuration snapshot remain detection history and cannot execute
          actions.
        </p>
        <RunList runs={runs.slice(0, 10)} />
      </section>
    </main>
  );
}
