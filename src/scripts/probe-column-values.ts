import dotenv from "dotenv";
dotenv.config({ override: true });

import fs from "node:fs";
import path from "node:path";
import { mondayRequest } from "../monday/client.js";
import type { BoardConfig } from "../monday/bootstrap.js";

// Probe script — one-shot investigation of monday's column_values payload
// shapes for create_item. Creates two test items in the Analyst review group
// (one with status values set by label name, one by index), reads them back
// via items { column_values { ... } }, tries create_update for a
// description-like surface, then deletes the probe items. Logs everything.
//
// The monday_lessons.md precedent: creation mutations silently substitute
// defaults on wrong input shapes with no error signal. So this probe exists
// to find the shapes the board writer should commit to, and to catch any
// silent substitutions by comparing what we sent to what comes back.

const CREATE_ITEM_MUTATION = `
  mutation ($boardId: ID!, $groupId: String, $itemName: String!, $columnValues: JSON) {
    create_item(
      board_id: $boardId,
      group_id: $groupId,
      item_name: $itemName,
      column_values: $columnValues
    ) {
      id
      name
      group { id title }
      column_values {
        id
        type
        text
        value
      }
    }
  }
`;

const READ_ITEM_QUERY = `
  query ($ids: [ID!]) {
    items(ids: $ids) {
      id
      name
      group { id title }
      column_values {
        id
        type
        text
        value
      }
    }
  }
`;

const CREATE_UPDATE_MUTATION = `
  mutation ($itemId: ID!, $body: String!) {
    create_update(item_id: $itemId, body: $body) {
      id
      body
      text_body
    }
  }
`;

const DELETE_ITEM_MUTATION = `
  mutation ($itemId: ID!) {
    delete_item(item_id: $itemId) {
      id
    }
  }
`;

type CreateItemResponse = {
  create_item: {
    id: string;
    name: string;
    group: { id: string; title: string };
    column_values: Array<{ id: string; type: string; text: string | null; value: string | null }>;
  };
};

type ReadItemsResponse = {
  items: Array<{
    id: string;
    name: string;
    group: { id: string; title: string };
    column_values: Array<{ id: string; type: string; text: string | null; value: string | null }>;
  }>;
};

type CreateUpdateResponse = {
  create_update: { id: string; body: string; text_body: string };
};

type DeleteItemResponse = {
  delete_item: { id: string };
};

const log = (msg: string): void => {
  console.log(`[${new Date().toISOString()}] [probe] ${msg}`);
};

function readConfig(): BoardConfig {
  const filePath = path.resolve(process.cwd(), "board.config.json");
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as BoardConfig;
}

function dumpColumnValues(
  label: string,
  values: Array<{ id: string; type: string; text: string | null; value: string | null }>,
): void {
  log(`${label}: ${values.length} column_values rows`);
  for (const cv of values) {
    console.log(`  - id=${cv.id} type=${cv.type}`);
    console.log(`    text=${cv.text === null ? "<null>" : JSON.stringify(cv.text)}`);
    console.log(`    value=${cv.value === null ? "<null>" : cv.value}`);
  }
}

async function createProbeItem(
  boardId: string,
  groupId: string,
  itemName: string,
  columnValues: Record<string, unknown>,
): Promise<CreateItemResponse["create_item"]> {
  const columnValuesJson = JSON.stringify(columnValues);
  log(`create_item: name="${itemName}" group=${groupId}`);
  log(`  column_values payload (JSON-stringified): ${columnValuesJson}`);
  const res = await mondayRequest<CreateItemResponse>(CREATE_ITEM_MUTATION, {
    boardId,
    groupId,
    itemName,
    columnValues: columnValuesJson,
  });
  log(`  → created item id=${res.create_item.id} name="${res.create_item.name}" group=${res.create_item.group.title}`);
  return res.create_item;
}

async function readItem(itemId: string): Promise<ReadItemsResponse["items"][number]> {
  const res = await mondayRequest<ReadItemsResponse>(READ_ITEM_QUERY, { ids: [itemId] });
  const item = res.items[0];
  if (!item) throw new Error(`[probe] readItem: no item returned for id=${itemId}`);
  return item;
}

