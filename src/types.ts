import { z } from "zod/v4";

// --- ClientApplication (parsed from CSV) ---

export const ClientApplicationSchema = z.object({
  application_id: z.string(),
  client_name: z.string(),
  client_type: z.string(),
  requested_services: z.string(),
  estimated_aum: z.number(),
  submission_date: z.string(),
  status: z.string(),
  description: z.string(),
});

export type ClientApplication = z.infer<typeof ClientApplicationSchema>;

// --- RiskAssessment (stage 1 output) ---

export const RiskAssessmentSchema = z.object({
  risk_level: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  risk_factors: z.array(z.string()),
  regulatory_flags: z.array(z.string()),
  recommended_action: z.string(),
});

export type RiskAssessment = z.infer<typeof RiskAssessmentSchema>;

// --- OnboardingSummary (stage 2 output) ---

export const OnboardingSummarySchema = z.object({
  client_overview: z.string(),
  complexity: z.enum(["STANDARD", "ELEVATED", "COMPLEX"]),
  key_requirements: z.array(z.string()),
  next_steps: z.array(z.string()),
  estimated_timeline: z.string(),
});

export type OnboardingSummary = z.infer<typeof OnboardingSummarySchema>;

// --- ProcessedApplication (combined output) ---

export const ProcessedApplicationSchema = z.object({
  application: ClientApplicationSchema,
  risk_assessment: RiskAssessmentSchema,
  onboarding_summary: OnboardingSummarySchema,
});

export type ProcessedApplication = z.infer<typeof ProcessedApplicationSchema>;
