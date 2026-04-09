import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { OnboardingSummarySchema, type ClientApplication, type RiskAssessment, type OnboardingSummary } from "../types.js";

const MODEL = "claude-sonnet-4-5";

const promptPath = new URL("../prompts/summarize.md", import.meta.url);
const systemPrompt = fs.readFileSync(promptPath, "utf-8");

export async function summarize(
  client: Anthropic,
  app: ClientApplication,
  risk: RiskAssessment,
): Promise<OnboardingSummary> {
  const id = app.application_id;
  console.log(`[${new Date().toISOString()}] [${id}] Stage: summarize — starting`);

  const userMessage = JSON.stringify({ application: app, risk_assessment: risk });

  try {
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      output_config: {
        format: zodOutputFormat(OnboardingSummarySchema),
      },
    });

    const result = response.parsed_output;
    if (!result) {
      throw new Error("parsed_output is null — model may have refused or returned empty content");
    }

    console.log(`[${new Date().toISOString()}] [${id}] Stage: summarize — complete (complexity: ${result.complexity})`);
    return result;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${id}] Stage: summarize — FAILED`);
    console.error("Raw error:", error);
    throw new Error(`[summarize] [${id}] ${error instanceof Error ? error.message : String(error)}`);
  }
}
