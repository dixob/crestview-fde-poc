import dotenv from "dotenv";
dotenv.config({ override: true });

import fs from "node:fs";
import { z } from "zod/v4";

import { ProcessedApplicationSchema } from "../types.js";
import type { ProcessedApplication } from "../types.js";
import type { BoardConfig } from "../monday/bootstrap.js";
import { routeApplication } from "../monday/router.js";
import { writeApplication } from "../monday/writer.js";

const APPS_PATH = "output/final-15.json";
const CONFIG_PATH = "board.config.json";

// Local shape check that narrows unknown → BoardConfig. Mirrors the
// hasAllColumns predicate in src/monday/bootstrap.ts (which is not exported,
// and this engagement's scope explicitly forbids modifying bootstrap.ts).
function isCompleteBoardConfig(value: unknown): value is BoardConfig {
  if (value === null || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  const hasString = (v: unknown): boolean => typeof v === "string" && v.length > 0;
  const hasStatusId = (v: unknown): boolean =>
    v !== null && typeof v === "object" && hasString((v as Record<string, unknown>)["id"]);

  if (!hasString(rec["boardId"])) return false;

  const groups = rec["groups"];
  if (groups === null || typeof groups !== "object") return false;
  const g = groups as Record<string, unknown>;
  if (
    !hasString(g["autoApproved"]) ||
    !hasString(g["analystReview"]) ||
    !hasString(g["escalation"])
  ) {
    return false;
  }

  const columns = rec["columns"];
  if (columns === null || typeof columns !== "object") return false;
  const c = columns as Record<string, unknown>;
  return (
    hasString(c["applicationId"]) &&
    hasString(c["confidence"]) &&
    hasString(c["regulatoryFlags"]) &&
    hasString(c["riskFactors"]) &&
    hasString(c["overrideRationale"]) &&
    hasString(c["processingTimestamp"]) &&
    hasString(c["pipelineVersion"]) &&
    hasString(c["onboardingSummary"]) &&
    hasStatusId(c["riskTier"]) &&
    hasStatusId(c["recommendedAction"]) &&
    hasStatusId(c["analystOverride"])
  );
}

type Success = { applicationId: string; itemId: string; groupId: string };
type Failure = { applicationId: string; errorMessage: string };

async function main(): Promise<void> {
  // Pre-flight: apps file exists.
  if (!fs.existsSync(APPS_PATH)) {
    throw new Error(
      `[publish] ${APPS_PATH} not found — run "npm start" first to regenerate the pipeline output`,
    );
  }

  // Parse and Zod-validate the apps array.
  let apps: ProcessedApplication[];
  try {
    const raw = JSON.parse(fs.readFileSync(APPS_PATH, "utf-8"));
    apps = z.array(ProcessedApplicationSchema).parse(raw);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`[publish] Failed to parse ${APPS_PATH}: ${cause}`);
  }

  // Pre-flight: board config exists and has every required column.
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `[publish] ${CONFIG_PATH} missing — run "npm run bootstrap" first`,
    );
  }
  const rawConfig: unknown = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  if (!isCompleteBoardConfig(rawConfig)) {
    throw new Error(
      `[publish] ${CONFIG_PATH} incomplete — run "npm run bootstrap" first`,
    );
  }
  const config: BoardConfig = rawConfig;

  const successes: Success[] = [];
  const failures: Failure[] = [];
  const total = apps.length;

  // Serial loop — one create_item call per app. Continue-on-error: a failure
  // on item N logs + records and moves on to N+1 so the whole batch runs to
  // completion. Exit code is set from failures.length after the loop.
  for (let i = 0; i < apps.length; i++) {
    const app = apps[i]!;
    const idx = i + 1;
    const applicationId = app.application.application_id;

    try {
      const route = routeApplication(app, config);
      console.log(
        `[${new Date().toISOString()}] [${idx}/${total}] ${applicationId} → ${route.routingReason}`,
      );
      const itemId = await writeApplication(app, route, config);
      console.log(
        `[${new Date().toISOString()}] [${idx}/${total}] ${applicationId} → item ${itemId} created`,
      );
      successes.push({ applicationId, itemId, groupId: route.groupId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[${new Date().toISOString()}] [${idx}/${total}] ${applicationId} → FAILED: ${message}`,
      );
      failures.push({ applicationId, errorMessage: message });
    }
  }

  console.log(
    `[${new Date().toISOString()}] [publish] Summary: ${successes.length} of ${total} succeeded, ${failures.length} failed`,
  );
  for (const f of failures) {
    console.log(
      `[${new Date().toISOString()}] [publish]   FAILED: ${f.applicationId} — ${f.errorMessage}`,
    );
  }

  if (failures.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\n[publish] Fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
