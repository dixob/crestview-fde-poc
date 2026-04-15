import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardConfig } from "./bootstrap.js";
import type { ProcessedApplication } from "../types.js";
import { CONFIDENCE_THRESHOLD, routeApplication } from "./router.js";

const AUTO_APPROVED_GROUP = "group_auto_approved";
const ANALYST_REVIEW_GROUP = "group_analyst_review";
const ESCALATION_GROUP = "group_escalation";

function makeConfig(): BoardConfig {
  return {
    boardId: "board_test",
    groups: {
      autoApproved: AUTO_APPROVED_GROUP,
      analystReview: ANALYST_REVIEW_GROUP,
      escalation: ESCALATION_GROUP,
    },
    columns: {
      applicationId: "col_app_id",
      riskTier: {
        id: "col_risk_tier",
        labels: { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 },
      },
      confidence: "col_confidence",
      recommendedAction: {
        id: "col_recommended_action",
        labels: { AUTO_APPROVE: 1, HUMAN_REVIEW: 2, ESCALATE: 3, REJECT: 4 },
      },
      regulatoryFlags: "col_regulatory_flags",
      riskFactors: "col_risk_factors",
      analystOverride: {
        id: "col_analyst_override",
        labels: { PENDING: 1, AGREE: 2, DISAGREE: 3 },
      },
      overrideRationale: "col_override_rationale",
      processingTimestamp: "col_processing_timestamp",
      pipelineVersion: "col_pipeline_version",
      onboardingSummary: "col_onboarding_summary",
    },
  };
}

function makeApp(
  risk_level: ProcessedApplication["risk_assessment"]["risk_level"],
  confidence: number,
  application_id = "APP-TEST-0001",
): ProcessedApplication {
  return {
    application: {
      application_id,
      client_name: "Test Client",
      client_type: "Institutional",
      requested_services: "Test Services",
      estimated_aum: 1_000_000,
      submission_date: "1/1/2026",
      status: "New",
      description: "Test application fixture.",
    },
    risk_assessment: {
      risk_level,
      confidence,
      reasoning: "Test reasoning.",
      risk_factors: [],
      regulatory_flags: [],
      recommended_action: "Test action",
    },
    onboarding_summary: {
      client_overview: "Test overview.",
      complexity: "STANDARD",
      key_requirements: [],
      next_steps: [],
      estimated_timeline: "1 week",
    },
  };
}

test("HIGH risk routes to escalation", () => {
  const decision = routeApplication(makeApp("HIGH", 0.7), makeConfig());
  assert.equal(decision.groupId, ESCALATION_GROUP);
  assert.match(decision.routingReason, /HIGH risk tier/);
});

test("CRITICAL risk routes to escalation", () => {
  const decision = routeApplication(makeApp("CRITICAL", 0.99), makeConfig());
  assert.equal(decision.groupId, ESCALATION_GROUP);
  assert.match(decision.routingReason, /CRITICAL risk tier/);
});

test("MEDIUM risk with high confidence routes to analyst review (confidence does not override)", () => {
  const decision = routeApplication(makeApp("MEDIUM", 0.95), makeConfig());
  assert.equal(decision.groupId, ANALYST_REVIEW_GROUP);
  assert.match(decision.routingReason, /MEDIUM risk tier/);
});

test("MEDIUM risk with low confidence routes to analyst review", () => {
  const decision = routeApplication(makeApp("MEDIUM", 0.4), makeConfig());
  assert.equal(decision.groupId, ANALYST_REVIEW_GROUP);
  assert.match(decision.routingReason, /MEDIUM risk tier/);
});

test("LOW risk with confidence 0.90 routes to auto-approved", () => {
  const decision = routeApplication(makeApp("LOW", 0.9), makeConfig());
  assert.equal(decision.groupId, AUTO_APPROVED_GROUP);
  assert.match(decision.routingReason, /auto-approved/);
});

test("LOW risk at exact boundary 0.85 routes to auto-approved", () => {
  assert.equal(CONFIDENCE_THRESHOLD, 0.85);
  const decision = routeApplication(makeApp("LOW", 0.85), makeConfig());
  assert.equal(decision.groupId, AUTO_APPROVED_GROUP);
  assert.match(decision.routingReason, /auto-approved/);
});

test("LOW risk with confidence 0.84 routes to analyst review", () => {
  const decision = routeApplication(makeApp("LOW", 0.84), makeConfig());
  assert.equal(decision.groupId, ANALYST_REVIEW_GROUP);
  assert.match(decision.routingReason, /analyst review/);
});

test("LOW risk with confidence 0.50 routes to analyst review", () => {
  const decision = routeApplication(makeApp("LOW", 0.5), makeConfig());
  assert.equal(decision.groupId, ANALYST_REVIEW_GROUP);
  assert.match(decision.routingReason, /analyst review/);
});

test("unknown risk tier throws with application ID in error message", () => {
  const badTier = "EXTREME" as unknown as ProcessedApplication["risk_assessment"]["risk_level"];
  const app = makeApp(badTier, 0.5, "APP-BAD-9999");
  assert.throws(
    () => routeApplication(app, makeConfig()),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /APP-BAD-9999/);
      assert.match(err.message, /EXTREME/);
      return true;
    },
  );
});
