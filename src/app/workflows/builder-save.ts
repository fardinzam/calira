import type { Pool } from "pg";
import { getDb } from "@/lib/db";
import { getFormQuestions } from "@/lib/google/form-metadata";
import {
  hasCompleteWorkflowFields,
  type FormMetadata,
} from "@/lib/workflow-config";
import { saveWorkflow, updateWorkflow } from "@/lib/workflows";

export type BuilderInput = {
  id?: string;
  name: string;
  formId: string;
  config: unknown;
  saveAs: "draft" | "complete";
};

export async function saveBuilderWorkflow(
  input: BuilderInput,
  db: Pool = getDb(),
  readMetadata: (formId: string) => Promise<FormMetadata> = getFormQuestions,
) {
  if (!input.name.trim()) throw new Error("Workflow name is required");
  if (!input.formId.trim()) throw new Error("Form ID is required");
  const complete = hasCompleteWorkflowFields(input.config);
  if (input.saveAs === "complete" && !complete) {
    throw new Error("Complete all required fields before saving");
  }
  const metadata = complete
    ? await readMetadata(input.formId.trim())
    : undefined;
  const values = {
    name: input.name,
    formId: input.formId,
    config: input.config,
  };
  return input.id
    ? updateWorkflow(input.id, values, db, metadata)
    : saveWorkflow(values, db, metadata);
}
