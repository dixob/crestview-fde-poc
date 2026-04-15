import fs from "node:fs";
import path from "node:path";
import { mondayRequest } from "./client.js";

export type BoardConfig = {
  boardId: string;
  groups: {
    autoApproved: string;
    analystReview: string;
    escalation: string;
  };
  columns: {
    applicationId: string;
    riskTier: {
      id: string;
      labels: { LOW: number; MEDIUM: number; HIGH: number; CRITICAL: number };
    };
    confidence: string;
    recommendedAction: {
      id: string;
      labels: { AUTO_APPROVE: number; HUMAN_REVIEW: number; ESCALATE: number; REJECT: number };
    };
    regulatoryFlags: string;
    riskFactors: string;
    analystOverride: {
      id: string;
      labels: { PENDING: number; AGREE: number; DISAGREE: number };
    };
    overrideRationale: string;
    processingTimestamp: string;
    pipelineVersion: string;
  };
};

// Transitional shape used while bootstrap is assembling the full config.
// The three column-creation helpers each populate a subset of columns in
// sequence (plain → status → dropdown); the on-disk config from phase 1
// may also be missing the columns field entirely. PartialBoardConfig makes
// that honest in the type system, so the helpers no longer need
// write-boundary `as BoardConfig` casts. hasAllColumns narrows from this
// shape to the full BoardConfig at the end of bootstrapBoard.
type PartialBoardConfig = {
  boardId: string;
  groups: {
    autoApproved: string;
    analystReview: string;
    escalation: string;
  };
  columns?: Partial<BoardConfig["columns"]>;
};

const BOARD_NAME = "Crestview — Client onboarding (pilot)";
const CONFIG_FILENAME = "board.config.json";

const VERIFY_BOARD_QUERY = `
  query ($ids: [ID!]) {
    boards(ids: $ids) {
      id
      name
      state
    }
  }
`;

const CREATE_BOARD_MUTATION = `
  mutation ($name: String!, $kind: BoardKind!, $workspaceId: ID!) {
    create_board(board_name: $name, board_kind: $kind, workspace_id: $workspaceId) {
      id
    }
  }
`;

const LIST_GROUPS_QUERY = `
  query ($ids: [ID!]) {
    boards(ids: $ids) {
      groups {
        id
        title
      }
    }
  }
`;

const DELETE_GROUP_MUTATION = `
  mutation ($boardId: ID!, $groupId: String!) {
    delete_group(board_id: $boardId, group_id: $groupId) {
      id
    }
  }
`;

// Positioned variant — caller passes the enum value as a string ("before_at" or
// "after_at"). We use before_at for the first named group (to anchor it above
// the default group that monday auto-creates) and after_at for subsequent
// groups so they land immediately below the previous named group.
const CREATE_GROUP_POSITIONED_MUTATION = `
  mutation ($boardId: ID!, $title: String!, $relativeTo: String!, $method: PositionRelative!) {
    create_group(
      board_id: $boardId,
      group_name: $title,
      relative_to: $relativeTo,
      position_relative_method: $method
    ) {
      id
    }
  }
`;

// $defaults is monday's JSON scalar — for plain columns we pass null. Status
// and dropdown columns go through their typed mutations (`create_status_column`,
// `create_dropdown_column` — see below) because the generic create_column
// silently drops structured label/color data in its JSON `defaults` payload.
// settings_str comes back on the response so callers can parse the final
// state (needed e.g. for status label IDs in step 2.3).
const CREATE_COLUMN_MUTATION = `
  mutation ($boardId: ID!, $title: String!, $type: ColumnType!, $defaults: JSON) {
    create_column(board_id: $boardId, title: $title, column_type: $type, defaults: $defaults) {
      id
      title
      type
      settings_str
    }
  }
`;

// Typed status-column mutation. `defaults` is NOT a JSON scalar here — it's
// `CreateStatusColumnSettingsInput` (a strongly-typed input type discovered
// via GraphQL introspection). Unlike the generic create_column, this one
// honors per-label colors. Shape: `{ labels: [{label, color, index}, ...] }`
// where `color` is a StatusColorEnum name (e.g. "done_green", "sunset").
// monday normalizes those enum inputs to different output var_names in the
// resulting settings_str (e.g. "done_green" → "green-shadow") — see
// STATUS_ENUM_TO_VAR_NAME below for the mapping.
const CREATE_STATUS_COLUMN_MUTATION = `
  mutation ($boardId: ID!, $title: String!, $defaults: CreateStatusColumnSettingsInput!) {
    create_status_column(board_id: $boardId, title: $title, defaults: $defaults) {
      id
      title
      type
      settings_str
    }
  }
`;

// Typed dropdown-column mutation. Discovered via introspection in step 2.4
// (monday's published docs don't surface it — same gap as create_status_column
// had). `defaults` is CreateDropdownColumnSettingsInput, a strongly-typed
// input, not a JSON scalar. Shape: `{ labels: [{ label: String! }, ...] }`.
// Unlike CreateStatusLabelInput, CreateDropdownLabelInput carries NO color
// and NO index — submission order determines both display order and the
// sequential integer IDs (1..N) monday assigns in settings_str.labels[].id.
// Probe confirmed: labels round-trip by name, order is preserved, response
// also includes `deactivated_labels: []`. Phase 3 writes by name, so the
// auto-assigned IDs are not captured in BoardConfig.
const CREATE_DROPDOWN_COLUMN_MUTATION = `
  mutation ($boardId: ID!, $title: String!, $defaults: CreateDropdownColumnSettingsInput!) {
    create_dropdown_column(board_id: $boardId, title: $title, defaults: $defaults) {
      id
      title
      type
      settings_str
    }
  }
`;

