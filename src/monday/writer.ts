import { mondayRequest } from "./client.js";
import type { BoardConfig } from "./bootstrap.js";
import type { RouteDecision } from "./router.js";
import type { OnboardingSummary, ProcessedApplication, RiskAssessment } from "../types.js";

// Hardcoded for the POC. In a real engagement this would come from package.json
// or a git tag; the writer doesn't need that plumbing yet.
const PIPELINE_VERSION = "1.0.0";

// Six known dropdown labels for the Regulatory flags column, matching the
// submission order from phase 2.4's DROPDOWN_COLUMN_SPECS in bootstrap.ts.
// Writer validates every incoming flag against this set and throws on an
// unknown label — dropping a compliance flag silently is a data-loss bug,
// not a cosmetic one.
const REGULATORY_FLAG_LABELS: ReadonlySet<string> = new Set([
  "FATF_R10",
  "FATF_R12",
  "FinCEN_CDD",
  "SAR_31CFR1023_320",
  "OFAC",
  "BSA",
]);

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

// The Risk factors column carries two distinct signals: the model's bulleted
// risk factors AND the model's free-text recommended_action. The status
// column named "Recommended action" is reframed as an analyst workflow
// surface (left blank by the writer, tagged post-review by an analyst with
// one of AUTO_APPROVE/HUMAN_REVIEW/ESCALATE/REJECT). The model's natural-
// language recommendation lives here alongside its reasoning rather than
// being force-mapped into the rigid enum palette. See CLAUDE.md phase 3
// notes for the architectural decision.
function formatRiskFactors(assessment: RiskAssessment): string {
  const parts: string[] = [];
  if (assessment.risk_factors.length > 0) {
    parts.push(assessment.risk_factors.map((f) => `- ${f}`).join("\n"));
  }
  parts.push(`**Recommended action:** ${assessment.recommended_action}`);
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

function validateRegulatoryFlags(flags: readonly string[], applicationId: string): void {
  const knownList = Array.from(REGULATORY_FLAG_LABELS).join(", ");
  for (const flag of flags) {
    if (!REGULATORY_FLAG_LABELS.has(flag)) {
      throw new Error(
        `[writer] Unknown regulatory flag "${flag}" in application ${applicationId} — expected one of ${knownList}`,
      );
    }
  }
}

function buildColumnValues(
  app: ProcessedApplication,
  config: BoardConfig,
): Record<string, unknown> {
  const { columns } = config;
  const { risk_assessment, onboarding_summary } = app;

  // Recommended action status column is deliberately omitted — it is an
  // analyst workflow surface, tagged post-review. The model's free-text
  // recommendation rides along with risk_factors instead.
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
    [columns.regulatoryFlags]: { labels: risk_assessment.regulatory_flags },
  };
}

export async function writeApplication(
  app: ProcessedApplication,
  route: RouteDecision,
  config: BoardConfig,
): Promise<string> {
  const applicationId = app.application.application_id;

  validateRegulatoryFlags(app.risk_assessment.regulatory_flags, applicationId);

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
