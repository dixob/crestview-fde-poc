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

What I have NOT exercised firsthand (so no lessons yet)
update_dropdown_column (the revision-aware label-editing path) — exists, not used.
create_*_managed_column — workspace-level shared columns, not relevant to this project.
Anything phase 3 (item creation, value writing).
Rate limits — haven't hit them.

