import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { RiskAssessmentSchema, type ClientApplication, type RiskAssessment } from "../types.js";

const MODEL = "claude-sonnet-4-5";

const promptPath = new URL("../prompts/risk-assess.md", import.meta.url);
const systemPrompt = fs.readFileSync(promptPath, "utf-8");

export async function assessRisk(
  client: Anthropic,
  app: ClientApplication,
): Promise<RiskAssessment> {
  const id = app.application_id;
  console.log(`[${new Date().toISOString()}] [${id}] Stage: risk-assess — starting`);

  try {
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: JSON.stringify(app) }],
      output_config: {
        format: zodOutputFormat(RiskAssessmentSchema),
      },
    });

    const result = response.parsed_output;
    if (!result) {
      throw new Error("parsed_output is null — model may have refused or returned empty content");
    }

    console.log(`[${new Date().toISOString()}] [${id}] Stage: risk-assess — complete (risk_level: ${result.risk_level})`);
    return result;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${id}] Stage: risk-assess — FAILED`);
    console.error("Raw error:", error);
    throw new Error(`[risk-assess] [${id}] ${error instanceof Error ? error.message : String(error)}`);
  }
}
