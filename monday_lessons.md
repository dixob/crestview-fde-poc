Firsthand monday API lessons (phase 1 + 2.1 + 2.2 + 2.3 + 2.4)
The one that bit me
delete_group refuses to delete the last remaining group on a board. GraphQL returns DeleteLastGroupException (HTTP 409). Means the obvious "delete defaults → create named" ordering doesn't work; you must create first, then delete. Lesson: monday has board-level invariants ("must have ≥1 group") that constrain operation ordering, and they're not documented prominently — you find them by trying.

Default behaviors to expect
Fresh boards auto-create a default group titled "Group Title", id topics. Always present. I didn't find a create_board flag to suppress it.
create_group with no positional args prepends to the top. Creating A → B → C yields visual order C, B, A. Caught me on the first run.
Positional args that work
create_group(..., relative_to: $groupId, position_relative_method: before_at | after_at) gives deterministic ordering. The pattern I landed on: anchor the first named group before_at the default group (so it lands at the top), then chain the rest with after_at the previous named group.
Enum values (before_at, after_at, public for BoardKind) pass as plain strings in GraphQL variables. No quoting gymnastics needed.
Schema type inconsistencies — don't assume ID! everywhere
Mutations I've actually called:

boards(ids: [ID!]) — ID
create_board(..., workspace_id: ID) — nullable ID
create_group(board_id: ID!, group_name: String!, relative_to: String, position_relative_method: PositionRelative) — note relative_to is String, not ID
delete_group(board_id: ID!, group_id: String!) — group_id is String!
delete_board(board_id: ID!) — ID!
Group IDs are typed as String in most contexts even though boards use ID. Easy to get wrong; produces InputValidationError if you do.

Auth quirks worth flagging
Authorization: <raw_token> — no Bearer prefix. Unusual enough that I second-guessed it before sending.
API-Version: 2026-04 header required on every request.
Error shape is actually good
The DeleteLastGroupException response:

{"errors": [{
  "message": "Cannot delete last group - board has to have at least one group",
  "path": ["delete_group"],
  "extensions": {
    "code": "DeleteLastGroupException",
    "status_code": 409,
    "error_data": {},
    "service": "monolith"
  }
}]}
Machine-matchable via extensions.code, human-readable via message. If future errors are this well-structured, programmatic handling (retry vs. surface vs. repair) will be straightforward.

