import { google, forms_v1 } from "googleapis";
import type { FormMetadata, FormQuestion } from "../workflow-config";
import { getGoogleAuth } from "./auth";

function questionType(
  question: forms_v1.Schema$Question,
): Pick<
  FormQuestion,
  "type" | "options" | "hasYear" | "includeTime" | "duration"
> {
  if (question.textQuestion) {
    return {
      type: question.textQuestion.paragraph ? "paragraph" : "shortText",
    };
  }
  if (question.choiceQuestion) {
    if (question.choiceQuestion.type !== "RADIO") {
      return { type: "unsupported" };
    }
    return {
      type: "multipleChoice",
      options: (question.choiceQuestion.options ?? [])
        .map((option) => option.value)
        .filter((value): value is string => typeof value === "string"),
    };
  }
  if (question.dateQuestion) {
    return {
      type: "date",
      hasYear: question.dateQuestion.includeYear === true,
      includeTime: question.dateQuestion.includeTime === true,
    };
  }
  if (question.timeQuestion) {
    return {
      type: "time",
      duration: question.timeQuestion.duration === true,
    };
  }
  return { type: "unsupported" };
}

export async function getFormQuestions(formId: string): Promise<FormMetadata> {
  if (!formId.trim()) throw new Error("Form ID is required");

  const auth = await getGoogleAuth();
  let form: forms_v1.Schema$Form;
  try {
    const api = google.forms({ version: "v1", auth });
    const result = await api.forms.get({ formId });
    form = result.data;
  } catch (error) {
    const response = (
      error as { response?: { status?: unknown; data?: { error?: unknown } } }
    )?.response;
    const apiError = response?.data?.error;
    if (
      response?.status === 401 ||
      apiError === "invalid_grant" ||
      (apiError !== null &&
        typeof apiError === "object" &&
        (apiError as { error?: unknown }).error === "invalid_grant")
    ) {
      throw new Error(
        "Google authorization expired or revoked; reconnect the owner account",
      );
    }
    if (response?.status === 403) {
      throw new Error(
        "Cannot read Form questions; check owner access and refresh Google authorization",
      );
    }
    throw new Error(
      "Could not load Form questions; check Form ID and owner access",
    );
  }

  const questions: FormQuestion[] = [];
  for (const item of form.items ?? []) {
    const question = item.questionItem?.question;
    if (question?.questionId) {
      questions.push({
        id: question.questionId,
        title: item.title?.trim() || "Untitled question",
        required: question.required === true,
        ...questionType(question),
      });
    }
    for (const row of item.questionGroupItem?.questions ?? []) {
      if (!row.questionId) continue;
      const title = [item.title?.trim(), row.rowQuestion?.title?.trim()]
        .filter(Boolean)
        .join(" — ");
      questions.push({
        id: row.questionId,
        title: title || "Untitled question",
        type: "unsupported",
        required: row.required === true,
      });
    }
  }
  return { formId, questions };
}
