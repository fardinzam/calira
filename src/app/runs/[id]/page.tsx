import Link from "next/link";
import { notFound } from "next/navigation";
import { getRunDetail } from "@/lib/run-execution";
import { retryGmailAction } from "./actions";

export const dynamic = "force-dynamic";

function stateLabel(state: string) {
  const words = state.replaceAll("_", " ");
  return words[0].toUpperCase() + words.slice(1);
}

export default async function RunDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ retry?: string }>;
}) {
  const { id } = await params;
  const retryResult = (await searchParams)?.retry;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  ) {
    notFound();
  }
  const run = await getRunDetail(id);
  if (!run) notFound();
  const calendar = run.steps.find((step) => step.name === "calendar");
  const gmail = run.steps.find((step) => step.name === "gmail");

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

      {retryResult === "warning_required" && (
        <p role="alert" className="mt-4 text-sm text-red-700">
          Acknowledge the duplicate email risk before retrying Gmail.
        </p>
      )}
      {retryResult === "not_allowed" && (
        <p role="alert" className="mt-4 text-sm text-red-700">
          Gmail retry was not queued. This run may have changed; check its
          current steps.
        </p>
      )}
      {retryResult === "error" && (
        <p role="alert" className="mt-4 text-sm text-red-700">
          Gmail retry could not be queued. Try again later.
        </p>
      )}
      {retryResult === "queued" &&
        run.state === "queued" &&
        calendar?.state === "succeeded" &&
        calendar.externalId &&
        gmail?.state === "pending" && (
          <p role="status" className="mt-4 text-sm text-green-800">
            Gmail step queued. The worker will process it when the workflow is
            enabled.
          </p>
        )}
      {retryResult === "queued" &&
        run.state === "running" &&
        calendar?.state === "succeeded" &&
        calendar.externalId &&
        gmail?.state === "running" &&
        gmail.attemptCount >= 2 && (
          <p role="status" className="mt-4 text-sm text-green-800">
            Gmail step running.
          </p>
        )}
      {run.state === "queued" && !run.workflowEnabled && !run.detectionOnly && (
        <p role="status" className="mt-4 text-sm text-amber-800">
          Paused while workflow is disabled. Queued work will resume when it is
          enabled.
        </p>
      )}
      {calendar?.state === "failed" && (
        <p className="mt-4 text-sm text-gray-700">
          Calendar failed. No Gmail acknowledgement was sent; check the Calendar
          step error.
        </p>
      )}
      {calendar?.state === "uncertain" && (
        <p className="mt-4 text-sm text-gray-700">
          Calendar outcome unresolved. Review the reserved event before taking
          further action. No action can be retried here.
        </p>
      )}
      {run.state === "partially_failed" && calendar?.state === "succeeded" && (
        <p className="mt-4 text-sm text-gray-700">
          Calendar event retained. Gmail stopped after the event was created.
        </p>
      )}
      {run.state === "running" && (
        <p role="status" className="mt-4 text-sm text-gray-700">
          Worker processing this run.
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
                {step.state === "pending" && step.nextAttemptAt && (
                  <p>
                    Retry scheduled for{" "}
                    <time dateTime={step.nextAttemptAt.toISOString()}>
                      {step.nextAttemptAt.toISOString()}
                    </time>
                  </p>
                )}
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
      {run.gmailRetry !== "none" && gmail && (
        <section className="mt-8 rounded border border-gray-300 p-4 text-sm">
          <h2 className="text-lg font-semibold">Gmail-only retry</h2>
          {run.gmailRetry === "uncertain" ? (
            <p className="mt-2">
              Send outcome uncertain: the previous message may have been sent.
              Retrying Gmail could send a duplicate email. The Calendar event
              will not be repeated.
            </p>
          ) : (
            <p className="mt-2">
              Gmail step failed. This retries Gmail only; the Calendar event
              stays in place.
            </p>
          )}
          <form action={retryGmailAction.bind(null, run.id)} className="mt-4">
            {run.gmailRetry === "uncertain" && (
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  name="acknowledgeDuplicateRisk"
                  value="yes"
                  required
                />
                <span>
                  I understand that retrying Gmail may send a duplicate email.
                </span>
              </label>
            )}
            <button
              type="submit"
              className="mt-3 rounded bg-blue-700 px-3 py-2 text-white"
            >
              {run.gmailRetry === "uncertain"
                ? "Retry Gmail, possibly sending a duplicate"
                : "Retry Gmail only"}
            </button>
          </form>
        </section>
      )}
    </main>
  );
}
