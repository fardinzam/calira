import Link from "next/link";
import type { Run } from "@/lib/runs";

export default function RunList({ runs }: { runs: Run[] }) {
  if (runs.length === 0) {
    return (
      <p className="mt-3 text-sm text-gray-700">No responses detected yet.</p>
    );
  }

  return (
    <ul className="mt-3 space-y-3">
      {runs.map((run) => (
        <li key={run.id} className="rounded border border-gray-300 p-4 text-sm">
          <p>
            Run ID:{" "}
            <Link href={`/runs/${run.id}`} className="underline">
              {run.id}
            </Link>
          </p>
          <p>Response ID: {run.responseId}</p>
          <p>
            Submitted:{" "}
            <time dateTime={run.lastSubmittedTime.toISOString()}>
              {run.lastSubmittedTime.toISOString()}
            </time>
          </p>
          <p>
            State: {run.state[0].toUpperCase()}
            {run.state.slice(1).replaceAll("_", " ")}
          </p>
        </li>
      ))}
    </ul>
  );
}
