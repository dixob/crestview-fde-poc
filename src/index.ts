import dotenv from "dotenv";
dotenv.config({ override: true });
import fs from "node:fs";
import { parse } from "csv-parse/sync";
import Anthropic from "@anthropic-ai/sdk";
import { ClientApplicationSchema, type ProcessedApplication } from "./types.js";
import { processApplication } from "./pipeline.js";

function parseAum(raw: string): number {
  return Number(raw.replace(/[$,]/g, ""));
}

// Read and parse CSV
const csvRaw = fs.readFileSync("crestview_client_applications.csv", "utf-8");
const csvClean = csvRaw.replace(/,\s*$/gm, ""); // strip trailing commas
const records: Record<string, string>[] = parse(csvClean, {
  columns: true,
  skip_empty_lines: true,
  trim: true,
});

// Parse all applications
if (records.length === 0) {
  console.error("No records found in CSV");
  process.exit(1);
}

const applications = records.map((raw) =>
  ClientApplicationSchema.parse({
    ...raw,
    estimated_aum: parseAum(raw["estimated_aum"] ?? "0"),
  }),
);

console.log(`[${new Date().toISOString()}] Loaded ${applications.length} applications from CSV\n`);

// Run pipeline sequentially
const client = new Anthropic();

type SummaryRow = {
  application_id: string;
  client_name: string;
  risk_level: string;
  confidence: number;
  complexity: string;
};

async function run() {
  const summary: SummaryRow[] = [];

  const allResults: ProcessedApplication[] = [];

  for (const app of applications) {
    try {
      const result = await processApplication(client, app);

      console.log("\n" + "=".repeat(80));
      console.log(`RESULT: ${app.application_id}`);
      console.log("=".repeat(80));
      console.log(JSON.stringify(result, null, 2));
      allResults.push(result);
      console.log("\n" + "-".repeat(80) + "\n");

      summary.push({
        application_id: app.application_id,
        client_name: app.client_name,
        risk_level: result.risk_assessment.risk_level,
        confidence: result.risk_assessment.confidence,
        complexity: result.onboarding_summary.complexity,
      });
    } catch (error) {
      console.error(`\nPipeline failed for ${app.application_id}:`, error instanceof Error ? error.message : error);
      summary.push({
        application_id: app.application_id,
        client_name: app.client_name,
        risk_level: "ERROR",
        confidence: 0,
        complexity: "ERROR",
      });
    }
  }

  // Print summary table
  console.log("\n" + "=".repeat(100));
  console.log("SUMMARY");
  console.log("=".repeat(100));
  console.log(
    "Application ID".padEnd(18) +
    "Client Name".padEnd(45) +
    "Risk".padEnd(12) +
    "Conf".padEnd(8) +
    "Complexity",
  );
  console.log("-".repeat(100));
  for (const row of summary) {
    console.log(
      row.application_id.padEnd(18) +
      row.client_name.padEnd(45) +
      row.risk_level.padEnd(12) +
      row.confidence.toFixed(2).padEnd(8) +
      row.complexity,
    );
  }
  console.log("=".repeat(100));

  // Save results to file
  fs.mkdirSync("output", { recursive: true });
  fs.writeFileSync("output/final-15.json", JSON.stringify(allResults, null, 2));
  console.log(`\nResults saved to output/final-15.json`);
}

run().catch((error) => {
  console.error("\nFatal error:", error instanceof Error ? error.message : error);
  process.exit(1);
});