const LIST_COLUMNS_QUERY = `
  query ($ids: [ID!]) {
    boards(ids: $ids) {
      columns {
        id
        title
        type
        settings_str
      }
    }
  }
`;

const DELETE_COLUMN_MUTATION = `
  mutation ($boardId: ID!, $columnId: String!) {
    delete_column(board_id: $boardId, column_id: $columnId) {
      id
    }
  }
`;

type VerifyBoardResponse = {
  boards: Array<{ id: string; name: string; state: string }>;
};

type CreateBoardResponse = {
  create_board: { id: string };
};

type ListGroupsResponse = {
  boards: Array<{ groups: Array<{ id: string; title: string }> }>;
};

type CreateGroupResponse = {
  create_group: { id: string };
};

type MondayColumn = { id: string; title: string; type: string; settings_str: string };

type CreateColumnResponse = { create_column: MondayColumn };

type CreateStatusColumnResponse = { create_status_column: MondayColumn };

type CreateDropdownColumnResponse = { create_dropdown_column: MondayColumn };

type ListColumnsResponse = { boards: Array<{ columns: MondayColumn[] }> };

// Plain columns (text / numbers / date / long_text) don't need a defaults
// payload at creation time. Status (2.3) and dropdown (2.4) specs live in
// their own tables below when those steps land.
type PlainColumnType = "text" | "numbers" | "date" | "long_text";

type PlainColumnKey =
  | "applicationId"
  | "confidence"
  | "riskFactors"
  | "overrideRationale"
  | "processingTimestamp"
  | "pipelineVersion";

type PlainColumnSpec = { key: PlainColumnKey; title: string; type: PlainColumnType };

// Order matches the step 2.2 prompt exactly. Note this is NOT the final
// left-to-right visual order on the board — status (2.3) and dropdown (2.4)
// columns get interleaved later and monday appends new columns to the right.
// Visual reordering (if the demo needs it) is out of scope for phase 2.
const PLAIN_COLUMN_SPECS: readonly PlainColumnSpec[] = [
  { key: "applicationId", title: "Application ID", type: "text" },
  { key: "confidence", title: "Confidence", type: "numbers" },
  { key: "riskFactors", title: "Risk factors", type: "long_text" },
  { key: "overrideRationale", title: "Override rationale", type: "long_text" },
  { key: "processingTimestamp", title: "Processing timestamp", type: "date" },
  { key: "pipelineVersion", title: "Pipeline version", type: "text" },
];

type StatusColumnKey = "riskTier" | "recommendedAction" | "analystOverride";

// Enum from monday's get_column_type_schema(type: status). These are the
// only values accepted in the managed-column `settings.labels[].color` field.
// (Earlier attempts used the hex + var_name shape from settings_str output;
// that shape is output-only — monday silently dropped it on input.)
type StatusColorEnum =
  | "working_orange" | "done_green" | "stuck_red" | "dark_blue"
  | "purple" | "explosive" | "grass_green" | "bright_blue"
  | "saladish" | "egg_yolk" | "blackish" | "dark_red"
  | "sofia_pink" | "lipstick" | "dark_purple" | "bright_green"
  | "chili_blue" | "american_gray" | "brown" | "dark_orange"
  | "sunset" | "bubble" | "peach" | "berry"
  | "winter" | "river" | "navy" | "aquamarine"
  | "indigo" | "dark_indigo" | "pecan" | "lavender"
  | "royal" | "steel" | "orchid" | "lilac"
  | "tan" | "sky" | "coffee" | "teal";

type StatusColumnSpec = {
  key: StatusColumnKey;
  title: string;
  // labelsInOrder[i] and colorsInOrder[i] pair up at display position i.
  // create_status_column's `defaults` wants an array of
  // { label, color, index } entries; the board writer (phase 3) references
  // the numeric label ID monday assigns (read back from settings_str after
  // creation — NOT 0..N-1, since each color enum maps to a fixed ID in
  // monday's StatusColumnColors numeric space).
  labelsInOrder: readonly string[];
  colorsInOrder: readonly StatusColorEnum[];
};

// When we send `color: "done_green"` to create_status_column, monday stores
// it and emits a different var_name in the resulting settings_str. The
// normalization is NOT a simple underscore→hyphen swap — "done_green" comes
// back as "green-shadow", "egg_yolk" as "yellow", etc. Probed empirically
// via src/scripts/probe-columns.ts. Only colors we actually use are listed;
// adding a new StatusColorEnum to a spec without updating this map will
// break the round-trip check in createStatusColumn.
const STATUS_ENUM_TO_VAR_NAME: Partial<Record<StatusColorEnum, string>> = {
  done_green: "green-shadow",
  egg_yolk: "yellow",
  sunset: "sunset",
  dark_red: "dark-red",
  american_gray: "trolley-grey",
  stuck_red: "red-shadow",
};

