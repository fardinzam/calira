import Link from "next/link";
import { notFound } from "next/navigation";
import { getRunDetail } from "@/lib/run-execution";

export const dynamic = "force-dynamic";

function stateLabel(state: string) {
  const words = state.replaceAll("_", " ");
  return words[0].toUpperCase() + words.slice(1);
}

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  ) {
    notFound();
  }
  const run = await getRunDetail(id);
  if (!run) notFound();

  return (
    <main className="mx-auto max-w-4xl p-8">
      <Link href="/runs" className="text-sm underline">
        All runs
      </Link>
      <h1 className="mt-6 text-2xl font-semibold">Run detail</h1>
      <dl className="mt-4 space-y-1 text-sm">
        <div>
          <dt className="inline font-medium">Run ID: </dt>
          <dd className="inline">{run.id}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Response ID: </dt>
          <dd className="inline">{run.responseId}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Submitted: </dt>
          <dd className="inline">
            <time dateTime={run.submittedAt.toISOString()}>
              {run.submittedAt.toISOString()}
            </time>
          </dd>
        </div>
        <div>
          <dt className="inline font-medium">State: </dt>
          <dd className="inline">{stateLabel(run.state)}</dd>
        </div>
      </dl>

      {run.error && (
        <p role="alert" className="mt-4 text-sm text-red-700">
          {run.error.code}: {run.error.message}
        </p>
      )}

      {run.detectionOnly ? (
        <p className="mt-6 text-sm text-gray-700">
          Detection history. This response has no saved action configuration or
          action steps.
        </p>
      ) : (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Steps</h2>
          <ol className="mt-3 space-y-3">
            {run.steps.map((step) => (
              <li
                key={step.name}
                className="rounded border border-gray-300 p-4 text-sm"
              >
                <h3 className="font-medium">
                  {stateLabel(step.name)}: {stateLabel(step.state)}
                </h3>
                <p>Attempts: {step.attemptCount}</p>
                {step.startedAt && (
                  <p>
                    Started:{" "}
                    <time dateTime={step.startedAt.toISOString()}>
                      {step.startedAt.toISOString()}
                    </time>
                  </p>
                )}
                {step.finishedAt && (
                  <p>
                    Finished:{" "}
                    <time dateTime={step.finishedAt.toISOString()}>
                      {step.finishedAt.toISOString()}
                    </time>
                  </p>
                )}
                {step.summary && <p>{step.summary}</p>}
                {step.error && (
                  <p role="alert" className="text-red-700">
                    {step.error.code}: {step.error.message}
                  </p>
                )}
                {step.name === "calendar" && step.externalId && (
                  <p>
                    {step.state === "succeeded" ? "Event ID" : "Planned ID"}:{" "}
                    {step.externalId}
                  </p>
                )}
                {step.name === "gmail" && step.state === "succeeded" && (
                  <>
                    {step.externalId && <p>Message ID: {step.externalId}</p>}
                    <p>Accepted for sending, not delivered.</p>
                  </>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
    </main>
  );
}
