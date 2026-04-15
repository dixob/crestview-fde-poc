const MONDAY_API_URL = "https://api.monday.com/v2";
const MONDAY_API_VERSION = "2026-04";

type GraphQLError = { message: string; [key: string]: unknown };
type GraphQLResponse<T> = { data?: T; errors?: GraphQLError[] };

export async function mondayRequest<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const token = process.env["MONDAY_API_TOKEN"];
  if (!token) {
    throw new Error("[monday] MONDAY_API_TOKEN is not set in environment");
  }

  const response = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: {
      Authorization: token,
      "API-Version": MONDAY_API_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[monday] HTTP ${response.status} ${response.statusText}: ${body}`);
  }

  const parsed = (await response.json()) as GraphQLResponse<T>;

  if (parsed.errors && parsed.errors.length > 0) {
    const first = parsed.errors[0]?.message ?? "unknown GraphQL error";
    throw new Error(`[monday] GraphQL error: ${first} | all=${JSON.stringify(parsed.errors)}`);
  }

  if (parsed.data === undefined) {
    throw new Error("[monday] response missing data field");
  }

  return parsed.data;
}