const STATUS_COLUMN_SPECS: readonly StatusColumnSpec[] = [
  {
    key: "riskTier",
    title: "Risk tier",
    labelsInOrder: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
    // Severity progression: green → yellow → orange → dark red
    colorsInOrder: ["done_green", "egg_yolk", "sunset", "dark_red"],
  },
  {
    key: "recommendedAction",
    title: "Recommended action",
    labelsInOrder: ["AUTO_APPROVE", "HUMAN_REVIEW", "ESCALATE", "REJECT"],
    colorsInOrder: ["done_green", "egg_yolk", "sunset", "dark_red"],
  },
  {
    key: "analystOverride",
    title: "Analyst override",
    labelsInOrder: ["PENDING", "AGREE", "DISAGREE"],
    // PENDING → neutral gray so it reads as "not yet touched"
    colorsInOrder: ["american_gray", "done_green", "stuck_red"],
  },
];

type DropdownColumnKey = "regulatoryFlags";

type DropdownColumnSpec = {
  key: DropdownColumnKey;
  title: string;
  // Order here becomes the order labels appear in monday's picker and the
  // order monday uses to assign sequential integer IDs in settings_str.
  // No per-label color (CreateDropdownLabelInput has only a `label` field).
  labelsInOrder: readonly string[];
};

const DROPDOWN_COLUMN_SPECS: readonly DropdownColumnSpec[] = [
  {
    key: "regulatoryFlags",
    title: "Regulatory flags",
    labelsInOrder: ["FATF_R10", "FATF_R12", "FinCEN_CDD", "SAR_31CFR1023_320", "OFAC", "BSA"],
  },
];

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] [bootstrap] ${message}`);
}

function configPath(): string {
  return path.resolve(process.cwd(), CONFIG_FILENAME);
}

function readExistingConfig(): PartialBoardConfig | null {
  const file = configPath();
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as PartialBoardConfig;
    if (!parsed.boardId) {
      return null;
    }
    return parsed;
  } catch (err) {
    log(`Found ${CONFIG_FILENAME} but could not parse it: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// Runtime check — phase-1 config files have no columns field, and mid-chain
// partial configs have only some of the ten entries. Acts as a type guard:
// on true, the caller may treat the config as a fully populated BoardConfig
// (columns field present with every expected key). This is the single
// narrowing point in the module; it replaces the transitional
// `as BoardConfig` casts that used to live at each helper's write boundary.
function hasAllColumns(config: PartialBoardConfig): config is BoardConfig {
  const c = config.columns;
  if (!c || typeof c !== "object") return false;
  const rec = c as Record<string, unknown>;
  const hasString = (v: unknown): boolean => typeof v === "string" && v.length > 0;
  const hasStatusId = (v: unknown): boolean =>
    v !== null && typeof v === "object" && hasString((v as Record<string, unknown>)["id"]);
  return (
    hasString(rec["applicationId"]) &&
    hasString(rec["confidence"]) &&
    hasString(rec["regulatoryFlags"]) &&
    hasString(rec["riskFactors"]) &&
    hasString(rec["overrideRationale"]) &&
    hasString(rec["processingTimestamp"]) &&
    hasString(rec["pipelineVersion"]) &&
    hasStatusId(rec["riskTier"]) &&
    hasStatusId(rec["recommendedAction"]) &&
    hasStatusId(rec["analystOverride"])
  );
}

async function verifyBoardActive(boardId: string): Promise<boolean> {
  const data = await mondayRequest<VerifyBoardResponse>(VERIFY_BOARD_QUERY, { ids: [boardId] });
  const board = data.boards?.[0];
  return board !== undefined && board.state === "active";
}

async function createBoard(workspaceId: string): Promise<string> {
  const data = await mondayRequest<CreateBoardResponse>(CREATE_BOARD_MUTATION, {
    name: BOARD_NAME,
    kind: "public",
    workspaceId,
  });
  const id = data.create_board?.id;
  if (!id) {
    throw new Error("[bootstrap] create_board returned no id");
  }
  return id;
}

async function listGroups(boardId: string): Promise<Array<{ id: string; title: string }>> {
  const data = await mondayRequest<ListGroupsResponse>(LIST_GROUPS_QUERY, { ids: [boardId] });
  return data.boards?.[0]?.groups ?? [];
}

