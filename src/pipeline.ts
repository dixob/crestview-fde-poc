import Anthropic from "@anthropic-ai/sdk";
import { assessRisk } from "./stages/risk-assess.js";
import { summarize } from "./stages/summarize.js";
import type { ClientApplication, ProcessedApplication } from "./types.js";

export async function processApplication(
  client: Anthropic,
  app: ClientApplication,
): Promise<ProcessedApplication> {
  const id = app.application_id;
  console.log(`[${new Date().toISOString()}] [${id}] Pipeline — starting`);

  const risk_assessment = await assessRisk(client, app);
  const onboarding_summary = await summarize(client, app, risk_assessment);

  console.log(`[${new Date().toISOString()}] [${id}] Pipeline — complete`);

  return {
    application: app,
    risk_assessment,
    onboarding_summary,
  };
}
