import Link from "next/link";
import { listRuns } from "@/lib/runs";
import RunList from "./run-list";

export const dynamic = "force-dynamic";

export default async function RunsPage() {
  const runs = await listRuns();
  return (
    <main className="mx-auto max-w-4xl p-8">
      <Link href="/" className="text-sm underline">
        Home
      </Link>
      <h1 className="mt-6 text-2xl font-semibold">Runs</h1>
      <p className="mt-3 text-sm text-gray-700">
        Queued means the Form response was recorded and is waiting for the
        worker. Older responses without a saved configuration remain detection
        history.
      </p>
      <RunList runs={runs.slice(0, 20)} />
    </main>
  );
}