async function deleteGroupSafe(boardId: string, groupId: string): Promise<void> {
  try {
    await mondayRequest<{ delete_group: { id: string } }>(DELETE_GROUP_MUTATION, {
      boardId,
      groupId,
    });
    log(`Deleted default group ${groupId}`);
  } catch (err) {
    log(`Warning: failed to delete group ${groupId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function createGroupPositioned(
  boardId: string,
  title: string,
  relativeTo: string,
  method: "before_at" | "after_at",
): Promise<string> {
  const data = await mondayRequest<CreateGroupResponse>(CREATE_GROUP_POSITIONED_MUTATION, {
    boardId,
    title,
    relativeTo,
    method,
  });
  const id = data.create_group?.id;
  if (!id) {
    throw new Error(`[bootstrap] create_group returned no id for title="${title}"`);
  }
  log(`Created group "${title}" (id=${id}) ${method} ${relativeTo}`);
  return id;
}

function writeConfig(config: PartialBoardConfig): void {
  const file = configPath();
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  log(`Wrote config to ${file}`);
}

async function listColumns(boardId: string): Promise<MondayColumn[]> {
  const data = await mondayRequest<ListColumnsResponse>(LIST_COLUMNS_QUERY, { ids: [boardId] });
  return data.boards?.[0]?.columns ?? [];
}

async function createPlainColumn(
  boardId: string,
  title: string,
  type: PlainColumnType,
): Promise<string> {
  const data = await mondayRequest<CreateColumnResponse>(CREATE_COLUMN_MUTATION, {
    boardId,
    title,
    type,
    defaults: null,
  });
  const id = data.create_column?.id;
  if (!id) {
    throw new Error(`[bootstrap] create_column returned no id for title="${title}" type=${type}`);
  }
  log(`Created ${type} column "${title}" (id=${id})`);
  return id;
}

// Build the `defaults` input for create_status_column. Returned as an object
// (NOT a stringified JSON scalar) because the typed mutation takes
// `CreateStatusColumnSettingsInput`, not a JSON scalar. Shape:
// `{ labels: [{label, color, index}, ...] }`. `color` is a StatusColorEnum
// name; `index` sets the picker display position.
function buildStatusDefaults(
  spec: StatusColumnSpec,
): { labels: Array<{ label: string; color: StatusColorEnum; index: number }> } {
  return {
    labels: spec.labelsInOrder.map((label, i) => ({
      label,
      color: spec.colorsInOrder[i]!,
      index: i,
    })),
  };
}

// Compares a status column's live settings_str against the spec. Returns
// true only when every expected label name is present AND its emitted
// var_name in labels_colors matches the var_name we expect for the color
// enum we requested (per STATUS_ENUM_TO_VAR_NAME). Used both for idempotency
// (skip recreation when palette already matches) and as a round-trip check
// after creation (catch silent drops where monday applies its default
// palette instead of ours).
function hasDesiredPalette(settingsStr: string, spec: StatusColumnSpec): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsStr);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const labels = (parsed as Record<string, unknown>)["labels"];
  const colors = (parsed as Record<string, unknown>)["labels_colors"];
  if (!labels || typeof labels !== "object") return false;
  if (!colors || typeof colors !== "object") return false;
  const labelRec = labels as Record<string, unknown>;
  const colorRec = colors as Record<string, unknown>;

  // labels in the output settings_str is keyed by numeric ID (a value from
  // StatusColumnColors). Invert to a name→id map to find each expected
  // label, then check the paired color entry's var_name.
  const nameToId: Record<string, string> = {};
  for (const [id, name] of Object.entries(labelRec)) {
    if (typeof name === "string") nameToId[name] = id;
  }
  for (let i = 0; i < spec.labelsInOrder.length; i++) {
    const labelName = spec.labelsInOrder[i]!;
    const id = nameToId[labelName];
    if (id === undefined) return false;
    const entry = colorRec[id];
    if (!entry || typeof entry !== "object") return false;
    const varName = (entry as Record<string, unknown>)["var_name"];
    if (typeof varName !== "string") return false;
    const expectedEnum = spec.colorsInOrder[i]!;
    const expectedVarName = STATUS_ENUM_TO_VAR_NAME[expectedEnum];
    if (!expectedVarName) {
      // Missing map entry is a bug in STATUS_ENUM_TO_VAR_NAME, not a palette
      // mismatch — surface it rather than silently returning false.
      throw new Error(
        `[bootstrap] STATUS_ENUM_TO_VAR_NAME has no entry for color "${expectedEnum}" used by label "${labelName}" in column "${spec.title}". Probe the enum and add the mapping.`,
      );
    }
    if (varName !== expectedVarName) return false;
  }
  return true;
}

// Parse settings_str from a status column response and build the name→index
// map. Throws if the response is unparseable, malformed, or missing any of
// the expected labels — that's a silent-failure signature we want to surface
// loudly per CLAUDE.md's Q&A discipline (wrong payload shape yields a column
// whose settings_str doesn't match what we asked for, with no GraphQL error).
function parseStatusLabels(
  settingsStr: string,
  expectedLabels: readonly string[],
): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsStr);
  } catch (err) {
    throw new Error(
      `[bootstrap] Could not parse settings_str as JSON: ${err instanceof Error ? err.message : String(err)} | settings_str=${settingsStr}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`[bootstrap] settings_str did not decode to an object | settings_str=${settingsStr}`);
  }
  const labelsRaw = (parsed as Record<string, unknown>)["labels"];
  if (!labelsRaw || typeof labelsRaw !== "object") {
    throw new Error(
      `[bootstrap] settings_str missing 'labels' object (wrong defaults shape?) | settings_str=${settingsStr}`,
    );
  }
  const labelMap: Record<string, number> = {};
  for (const [idxStr, nameRaw] of Object.entries(labelsRaw as Record<string, unknown>)) {
    if (typeof nameRaw !== "string") continue;
    const idx = Number(idxStr);
    if (!Number.isInteger(idx)) continue;
    labelMap[nameRaw] = idx;
  }
  const missing = expectedLabels.filter((lbl) => !(lbl in labelMap));
  if (missing.length > 0) {
    throw new Error(
      `[bootstrap] settings_str missing expected label(s): ${missing.join(", ")} | settings_str=${settingsStr}`,
    );
  }
  return labelMap;
}