Idempotency — cheap and reliable at the board level
The pattern board.config.json on disk + a single boards(ids: [$id]) { state } query works. One API call per rerun; avoids recreating boards. States observed so far: only "active" (haven't hit "archived" or "deleted" firsthand). But — this ONLY detects board-level drift. Group/column edits via the UI are invisible to this check.

delete_board is a genuine clean slate
After delete_board, the follow-up bootstrap ran against a truly empty state — no leftover columns, groups, or references. No soft-delete / trash-can behavior I had to work around. Good for iterative development against a real workspace.

Group IDs look like group_mm2d4amf
Short alphanumeric strings, auto-assigned, not predictable. You must capture them from the creation response; there's no "pass your own ID" escape hatch.

Status columns — there are TWO different creation mutations and they behave differently
This was the biggest time-sink in phase 2.3. Status columns can be created via:

create_column(column_type: status, defaults: JSON) — the generic one. Takes JSON as a scalar. Silently drops per-label color data no matter what shape you send. I tried:
  - The legacy output shape `{labels: {"0": "NAME"}, labels_colors: {"0": {color, border, var_name}}}` → monday accepted labels, discarded labels_colors, substituted its own palette.
  - The managed shape `{settings: {labels: [{label, color, index}]}}` that get_column_type_schema(type: status) returns → monday accepted nothing, fell back to a template with "Working on it / Done / Stuck" as labels.
  The mutation returns successfully in both cases. No GraphQL error. The only signal you did something wrong is settings_str coming back "normal-looking" but different from what you sent.

create_status_column(board_id: ID!, title: String!, defaults: CreateStatusColumnSettingsInput!) — the typed one. Board-level mutation whose defaults argument is a strongly-typed GraphQL input, NOT a JSON scalar. Shape: `{labels: [{label, color, index}, ...]}`. Colors applied per-label, round-trips correctly in settings_str. THIS is the one you want for custom palettes.

Lesson: when a monday mutation that takes JSON silently ignores your payload, check introspection for a sibling mutation with a typed input. The JSON scalar path often exists for backward compat with the simple case and won't honor the richer shape.

Introspection snippet I used to find it:
  { __schema { mutationType { fields { name args { name type { name kind ofType { name kind } } } } } } }
Then filter for names matching /status/i. Also: __type(name: "CreateStatusColumnSettingsInput") { inputFields { name type { name kind ofType { name kind } } } } to confirm the shape.

Color enum names don't round-trip — monday normalizes them, and the mapping is arbitrary
When you send `color: "done_green"` to create_status_column, settings_str.labels_colors[...].var_name comes back as "green-shadow". Not "done_green", not "done-green", not any simple transformation — a totally different name. Six mappings I confirmed by probing:

  done_green     → green-shadow   (#00c875)
  egg_yolk       → yellow         (#ffcb00)
  sunset         → sunset         (#ff7575)
  dark_red       → dark-red       (#bb3354)
  american_gray  → trolley-grey   (#757575)
  stuck_red      → red-shadow     (#df2f4a)

So any "does this column already have the palette I want?" check needs an explicit enum→var_name lookup table populated by probing. You cannot derive it. I keep the map in code next to the enum type and throw on missing entries — a new color in a spec must be probed before it ships.

Status column label IDs are color-dependent, not sequential
In settings_str, `labels` is keyed by numeric ID: `{"1":"ALPHA","9":"BETA","11":"DELTA","101":"GAMMA"}`. Those IDs come from monday's StatusColumnColors numeric space — they depend on WHICH color you picked for each label, not on submission order. Sending (green, yellow, sunset, dark_red) produces IDs (1, 9, 101, 11). Re-pick the colors and the IDs change.

Two consequences:
  - `labels[i] = name` is a lookup by internal color ID, not "label index N in display order". Display order lives in labels_positions_v2.
  - The numeric ID is what you pass as `{"index": N}` when writing a column value from the API. So the board writer has to persist the name→ID map in board.config.json; it can't assume LOW=0, MEDIUM=1, etc.

Mutations silently substituting a default when input is wrong is the monday-specific failure mode to watch for
Across three separate attempts with wrong defaults shapes, the mutation returned HTTP 200, returned a column id, returned a plausible settings_str — and just quietly ignored the parts it didn't understand, filling in a default palette or a fallback label set. No error, no warning, no partial success flag. So any code that creates a status or dropdown column needs a round-trip assertion: parse settings_str and verify it matches what you sent. Added hasDesiredPalette() which fails loudly with the full settings_str in the error so you can see what came back. This is different from the group case (DeleteLastGroupException, well-structured error). Creation mutations aren't as well-behaved.

You can't recolor an existing status column via create_column — you must delete + recreate
monday has no update_column_defaults or similar mutation for status labels/colors. Editing in the UI is possible; editing via API requires delete_column followed by a fresh create_status_column. Loses the column ID, so anything that caches column IDs across phases must re-read them from board.config.json after a re-bootstrap.

Column creation append-order leaves visual ordering on the table — and there is NO column reorder mutation
create_column, create_status_column, and create_dropdown_column all append to the right edge of the board by default. All three DO accept an optional `after_column_id: ID` argument that positions a NEW column immediately right of the specified existing column — I missed this on first pass in phase 1 and only noticed it in the step 2.4 introspection. But that only helps at creation time.

What there is NOT, confirmed via a 2.4-followup introspection: a mutation to reorder EXISTING columns. I filtered mutationType.fields against every plausible pattern:
  /move.*column/i         → only remove_required_column (unrelated)
  /reorder.*column/i      → 0 hits
  /column.*position/i     → 0 hits
  /column.*order/i        → 0 hits
  /layout/i               → 0 hits
  /change_column_metadata/i → exists, but ColumnProperty enum is {description, title} only — no position
  /update_column/i        → exists, edits title/description/width/settings, NOT position

So: if a board needs a specific left-to-right column order, get it right at creation time via `after_column_id`, or drag columns manually in the UI, or destroy the mis-ordered columns and recreate. There is no API path to move an existing column. Mixing create + delete + recreate cycles (as the status palette-fix path does) inevitably produces an order that doesn't match the original plan, and cannot be fixed without recreating the moved columns.

Idempotency for columns — title is the natural key
board.config.json holds IDs, but on a re-run they might be stale (UI deletion, or delete+recreate like the palette-fix path). The pattern that works: list all columns on the board and build a Map by title. If a column with the expected title exists, reuse its ID (after type + shape verification). If not, create. For status columns, the "shape verification" step is where hasDesiredPalette earns its keep — a column with the right title but wrong palette must be deleted and recreated.

Dropdown columns — the typed-mutation pattern repeats, but the shape is simpler
Like status, dropdowns expose BOTH a generic create_column(column_type: dropdown, defaults: JSON) path and a typed create_dropdown_column(board_id, title, defaults: CreateDropdownColumnSettingsInput) path. The 2.3 lesson generalized cleanly: use the typed one, check round-trip against settings_str, don't trust "no error" as proof of success.

Three ways dropdowns differ from status, all worth knowing:

1. CreateDropdownLabelInput has only one field: `label: String!`. No color, no index, no description, no is_done. The input type is so narrow that the class of "wrong payload shape" errors that bit status three times simply doesn't exist here — you can't send a wrong shape when there's only one field to send. Probe round-tripped cleanly on the first attempt.

2. settings_str.labels comes back as an ARRAY of {id, name} objects, NOT the id-keyed object status uses. Status returns `{"1": "LOW", "9": "MEDIUM"}`; dropdown returns `[{"id": 1, "name": "FATF_R10"}, ...]`. So any shape-check helper has to branch on Array.isArray vs. typeof "object" — don't reuse a status parser directly.

3. Dropdown label IDs are sequential 1..N matching submission order. Not color-dependent (there's no color input), not sparse. Sending six labels produces IDs 1, 2, 3, 4, 5, 6 in submission order. Stable across re-reads of the same column. If your writer wants them as-name you don't need to capture the IDs at all; if you want them as-index they're just 1-indexed positions. Much simpler than status's color-dependent numeric space.

One surprise field on dropdown settings_str: `deactivated_labels: []`. Present on a freshly-created column, empty. If it ever comes back non-empty, monday considers some labels disabled (presumably via the UI's "deactivate" menu) and they won't accept writes. Shape-check helpers should subtract deactivated labels from the "present" set before comparing to the expected set — a deactivated label is effectively absent for write purposes.

update_dropdown_column exists; update_column for status does not
Dropdowns have a board-level update mutation: update_dropdown_column(board_id, id, title?, settings?, revision!). Takes a revision token (string) — presumably optimistic-concurrency. Haven't used it. Status columns have no such mutation, so 2.3 was forced into delete-and-recreate on label/color drift. For dropdowns you'd have the option, but if your idempotency pattern is "reuse on shape match, else delete-and-recreate" (i.e. the 2.3 shape), adding an update path doubles the branching surface. Kept the delete-and-recreate pattern for dropdowns to match 2.3 symmetrically.

Schema introspection technique: filter mutationType.fields by /create.*column/i
For step 2.4's schema check, the mutationType.fields intersection of /create/i and /column/i returned exactly the five mutations that matter: create_column, create_status_column, create_dropdown_column, create_status_managed_column, create_dropdown_managed_column. That filter is the canonical way to find typed variants for a given column type. Also worth checking /type_name/i for the input-type side (CreateDropdownColumnSettingsInput, CreateDropdownLabelInput).

Phase 3 probe — column_values payloads for create_item
All the phase-2 lessons about silent substitution on CREATION do NOT carry over to column VALUE writes. Ran src/scripts/probe-column-values.ts (two probe items in Analyst review, round-tripped via items query, cleaned up via delete_item). No silent substitutions observed on value writes — every payload that went in came back identically in the create_item response and the follow-up items query. Both status forms ({label} and {index}) round-trip cleanly. So the defensive round-trip assertion pattern needed for status column CREATION (hasDesiredPalette) is NOT needed for item value writes.

Shapes that work, confirmed empirically:
  text              → raw string, e.g. "APP-2026-0301". No wrapper. value=same string, text=same string.
  numbers           → JS number (0.87) OR stringified ("0.87") — both round-trip identically as "0.87" in both text and value. Prefer number form for TypeScript ergonomics.
  date (day-only)   → {date: "YYYY-MM-DD"}. text="2026-04-14", value={"date":"2026-04-14"}.
  date (with time)  → {date: "YYYY-MM-DD", time: "HH:MM:SS"}. ROUND-TRIP WORKS but there is a timezone-conversion trap in the `text` display: sent time="12:34:56" (UTC), text came back "2026-04-14 08:34" (local-converted, 4h offset suggests east-coast workspace timezone). The `value` field preserves what was sent. Lesson: for a processing-timestamp audit field, use day-precision only — avoids the conversion surprise.
  long_text         → {text: "..."}. Newlines preserved. No rich-content wrapper needed for plain markdown-ish content.
  status (by name)  → {label: "LOW"}. Monday resolves name → color-coupled numeric ID server-side; the response shows text="LOW" and value={"index":1}. Doesn't require the caller to know the numeric ID map.
  status (by index) → {index: 101}. Direct. Response text="HIGH" (monday resolves index → name for display) and value={"index":101}. Also works, no substitution. Useful if you want to write by the numeric IDs in board.config.json.
  dropdown (multi)  → {labels: ["FATF_R10","OFAC"]}. Response text="FATF_R10, OFAC" and value={"ids":[1,5],"override_all_ids":"true"}. The override_all_ids="true" is monday auto-setting; for create_item it's irrelevant (there are no existing labels to override).
  dropdown (single) → {labels: ["BSA"]}. Same shape works for N=1 and N>1.

Status value writes: by-label vs by-index — both work, pick one for convention
The probe tested both forms. Both returned HTTP 200, both round-tripped identically. By-label ({label: "NAME"}) is the simpler choice because:
  - The writer doesn't need to look up numeric IDs from board.config.json
  - It's resilient to the status-palette-fix path (delete+recreate) which regenerates numeric IDs
  - It's semantically what the writer knows: the risk_assessment has risk_level as a string
By-index is still worth knowing as the escape hatch — if monday ever adds case sensitivity or multiple labels with the same name, the numeric ID in board.config.json is the unambiguous reference.

create_item returns column_values inline — no separate readback needed
The create_item mutation response can include { id, name, group { id title }, column_values { id type text value } } in the same call. For a writer that wants to verify what got stored without a round-trip query, selecting column_values on the create_item response is free. Used this in the probe and confirmed it returns what a follow-up items(ids:[$id]) query returns.

Dropdown value response shape surprise — {ids, override_all_ids}
Dropdown columns set by name come back in `value` as `{"ids":[1,5],"override_all_ids":"true"}` — an `ids` array (not `labels`) plus an `override_all_ids: "true"` flag. The `text` field is the human-readable comma-separated name list. If a shape-check helper wants to compare what-was-sent against what-came-back for dropdowns, parse `value.ids` and map them through the known labels list (from CreateDropdownColumnSettingsInput submission order — sequential 1..N, stable across reads). This is different from the phase-2.4 settings_str shape (which is {labels: [{id, name}, ...]}); settings_str describes the column's label catalog, value describes which labels are set on this item.

create_update as a narrative surface — works, but rejected in favor of long_text column
create_update(item_id, body) adds a markdown update to an item. Body round-trips cleanly in text_body (probe tested ~300-char body with headings, bullets, newlines — all preserved). Considered this for the onboarding-summary narrative surface but rejected: updates are a two-click surface (item detail → Updates tab) and are semantically a human collaboration channel, not a machine output channel. For a panel demo where one-click visibility in the row view matters, landing the narrative in a long_text column is the right call. Adding an 11th plain column (Onboarding summary, long_text) was cheaper than overloading updates. Left for future reference: create_update works, keep it in the toolkit for actual human-collaboration use cases.

Item name is freely settable via create_item.item_name
No constraints observed — em-dash, colons, spaces, numbers all accepted. Writer uses `${application_id} — ${client_name}` as the row header.

What I have NOT exercised firsthand (so no lessons yet)
update_dropdown_column (the revision-aware label-editing path) — exists, not used.
create_*_managed_column — workspace-level shared columns, not relevant to this project.
change_column_value / change_multiple_column_values — for updating items after creation. Only create_item path exercised so far.
Rate limits — haven't hit them, though the publish script (step 3) will do 15 consecutive create_item calls which is worth monitoring.

Phase 3 wire-in — pipeline contract vs. board contract, a gap that only surfaces at wire-in
During Phase 3 Step 2B, attempting to build the Recommended action column payload revealed that the pipeline's RiskAssessmentSchema types recommended_action as unconstrained z.string(), while the board's Recommended action status column was designed around four enum labels (AUTO_APPROVE, HUMAN_REVIEW, ESCALATE, REJECT). All 15 sample applications produced free-text strings that did not match any of the four labels ("Proceed with standard onboarding", "Escalate to Chief Compliance Officer — do not proceed", etc.).

The gap existed because the two layers were designed consistently within themselves but not consistently with each other. Neither layer had a bug. The bug was at the seam.

Lessons:
- Pipeline output schemas (Zod) and board column schemas (monday API) are two separate contracts. They need to be cross-checked, not just independently validated. A Zod schema is a guard against malformed pipeline output; it says nothing about downstream consumer expectations.
- Free-text fields in a Zod schema are a tell. Anywhere the schema is permissive, the wire-in layer downstream will either inherit the permissiveness or need to impose structure. That decision deserves to be explicit, not inherited by accident.
- The "stop on surprise, report, wait for ack" discipline caught this before any live API calls were made. The writer was fully built and typecheck-clean before the issue was discovered, but zero state had been written to the board. Cost of the pause: seconds. Cost of writing 15 broken rows to the live demo board: significantly more.
- In a real FDE engagement, this kind of gap is exactly what the first deployment reveals, and it is cheaper to find it in a probe / test-write than in production. The probe-first, stop-on-surprise discipline is not overhead — it is the mechanism that surfaces integration gaps early.
- Schema-to-schema gaps are resolved by picking which layer owns the contract. In this case, the pipeline owns the natural language (don't fight the model), and the board column was reframed to own a different concept (analyst workflow tagging) rather than being a mirror of the model output. The model's free-text recommendation rides along in the Risk factors long_text so the detail isn't lost.

Second instance — regulatory_flags
The same gap surfaced a second time on the live publish run in Step 3. Pipeline's RiskAssessmentSchema types regulatory_flags as z.array(z.string()); the Regulatory flags dropdown column was designed around six canonical labels (FATF_R10, FATF_R12, FinCEN_CDD, SAR_31CFR1023_320, OFAC, BSA); the pipeline produces prose phrases like "FinCEN CDD violation — 31 CFR 1010.230 — unable to identify and verify beneficial owners" and "FATF Recommendation 12 — PEP enhanced due diligence required". The writer's strict validateRegulatoryFlags guard (loud-fail by design against compliance-data loss) threw on 7 of 15 rows in the first publish run. Same resolution as Step 2B: reframe the Regulatory flags dropdown as an analyst workflow tagging surface, append the model's prose flags to the Risk factors long_text under a **Regulatory flags:** section.

The lesson sharpens from "it happens" to "it is a class of issue":
- Any unconstrained string field in the pipeline output schema (z.string(), z.array(z.string())) is a candidate for this gap. Anywhere the downstream consumer has stricter structure than the producer, you have a seam that might fail.
- Probe-first integration catches these — but only if you probe breadth-first across the full dataset, not against a single happy-path row. The Step 2 writer probe tested APP-2026-0302 alone, whose regulatory_flags happened to match the canonical set; 7 of the other 14 rows broke the assumption. Had the probe run against all 15 applications (or even the HIGH/CRITICAL subset), this would have been caught at probe time alongside Step 2B.
- When the same class of bug shows up twice, resolve it consistently. Having two different coping strategies for two instances of the same gap is worse than one consistent pattern, even if each individual instance might admit a slightly nicer ad-hoc fix. The "both columns are analyst workflow surfaces, prose rides along in Risk factors" pattern is predictable and documentable; a per-column mix of "this one keyword-matches, that one gets dropped, the other is reframed" would be a maintenance trap.

