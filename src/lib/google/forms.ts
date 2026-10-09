import { google, forms_v1 } from "googleapis";
import type { FormResponse } from "../runs";
import { getGoogleAuth } from "./auth";

type ListResponses = (request: {
  formId: string;
  filter: string;
  pageToken?: string;
}) => Promise<{
  data: {
    responses?: forms_v1.Schema$FormResponse[];
    nextPageToken?: string | null;
  };
}>;

export async function listFormResponses(
  formId: string,
  since: Date,
  pageToken?: string,
  listResponses?: ListResponses,
): Promise<{ responses: FormResponse[]; nextPageToken?: string }> {
  if (!formId.trim()) throw new Error("Form ID is required");
  if (Number.isNaN(since.getTime()))
    throw new Error("Invalid Forms response timestamp");

  const request = {
    formId,
    filter: `timestamp >= ${since.toISOString()}`,
    ...(pageToken ? { pageToken } : {}),
  };
  let result: Awaited<ReturnType<ListResponses>>;
  try {
    if (listResponses) {
      result = await listResponses(request);
    } else {
      const api = google.forms({ version: "v1", auth: await getGoogleAuth() });
      result = await api.forms.responses.list(request);
    }
  } catch (error) {
    const response = (
      error as { response?: { status?: unknown; data?: { error?: unknown } } }
    )?.response;
    const status = response?.status;
    if (response?.data?.error === "invalid_grant" || status === 401) {
      throw new Error(
        "Google authorization expired or revoked; reconnect the owner account",
      );
    }
    throw new Error(
      typeof status === "number"
        ? `Google Forms request failed (HTTP ${status})`
        : "Google Forms request failed",
    );
  }
  const responses = (result.data.responses ?? []).map(
    (response): FormResponse => {
      if (
        !response.responseId ||
        !response.createTime ||
        !response.lastSubmittedTime ||
        Number.isNaN(Date.parse(response.createTime)) ||
        Number.isNaN(Date.parse(response.lastSubmittedTime))
      ) {
        throw new Error(
          "Google Forms returned a response with missing or invalid required fields",
        );
      }
      return {
        responseId: response.responseId,
        createTime: response.createTime,
        lastSubmittedTime: response.lastSubmittedTime,
        answers: response.answers ?? {},
      };
    },
  );
  return {
    responses,
    ...(result.data.nextPageToken
      ? { nextPageToken: result.data.nextPageToken }
      : {}),
  };
}