async function tryCreateUpdate(itemId: string, body: string): Promise<void> {
  try {
    log(`create_update on item ${itemId} (body length=${body.length})`);
    const res = await mondayRequest<CreateUpdateResponse>(CREATE_UPDATE_MUTATION, {
      itemId,
      body,
    });
    log(`  → update id=${res.create_update.id}`);
    log(`  → text_body (first 200 chars): ${res.create_update.text_body.slice(0, 200)}`);
  } catch (err) {
    log(`  ✖ create_update failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function deleteItem(itemId: string): Promise<void> {
  try {
    log(`delete_item id=${itemId}`);
    const res = await mondayRequest<DeleteItemResponse>(DELETE_ITEM_MUTATION, { itemId });
    log(`  → deleted ${res.delete_item.id}`);
  } catch (err) {
    console.error(`[probe] !! DELETE FAILED for item ${itemId}: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`[probe] !! Manual cleanup required on the live board.`);
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  log(`loaded config: boardId=${config.boardId}`);
  log(`status label maps:`);
  log(`  riskTier: ${JSON.stringify(config.columns.riskTier.labels)}`);
  log(`  recommendedAction: ${JSON.stringify(config.columns.recommendedAction.labels)}`);
  log(`  analystOverride: ${JSON.stringify(config.columns.analystOverride.labels)}`);

  const createdItems: string[] = [];

  try {
    // -----------------------------------------------------------------------
    // PROBE A — status columns set by label name
    // -----------------------------------------------------------------------
    log("===== PROBE A: status set by label name =====");
    const columnValuesA: Record<string, unknown> = {
      [config.columns.applicationId]: "APP-PROBE-A",
      [config.columns.confidence]: 0.87,
      [config.columns.processingTimestamp]: { date: "2026-04-14" },
      [config.columns.pipelineVersion]: "v0.1.0-probe",
      [config.columns.riskFactors]: { text: "probe factor 1\nprobe factor 2" },
      [config.columns.overrideRationale]: { text: "probe rationale" },
      [config.columns.riskTier.id]: { label: "LOW" },
      [config.columns.recommendedAction.id]: { label: "AUTO_APPROVE" },
      [config.columns.analystOverride.id]: { label: "PENDING" },
      [config.columns.regulatoryFlags]: { labels: ["FATF_R10", "OFAC"] },
    };

    const createdA = await createProbeItem(
      config.boardId,
      config.groups.analystReview,
      "PROBE A — status by label",
      columnValuesA,
    );
    createdItems.push(createdA.id);
    dumpColumnValues("PROBE A create_item response column_values", createdA.column_values);

    log("re-reading PROBE A via items query...");
    const readA = await readItem(createdA.id);
    dumpColumnValues("PROBE A re-read column_values", readA.column_values);

    // -----------------------------------------------------------------------
    // PROBE B — status columns set by index (color-coupled numeric IDs)
    // -----------------------------------------------------------------------
    log("===== PROBE B: status set by index =====");
    const columnValuesB: Record<string, unknown> = {
      [config.columns.applicationId]: "APP-PROBE-B",
      [config.columns.confidence]: "0.42", // try stringified number
      [config.columns.processingTimestamp]: { date: "2026-04-14", time: "12:34:56" }, // with time
      [config.columns.pipelineVersion]: "v0.1.0-probe-B",
      [config.columns.riskFactors]: { text: "probe B factor" },
      [config.columns.overrideRationale]: { text: "probe B rationale" },
      [config.columns.riskTier.id]: { index: config.columns.riskTier.labels.HIGH },
      [config.columns.recommendedAction.id]: { index: config.columns.recommendedAction.labels.ESCALATE },
      [config.columns.analystOverride.id]: { index: config.columns.analystOverride.labels.AGREE },
      [config.columns.regulatoryFlags]: { labels: ["BSA"] }, // single label
    };

    const createdB = await createProbeItem(
      config.boardId,
      config.groups.analystReview,
      "PROBE B — status by index + stringified number + date+time",
      columnValuesB,
    );
    createdItems.push(createdB.id);
    dumpColumnValues("PROBE B create_item response column_values", createdB.column_values);

    log("re-reading PROBE B via items query...");
    const readB = await readItem(createdB.id);
    dumpColumnValues("PROBE B re-read column_values", readB.column_values);

    // -----------------------------------------------------------------------
    // PROBE C — create_update as the onboarding-summary surface
    // -----------------------------------------------------------------------
    log("===== PROBE C: create_update as the onboarding-summary surface =====");
    const updateBody = [
      "# Client overview",
      "Greenfield State Pension Fund — $750M mandate across equities and fixed income.",
      "",
      "## Key requirements",
      "- Execute standard institutional onboarding",
      "- Review board resolution, IPS, authorized signatory list",
      "",
      "## Estimated timeline",
      "2-3 weeks for standard institutional onboarding",
    ].join("\n");
    await tryCreateUpdate(createdA.id, updateBody);

    log("===== PROBE complete, proceeding to cleanup =====");
  } finally {
    for (const id of createdItems) {
      await deleteItem(id);
    }
  }
}

main().catch((err) => {
  console.error(`\n[probe] Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