async function deleteColumn(boardId: string, columnId: string): Promise<void> {
  await mondayRequest<{ delete_column: { id: string } }>(DELETE_COLUMN_MUTATION, {
    boardId,
    columnId,
  });
  log(`Deleted column id=${columnId}`);
}

async function createStatusColumn(
  boardId: string,
  spec: StatusColumnSpec,
): Promise<{ id: string; labels: Record<string, number>; settingsStr: string }> {
  const defaults = buildStatusDefaults(spec);
  // Typed mutation — defaults is a GraphQL input type, not a JSON scalar,
  // so we pass the object directly (no JSON.stringify).
  const data = await mondayRequest<CreateStatusColumnResponse>(CREATE_STATUS_COLUMN_MUTATION, {
    boardId,
    title: spec.title,
    defaults,
  });
  const col = data.create_status_column;
  if (!col?.id) {
    throw new Error(`[bootstrap] create_status_column returned no id for "${spec.title}"`);
  }
  const labels = parseStatusLabels(col.settings_str, spec.labelsInOrder);
  // Round-trip check: catches silent drops where monday falls back to a
  // default palette instead of applying our colors.
  if (!hasDesiredPalette(col.settings_str, spec)) {
    throw new Error(
      `[bootstrap] Status column "${spec.title}" created (id=${col.id}) but custom palette did not round-trip. settings_str=${col.settings_str}`,
    );
  }
  const pretty = Object.entries(labels)
    .sort((a, b) => a[1] - b[1])
    .map(([n, i]) => `${n}=${i}`)
    .join(", ");
  log(`Created status column "${spec.title}" (id=${col.id}) labels=[${pretty}] palette=verified`);
  return { id: col.id, labels, settingsStr: col.settings_str };
}

// Build the `defaults` input for create_dropdown_column. Returned as an
// object (not stringified) because the typed mutation takes
// `CreateDropdownColumnSettingsInput`. Shape: `{ labels: [{ label }, ...] }`.
// No `color` or `index` fields — dropdown's label input type only carries
// the name. Submission order is preserved in the response and determines
// the sequential integer IDs (1..N) monday writes into settings_str.
function buildDropdownDefaults(spec: DropdownColumnSpec): { labels: Array<{ label: string }> } {
  return {
    labels: spec.labelsInOrder.map((label) => ({ label })),
  };
}

// Compare a dropdown column's live settings_str against the spec. Returns
// true iff the expected set of label names is EXACTLY present in the
// response (order-insensitive — phase 3 writes by name, so display order
// is cosmetic). Counts a deactivated label as absent: a label that exists
// but is disabled can't receive values, so the delete-and-recreate path
// should run to restore a clean column.
function hasDesiredLabels(settingsStr: string, spec: DropdownColumnSpec): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsStr);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const labels = (parsed as Record<string, unknown>)["labels"];
  if (!Array.isArray(labels)) return false;

  const activeNames = new Set<string>();
  for (const entry of labels) {
    if (entry && typeof entry === "object") {
      const n = (entry as Record<string, unknown>)["name"];
      if (typeof n === "string") activeNames.add(n);
    }
  }

  // Subtract any labels that monday reports as deactivated. The probe saw
  // `deactivated_labels: []` on a fresh column; if anything shows up there
  // whose name matches an expected label, the column is effectively missing
  // that label for writes.
  const deact = (parsed as Record<string, unknown>)["deactivated_labels"];
  if (Array.isArray(deact)) {
    for (const entry of deact) {
      const name =
        entry && typeof entry === "object"
          ? (entry as Record<string, unknown>)["name"]
          : entry;
      if (typeof name === "string") activeNames.delete(name);
    }
  }

  if (activeNames.size !== spec.labelsInOrder.length) return false;
  for (const expected of spec.labelsInOrder) {
    if (!activeNames.has(expected)) return false;
  }
  return true;
}

