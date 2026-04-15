import { mondayRequest } from "./client.js";
import type { BoardConfig } from "./bootstrap.js";
import type { RouteDecision } from "./router.js";
import type { OnboardingSummary, ProcessedApplication, RiskAssessment } from "../types.js";

// Hardcoded for the POC. In a real engagement this would come from package.json
// or a git tag; the writer doesn't need that plumbing yet.
const PIPELINE_VERSION = "1.0.0";

// create_item returns column_values inline so the caller can verify what was
// stored against what was sent without a separate readback query (probe
// finding #9). We keep the response shape minimal — only `id` is used.
const CREATE_ITEM_MUTATION = `
  mutation ($board_id: ID!, $group_id: String!, $item_name: String!, $column_values: JSON!) {
    create_item(
      board_id: $board_id,
      group_id: $group_id,
      item_name: $item_name,
      column_values: $column_values
    ) {
      id
      column_values {
        id
        type
        text
        value
      }
    }
  }
`;

type CreateItemResponse = {
  create_item: {
    id: string;
    column_values: ReadonlyArray<{
      id: string;
      type: string;
      text: string | null;
      value: string | null;
    }>;
  };
};

// The Risk factors column carries three distinct signals: the model's
// bulleted risk factors, the model's free-text recommended_action, and the
// model's free-text regulatory_flags. The status column "Recommended action"
// and the dropdown column "Regulatory flags" are both reframed as analyst
// workflow surfaces (left blank by the writer, tagged post-review with a
// canonical disposition or enum label respectively). The model's natural-
// language output for both fields lives here alongside its reasoning rather
// than being force-mapped into rigid enum palettes. See CLAUDE.md phase 3
// notes (Step 2B and Step 3) for the architectural decision — two instances
// of the same pipeline-vs-board contract gap, resolved consistently.
function formatRiskFactors(assessment: RiskAssessment): string {
  const parts: string[] = [];
  if (assessment.risk_factors.length > 0) {
    parts.push(assessment.risk_factors.map((f) => `- ${f}`).join("\n"));
  }
  parts.push(`**Recommended action:** ${assessment.recommended_action}`);
  if (assessment.regulatory_flags.length > 0) {
    const flagList = assessment.regulatory_flags.map((f) => `- ${f}`).join("\n");
    parts.push(`**Regulatory flags:**\n${flagList}`);
  }
  return parts.join("\n\n");
}

function formatOnboardingSummary(summary: OnboardingSummary): string {
  const keyRequirements = summary.key_requirements.map((r) => `- ${r}`).join("\n");
  const nextSteps = summary.next_steps.map((s) => `- ${s}`).join("\n");

  return [
    `**Client overview:** ${summary.client_overview}`,
    `**Complexity:** ${summary.complexity}`,
    `**Key requirements:**\n${keyRequirements}`,
    `**Next steps:**\n${nextSteps}`,
    `**Estimated timeline:** ${summary.estimated_timeline}`,
  ].join("\n\n");
}

function buildColumnValues(
  app: ProcessedApplication,
  config: BoardConfig,
): Record<string, unknown> {
  const { columns } = config;
  const { risk_assessment, onboarding_summary } = app;

  // Recommended action status column and Regulatory flags dropdown column
  // are both deliberately omitted — they are analyst workflow surfaces,
  // tagged post-review. The model's free-text recommendation and free-text
  // regulatory flags both ride along with risk_factors instead. See
  // CLAUDE.md Step 2B and Step 3 architecture decisions.
  return {
    [columns.applicationId]: app.application.application_id,
    [columns.confidence]: risk_assessment.confidence,
    [columns.riskFactors]: { text: formatRiskFactors(risk_assessment) },
    [columns.overrideRationale]: { text: "" },
    [columns.processingTimestamp]: { date: new Date().toISOString().slice(0, 10) },
    [columns.pipelineVersion]: PIPELINE_VERSION,
    [columns.onboardingSummary]: { text: formatOnboardingSummary(onboarding_summary) },
    [columns.riskTier.id]: { label: risk_assessment.risk_level },
    [columns.analystOverride.id]: { label: "PENDING" },
  };
}

export async function writeApplication(
  app: ProcessedApplication,
  route: RouteDecision,
  config: BoardConfig,
): Promise<string> {
  const applicationId = app.application.application_id;

  const itemName = `${applicationId} — ${app.application.client_name}`;
  const columnValues = buildColumnValues(app, config);

  const response = await mondayRequest<CreateItemResponse>(CREATE_ITEM_MUTATION, {
    board_id: config.boardId,
    group_id: route.groupId,
    item_name: itemName,
    column_values: JSON.stringify(columnValues),
  });

  const itemId = response.create_item?.id;
  if (!itemId) {
    throw new Error(
      `[writer] create_item response missing id field: ${JSON.stringify(response)}`,
    );
  }

  console.log(
    `[${new Date().toISOString()}] [writer] Created item ${itemId} for ${applicationId} in group ${route.groupId} (${route.routingReason})`,
  );

  return itemId;
}
