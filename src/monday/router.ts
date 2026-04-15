import type { ProcessedApplication } from "../types.js";
import type { BoardConfig } from "./bootstrap.js";

export type RouteDecision = {
  groupId: string;
  routingReason: string;
};

// Confidence threshold for auto-approval of LOW-risk applications. In a real
// engagement this would be calibrated against shadow-mode analyst override
// data; for the POC 0.85 is a defensible starting point. Exported so tests
// and any future config surface can reference the same value.
export const CONFIDENCE_THRESHOLD = 0.85;

export function routeApplication(
  app: ProcessedApplication,
  config: BoardConfig,
): RouteDecision {
  const { risk_level, confidence } = app.risk_assessment;

  switch (risk_level) {
    case "HIGH":
    case "CRITICAL":
      return {
        groupId: config.groups.escalation,
        routingReason: `${risk_level} risk tier → escalation`,
      };

    case "MEDIUM":
      return {
        groupId: config.groups.analystReview,
        routingReason: "MEDIUM risk tier → analyst review",
      };

    case "LOW": {
      const c = confidence.toFixed(2);
      // Boundary: confidence === 0.85 routes to auto-approved (rule is >=).
      if (confidence >= CONFIDENCE_THRESHOLD) {
        return {
          groupId: config.groups.autoApproved,
          routingReason: `LOW risk, confidence ${c} ≥ 0.85 threshold → auto-approved`,
        };
      }
      return {
        groupId: config.groups.analystReview,
        routingReason: `LOW risk, confidence ${c} < 0.85 threshold → analyst review`,
      };
    }

    default:
      throw new Error(
        `[router] Unexpected risk_level "${risk_level}" for application ${app.application.application_id}`,
      );
  }
}