// Parse settings_str from a dropdown column response and assert every
// expected label is present. Throws with the full settings_str in the
// error on any shape mismatch — the silent-substitution defense that
// parseStatusLabels runs, adapted to dropdown's array-of-{id, name}
// layout. Callers discard the return if they don't need it.
function parseDropdownLabels(
  settingsStr: string,
  expectedLabels: readonly string[],
): ReadonlySet<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsStr);
  } catch (err) {
    throw new Error(
      `[bootstrap] Could not parse dropdown settings_str as JSON: ${err instanceof Error ? err.message : String(err)} | settings_str=${settingsStr}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(
      `[bootstrap] dropdown settings_str did not decode to an object | settings_str=${settingsStr}`,
    );
  }
  const labelsRaw = (parsed as Record<string, unknown>)["labels"];
  if (!Array.isArray(labelsRaw)) {
    throw new Error(
      `[bootstrap] dropdown settings_str 'labels' is not an array (wrong defaults shape?) | settings_str=${settingsStr}`,
    );
  }
  const names = new Set<string>();
  for (const entry of labelsRaw) {
    if (entry && typeof entry === "object") {
      const n = (entry as Record<string, unknown>)["name"];
      if (typeof n === "string") names.add(n);
    }
  }
  const missing = expectedLabels.filter((lbl) => !names.has(lbl));
  if (missing.length > 0) {
    throw new Error(
      `[bootstrap] dropdown settings_str missing expected label(s): ${missing.join(", ")} | settings_str=${settingsStr}`,
    );
  }
  return names;
}

async function createDropdownColumn(
  boardId: string,
  spec: DropdownColumnSpec,
): Promise<{ id: string; settingsStr: string }> {
  const defaults = buildDropdownDefaults(spec);
  // Typed mutation — defaults is CreateDropdownColumnSettingsInput, not a
  // JSON scalar, so we pass the object directly (no JSON.stringify).
  const data = await mondayRequest<CreateDropdownColumnResponse>(
    CREATE_DROPDOWN_COLUMN_MUTATION,
    { boardId, title: spec.title, defaults },
  );
  const col = data.create_dropdown_column;
  if (!col?.id) {
    throw new Error(`[bootstrap] create_dropdown_column returned no id for "${spec.title}"`);
  }
  // Parse first (throws on missing labels with settings_str in the error),
  // then hasDesiredLabels for the stricter exact-set round-trip check.
  parseDropdownLabels(col.settings_str, spec.labelsInOrder);
  if (!hasDesiredLabels(col.settings_str, spec)) {
    throw new Error(
      `[bootstrap] Dropdown column "${spec.title}" created (id=${col.id}) but label set did not round-trip. settings_str=${col.settings_str}`,
    );
  }
  log(
    `Created dropdown column "${spec.title}" (id=${col.id}) labels=[${spec.labelsInOrder.join(", ")}]`,
  );
  return { id: col.id, settingsStr: col.settings_str };
}

// Step 2.2: create the six plain columns, tolerating re-runs by reusing any
// column that already exists on the board with the same title. Merges the
// resulting IDs into the existing config (preserving any partial columns
// field from prior runs) and persists. The returned config is still
// deliberately partial — status (2.3) and dropdown (2.4) fields are absent,
// so `hasAllColumns` will still report false until step 2.4 completes.
async function createPlainColumnsIntoConfig(existing: PartialBoardConfig): Promise<PartialBoardConfig> {
  log("Listing existing columns on board to detect already-created plain columns...");
  const onBoardBefore = await listColumns(existing.boardId);
  const byTitle = new Map(onBoardBefore.map((c) => [c.title, c]));

  const plainIds: Partial<Record<PlainColumnKey, string>> = {};
  for (const spec of PLAIN_COLUMN_SPECS) {
    const already = byTitle.get(spec.title);
    if (already) {
      log(`Plain column "${spec.title}" already on board (id=${already.id}, type=${already.type}); reusing`);
      plainIds[spec.key] = already.id;
      continue;
    }
    plainIds[spec.key] = await createPlainColumn(existing.boardId, spec.title, spec.type);
  }

  // Post-creation verification — re-query and confirm every plain column
  // title is present. Catches silent failures where create_column returned
  // without error but the column didn't land.
  log("Re-listing columns to verify all six plain columns exist...");
  const onBoardAfter = await listColumns(existing.boardId);
  const titleSet = new Set(onBoardAfter.map((c) => c.title));
  const missing = PLAIN_COLUMN_SPECS.filter((s) => !titleSet.has(s.title));
  if (missing.length > 0) {
    throw new Error(
      `[bootstrap] Post-creation verification failed — missing column(s): ${missing.map((s) => s.title).join(", ")}`,
    );
  }
  log(`Verified: ${PLAIN_COLUMN_SPECS.length} plain columns present on board`);

  // Carry over any pre-existing columns-field state (step 2.3/2.4 state on
  // re-runs) and overlay the six plain-column IDs.
  const prior: Partial<BoardConfig["columns"]> = existing.columns ?? {};
  const mergedColumns: Partial<BoardConfig["columns"]> = {
    ...prior,
    applicationId: plainIds.applicationId!,
    confidence: plainIds.confidence!,
    riskFactors: plainIds.riskFactors!,
    overrideRationale: plainIds.overrideRationale!,
    processingTimestamp: plainIds.processingTimestamp!,
    pipelineVersion: plainIds.pipelineVersion!,
  };

  const updated: PartialBoardConfig = {
    boardId: existing.boardId,
    groups: existing.groups,
    columns: mergedColumns,
  };

  writeConfig(updated);
  return updated;
}

// Step 2.3: create the three status columns with labels defined at creation
// via the `defaults` argument. For each, we pre-scan the board by title so
// re-runs reuse any pre-existing column (parsing its settings_str to recover
// the label map rather than re-creating). The returned config is still
// partial — the dropdown column (2.4) is not yet in place.
async function createStatusColumnsIntoConfig(existing: PartialBoardConfig): Promise<PartialBoardConfig> {
  log("Listing existing columns on board to detect already-created status columns...");
  const onBoardBefore = await listColumns(existing.boardId);
  const byTitle = new Map(onBoardBefore.map((c) => [c.title, c]));

  const results: Partial<Record<StatusColumnKey, { id: string; labels: Record<string, number> }>> = {};

  for (const spec of STATUS_COLUMN_SPECS) {
    const already = byTitle.get(spec.title);
    if (already) {
      if (already.type !== "status") {
        throw new Error(
          `[bootstrap] Column "${spec.title}" exists with type="${already.type}", expected "status"`,
        );
      }
      if (hasDesiredPalette(already.settings_str, spec)) {
        log(`Status column "${spec.title}" (id=${already.id}) already has desired palette; reusing`);
        const labels = parseStatusLabels(already.settings_str, spec.labelsInOrder);
        results[spec.key] = { id: already.id, labels };
        continue;
      }
      // monday's create_column doesn't support updating labels/colors on an
      // existing column, so the only path to a custom palette is delete +
      // recreate. This loses the column ID — callers after phase 2 must
      // always read IDs from board.config.json rather than caching.
      log(`Status column "${spec.title}" (id=${already.id}) has non-matching palette; deleting to recreate`);
      await deleteColumn(existing.boardId, already.id);
    }
    const created = await createStatusColumn(existing.boardId, spec);
    results[spec.key] = { id: created.id, labels: created.labels };
  }

  // Verify post-creation: each status column must be on the board with the
  // correct type. We don't re-validate labels here since createStatusColumn /
  // the reuse branch both already ran parseStatusLabels against expected.
  log("Re-listing columns to verify all three status columns exist...");
  const onBoardAfter = await listColumns(existing.boardId);
  const afterByTitle = new Map(onBoardAfter.map((c) => [c.title, c]));
  for (const spec of STATUS_COLUMN_SPECS) {
    const found = afterByTitle.get(spec.title);
    if (!found) {
      throw new Error(`[bootstrap] Post-creation verification failed — status column "${spec.title}" not found`);
    }
    if (found.type !== "status") {
      throw new Error(
        `[bootstrap] Post-creation verification failed — column "${spec.title}" has type="${found.type}", expected "status"`,
      );
    }
  }
  log(`Verified: ${STATUS_COLUMN_SPECS.length} status columns present on board`);

  // Build the typed label maps explicitly so the config matches BoardConfig's
  // specific label shapes. parseStatusLabels already validated presence, so
  // the non-null assertions here are safe.
  const riskTier = results.riskTier!;
  const recAction = results.recommendedAction!;
  const override = results.analystOverride!;

  const prior: Partial<BoardConfig["columns"]> = existing.columns ?? {};
  const mergedColumns: Partial<BoardConfig["columns"]> = {
    ...prior,
    riskTier: {
      id: riskTier.id,
      labels: {
        LOW: riskTier.labels["LOW"]!,
        MEDIUM: riskTier.labels["MEDIUM"]!,
        HIGH: riskTier.labels["HIGH"]!,
        CRITICAL: riskTier.labels["CRITICAL"]!,
      },
    },
    recommendedAction: {
      id: recAction.id,
      labels: {
        AUTO_APPROVE: recAction.labels["AUTO_APPROVE"]!,
        HUMAN_REVIEW: recAction.labels["HUMAN_REVIEW"]!,
        ESCALATE: recAction.labels["ESCALATE"]!,
        REJECT: recAction.labels["REJECT"]!,
      },
    },
    analystOverride: {
      id: override.id,
      labels: {
        PENDING: override.labels["PENDING"]!,
        AGREE: override.labels["AGREE"]!,
        DISAGREE: override.labels["DISAGREE"]!,
      },
    },
  };

  const updated: PartialBoardConfig = {
    boardId: existing.boardId,
    groups: existing.groups,
    columns: mergedColumns,
  };

  writeConfig(updated);
  return updated;
}

// Step 2.4: create the dropdown column(s). Same idempotency shape as the
// 2.3 status-column flow: list by title, reuse on shape match, otherwise
// delete and recreate. Currently only `Regulatory flags`. Even though
// monday exposes `update_dropdown_column` (unlike status), we stick with
// delete-and-recreate here to keep the reuse-vs-recreate decision a single
// shape check, matching 2.3.
async function createDropdownColumnsIntoConfig(existing: PartialBoardConfig): Promise<PartialBoardConfig> {
  log("Listing existing columns on board to detect already-created dropdown columns...");
  const onBoardBefore = await listColumns(existing.boardId);
  const byTitle = new Map(onBoardBefore.map((c) => [c.title, c]));

  const results: Partial<Record<DropdownColumnKey, string>> = {};

  for (const spec of DROPDOWN_COLUMN_SPECS) {
    const already = byTitle.get(spec.title);
    if (already) {
      if (already.type !== "dropdown") {
        throw new Error(
          `[bootstrap] Column "${spec.title}" exists with type="${already.type}", expected "dropdown"`,
        );
      }
      if (hasDesiredLabels(already.settings_str, spec)) {
        log(`Dropdown column "${spec.title}" (id=${already.id}) already has desired labels; reusing`);
        results[spec.key] = already.id;
        continue;
      }
      log(`Dropdown column "${spec.title}" (id=${already.id}) has non-matching labels; deleting to recreate`);
      await deleteColumn(existing.boardId, already.id);
    }
    const created = await createDropdownColumn(existing.boardId, spec);
    results[spec.key] = created.id;
  }

  // Post-verify: each dropdown column must be on the board with the right type.
  log("Re-listing columns to verify all dropdown columns exist...");
  const onBoardAfter = await listColumns(existing.boardId);
  const afterByTitle = new Map(onBoardAfter.map((c) => [c.title, c]));
  for (const spec of DROPDOWN_COLUMN_SPECS) {
    const found = afterByTitle.get(spec.title);
    if (!found) {
      throw new Error(
        `[bootstrap] Post-creation verification failed — dropdown column "${spec.title}" not found`,
      );
    }
    if (found.type !== "dropdown") {
      throw new Error(
        `[bootstrap] Post-creation verification failed — column "${spec.title}" has type="${found.type}", expected "dropdown"`,
      );
    }
  }
  log(`Verified: ${DROPDOWN_COLUMN_SPECS.length} dropdown column(s) present on board`);

  const prior: Partial<BoardConfig["columns"]> = existing.columns ?? {};
  const mergedColumns: Partial<BoardConfig["columns"]> = {
    ...prior,
    regulatoryFlags: results.regulatoryFlags!,
  };

  const updated: PartialBoardConfig = {
    boardId: existing.boardId,
    groups: existing.groups,
    columns: mergedColumns,
  };

  writeConfig(updated);
  return updated;
}

// Column-creation chain shared by both the existing-board and fresh-board
// paths in bootstrapBoard. Each helper pre-scans by title and reuses or
// recreates per its own shape-match rules, so the whole chain is idempotent.
// Asserts the final config has every expected column via the hasAllColumns
// type guard — this is the single narrowing point from PartialBoardConfig
// to BoardConfig, replacing the four transitional casts that used to live
// at each helper's write boundary and on the fresh-board return.
async function populateColumns(partial: PartialBoardConfig): Promise<BoardConfig> {
  log("Creating plain columns (step 2.2)...");
  const afterPlain = await createPlainColumnsIntoConfig(partial);
  log("Creating status columns (step 2.3)...");
  const afterStatus = await createStatusColumnsIntoConfig(afterPlain);
  log("Creating dropdown columns (step 2.4)...");
  const afterDropdown = await createDropdownColumnsIntoConfig(afterStatus);
  if (!hasAllColumns(afterDropdown)) {
    throw new Error(
      "[bootstrap] column chain completed but hasAllColumns(config) returned false — config did not reach the full ten-column shape",
    );
  }
  return afterDropdown;
}

export async function bootstrapBoard(): Promise<BoardConfig> {
  const existing = readExistingConfig();
  if (existing) {
    log(`Found existing ${CONFIG_FILENAME} with boardId=${existing.boardId}; verifying with monday...`);
    const active = await verifyBoardActive(existing.boardId);
    // Shallow check: verifies board exists but not group shape. Drift detection deferred to production.
    if (active) {
      log("Board already exists, skipping bootstrap");
      if (hasAllColumns(existing)) {
        log("Columns already exist, skipping column creation");
        return existing;
      }
      log("Columns missing or incomplete; running column-creation chain...");
      return await populateColumns(existing);
    }
    log("Existing board is not active (deleted or archived); proceeding to recreate");
  }

  const workspaceId = process.env["MONDAY_WORKSPACE_ID"];
  if (!workspaceId) {
    throw new Error("[bootstrap] MONDAY_WORKSPACE_ID is not set in environment");
  }

  log(`Creating board "${BOARD_NAME}" in workspace ${workspaceId}...`);
  const boardId = await createBoard(workspaceId);
  log(`Created board id=${boardId}`);

  // Create the named groups BEFORE deleting defaults: monday's API throws
  // DeleteLastGroupException on delete_group if it would leave the board
  // empty, so at least one named group must exist before we start deleting.
  log("Listing default groups (for ordering anchor)...");
  const defaultGroups = await listGroups(boardId);
  log(`Found ${defaultGroups.length} default group(s): ${defaultGroups.map((g) => `${g.title}(${g.id})`).join(", ") || "(none)"}`);

  log("Creating named groups in order...");
  const firstDefault = defaultGroups[0]!;
  const autoApproved = await createGroupPositioned(boardId, "Auto-approved", firstDefault.id, "before_at");
  const analystReview = await createGroupPositioned(boardId, "Analyst review", autoApproved, "after_at");
  const escalation = await createGroupPositioned(boardId, "Escalation", analystReview, "after_at");

  // Now that three named groups exist, it's safe to delete any group that
  // isn't in our named set. We re-list rather than relying on the earlier
  // snapshot so any groups that got reshuffled are caught.
  const namedIds = new Set([autoApproved, analystReview, escalation]);
  log("Re-listing groups to find non-named groups for deletion...");
  const allGroups = await listGroups(boardId);
  const toDelete = allGroups.filter((g) => !namedIds.has(g.id));
  log(`Deleting ${toDelete.length} non-named group(s): ${toDelete.map((g) => `${g.title}(${g.id})`).join(", ") || "(none)"}`);
  for (const group of toDelete) {
    await deleteGroupSafe(boardId, group.id);
  }

  // Checkpoint the board + groups state before running the column chain,
  // so a mid-chain failure leaves a resumable on-disk config (matches the
  // existing-board path's precondition: the chain always starts from an
  // already-persisted PartialBoardConfig on disk).
  const fresh: PartialBoardConfig = {
    boardId,
    groups: { autoApproved, analystReview, escalation },
  };
  writeConfig(fresh);

  log("Running column-creation chain on fresh board...");
  return await populateColumns(fresh);
}
