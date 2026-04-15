# FDE Lessons — Regulated Industry Deployments

## How to use this document

Audience: Forward Deployed Engineers starting a new engagement,
and AI tools assisting them. Each principle is self-contained
and can be retrieved as a standalone unit.

Principles are written as: trigger condition, principle statement,
rationale, worked example, resolution pattern. Search for a
trigger or principle keyword to find the relevant section.

The document has two parts. Part 1 covers technical and
integration lessons — the engineering disciplines for building
the deployment. Part 2 covers strategic and diagnostic lessons —
the analytical disciplines for understanding what to build and
why. Both parts are drawn from a single engagement; in practice
the two kinds of work happen concurrently and inform each other.

Source engagement: Crestview Capital Group, AI-powered client
onboarding workflow, monday.com + custom TypeScript pipeline,
FATF/FinCEN/BSA compliance frameworks. Six-week-equivalent build.
Build artifacts: github.com/dixob/crestview-fde-poc (CLAUDE.md,
monday_lessons.md, handoff.md, risk-framework.md, methodology.md,
business_case.md, diagnosis_layers.md, session logs).

---

# Part 1 — Technical and integration lessons

## Principle: Two contracts at every seam

**When this applies:** Any integration where data moves from one
schema-defined system to another (pipeline → database, model
output → UI surface, API → downstream consumer).

**Principle:** Validate that the upstream output schema and the
downstream consumer schema agree on field shape, allowed values,
and constraints. Do this at integration time, not at design time.
Both layers being internally consistent is not sufficient — the
seam is where bugs hide.

**Why this matters:** Schemas designed in isolation tend to be
optimized for their own layer's concerns (model-friendliness,
storage efficiency, UI rendering) rather than for the contract
between layers. Free-text fields in an upstream schema will be
inherited by any downstream consumer that doesn't impose
structure, and the gap only surfaces when real data hits the
seam.

**Example (Crestview):** The pipeline's `RiskAssessmentSchema`
typed `recommended_action` and `regulatory_flags` as
`z.array(z.string())` — unconstrained free text. The board's
columns for these fields were designed as enums (a four-label
status column and a six-label dropdown). The pipeline produced
prose; the board expected labels. Both fields hit the gap, both
required reframing the consumer surface to match the producer's
shape rather than translating between them. The first gap
surfaced during the writer wire-in (one application's worth of
data); the second surfaced only at full publish (15 applications),
because the writer probe had only tested one record.

**Resolution pattern:** When a gap is found, prefer reframing the
consumer surface over imposing translation logic at the seam.
Translation layers are fragile and hide the producer's actual
output. Reframing makes the architecture honest. **Cross-check
producer schema against consumer schema at the start of
integration, and dry-run the integration against the full dataset
before live writes — not just one record.**

---

## Principle: Probe-first against rich APIs

**When this applies:** Any integration with a third-party API
where payload shapes are non-trivial — anything with nested
objects, type-specific defaults, or settings that round-trip
through the API.

**Principle:** Before wiring an API call into application code,
write a disposable probe script that exercises the exact payload
shape, logs request and response side-by-side, and verifies
round-trip behavior. Delete the probe after wire-in.

**Why this matters:** API documentation is unreliable for any
sufficiently rich surface. Silent substitution is a common
failure mode — an API will accept a malformed payload and
substitute a default rather than reject. The wire-in code looks
correct, the response looks correct, but the system behavior is
wrong.

**Example (Crestview):** The monday API's generic `create_column`
mutation silently dropped `labels_colors` fields when called with
a JSON-scalar `defaults` argument, substituting its default
palette. The typed `create_status_column` mutation honored the
same fields because it accepted them through a typed
`CreateStatusColumnSettingsInput` schema. The same pattern held
for `create_dropdown_column`. A 15-minute probe would have
surfaced this; the absence of one cost approximately 90 minutes
of debugging.

**Resolution pattern:** Probe scripts live at
`src/scripts/probe-*.ts` (or equivalent), are deleted after
wire-in is verified, and their findings are captured in a
project-local lessons file (e.g. `monday_lessons.md`) for future
reference.

---

## Principle: Stop on surprise

**When this applies:** Any moment during a build where the system
behaves unexpectedly — a probe returns something you didn't send,
a test surfaces an edge case, a wire-in reveals a contract gap.

**Principle:** Stop immediately. Report the full request and
response. Do not guess at fixes. Wait for a deliberate decision
before continuing.

**Why this matters:** Guessing at fixes after a surprise compounds
the original issue with new uncertainty. Each subsequent guess
adds debugging surface area. The surprise itself is information
about a gap in your model of the system; resolving it deliberately
is cheaper than papering over it.

**Example (Crestview):** During the publish script's first run, 7
of 15 applications failed validation against the regulatory flags
enum set. The script was designed with continue-on-error
semantics, so it completed and reported partial success. The
correct response was to stop, report, and reframe — not to add
keyword-mapping logic to make the failures pass. The reframe
took an hour; a keyword-mapping patch would have introduced
silent miscategorization risk indefinitely.

**Resolution pattern:** Build "stop on surprise" into the
operational contract with collaborators (human and AI) at the
start of an engagement. Make it explicit that surprises are
information, not obstacles.

---

## Principle: Match the column to the data, not the design intent

**When this applies:** When the model output shape doesn't match
the consumer surface designed for it — particularly when prose
output meets enum surfaces.

**Principle:** When the upstream system produces natural language,
the downstream surface should hold natural language. Don't impose
an enum on free text by inserting a translation layer. Either
change the surface to match the data, or reframe the surface as
serving a different purpose (e.g. analyst tagging) that an enum
fits.

**Why this matters:** Translation layers between prose and enums
are fragile in both directions. Prose-to-enum keyword matching
breaks on phrase drift; enum-to-prose expansion loses the
specificity of the original output. Either direction creates a
maintenance burden that compounds as the producer's output
evolves.

**Example (Crestview):** The Recommended action and Regulatory
flags columns on the monday board were designed as enums
(four-label status, six-label dropdown). The pipeline produced
prose. Resolution: both columns reframed as analyst tagging
surfaces (workflow columns the analyst fills in post-review),
and the model's prose output landed in the existing Risk factors
long_text column alongside reasoning. Two columns went from
"broken model output mirrors" to "intentional human workflow
surfaces."

**Resolution pattern:** When the gap is found, choose between (a)
changing the column type to match the data, (b) reframing the
column as serving a workflow purpose distinct from the model
output, or (c) splitting one column into two for the two
purposes. Avoid (d) translation layers.

---

## Principle: Three-layer integration architecture

**When this applies:** Any deployment that connects an upstream
data producer (pipeline, ETL, model) to a downstream display or
workflow surface via an external platform.

**Principle:** Structure the integration as three independent
layers connected by clear contract boundaries: an idempotent
bootstrap that establishes the destination schema, a contract
boundary (typically a file or API) that decouples producer from
publisher, and a publisher that orchestrates writes from
contract to destination.

**Why this matters:** Independence at each layer means each can
be tested, debugged, and replaced separately. Idempotent
bootstrap means re-runs are safe. The contract boundary means
the producer doesn't need to know about the destination, and
the publisher doesn't need to know about the producer's
internals.

**Example (Crestview):** The integration was `bootstrap.ts`
(idempotent monday board provisioner) → `output/final-15.json`
(contract boundary, JSON output of the pipeline) → `publish.ts`
(orchestrator that reads JSON, calls router and writer per
application). The pipeline did not know monday existed. The
publisher did not know about the pipeline's internals. Adding a
new destination (database, Salesforce, etc.) would mean adding
a second publisher reading the same JSON, with no changes to
either bootstrap or pipeline.

**Resolution pattern:** When designing a new integration, name
the three layers explicitly on day one. Identify the contract
boundary file or API. Build the bootstrap to be idempotent from
the first commit, not as a refactor.

---

## Principle: Decision logs as deliverables

**When this applies:** Any non-obvious technical or design
decision made during a build — choosing between alternatives,
reframing a component, deferring a fix, accepting a trade-off.

**Principle:** Capture the decision, the alternatives considered,
the rationale, and a Q&A-ready framing in a project-local
decision log at the moment of the decision. Treat the log as a
deliverable, not as an internal artifact.

**Why this matters:** Decisions reconstructed after the fact lose
the alternatives that were considered and rejected. Without the
rejected alternatives, the decision reads as the only obvious
path, which is both inaccurate and weaker as a defensible story.
Decisions captured at the moment also build a record that future
engineers (and AI tools) can search and apply, and they become
panel-ready Q&A material without rehearsal effort. Decisions
reconstructed after the fact never quite do — the in-the-moment
texture is what makes them defensible.

**Example (Crestview):** The Recommended action column reframe
and the Regulatory flags column reframe were both captured in
`CLAUDE.md` at the moment of decision, with alternatives listed
and rejected with reasons. By the time of the panel, both
decisions had Q&A-ready framings in 90 seconds or less, and the
two-instance pattern was visible as a class of issue rather than
two unrelated patches.

**Resolution pattern:** Every project gets a decision log file
(e.g. `decision_log.md` or a section in `CLAUDE.md`). Entries
follow a consistent format: situation, alternatives considered,
decision, rationale, Q&A framing.

---

# Part 2 — Strategic and diagnostic lessons

## Principle: FDE-as-labeler is the wrong frame

**When this applies:** Any moment during an engagement when the
FDE is tempted to substitute their own first-pass interpretation
of the customer's domain for the customer's actual domain
expertise — typically when building eval sets, validation logic,
or reference frameworks for a regulated or specialized field.

**Principle:** An FDE is not a domain expert in the customer's
field. Producing labels, judgments, or compliance assessments
"as if" they were creates the appearance of authority where none
exists. The senior move is to name the gap honestly and build
the system that channels the customer's actual expertise rather
than simulating it.

**Why this matters:** A model scored against an FDE's labels is
measuring agreement with an FDE's first-pass interpretation, not
agreement with the standard the customer's team actually applies.
That is worse than no eval — it is an eval that cannot detect
the failure modes that matter, dressed up as rigor. Customers in
regulated domains will recognize the substitution and trust the
engagement less, not more.

**Example (Crestview):** The instinct on a compliance-focused
build is to label the 15 sample applications with expected risk
tiers and score the model against those labels. Resisting that
instinct, the methodology document instead specified three
sources of real ground truth: historical compliance dispositions
extracted from the customer's existing case files, calibration
sessions with two or three senior analysts on twenty
representative cases (with disagreement transcripts as the
highest-value artifact), and override capture in shadow mode
once the system is live. The FDE's job is to build the system
that captures and operationalizes that expertise — not to
substitute their own.

**Resolution pattern:** When you find yourself building an
authority-shaped artifact in a domain you don't have authority
in, stop. Identify the customer-side person whose authority
actually applies. Build the system that channels their judgment
into structured form (historical extraction, calibration
sessions, shadow-mode override capture) rather than the system
that simulates it.

---

## Principle: Structural defensibility is separate from substantive accuracy

**When this applies:** Building a system whose output requires
domain expertise the FDE doesn't have, but where the FDE can
still meaningfully shape the output's shape and properties.

**Principle:** A regulated-domain output has two independent
quality dimensions: substantive accuracy (does the answer reflect
correct domain judgment?) and structural defensibility (does the
output have the properties a domain expert would need to evaluate,
audit, and sign off on it?). The FDE can confidently judge and
build for the second even when the first requires customer
expertise.

**Why this matters:** Structural defensibility is an engineering
property — a function of output shape, traceability, and
explicit reasoning. A compliance officer can accept or reject a
specific risk tier even if they wouldn't have produced it
themselves; what they can't accept is an output where they can't
see the reasoning, can't audit the framework, or can't trace the
factors that produced the verdict. Building for structural
defensibility is what makes the system usable while substantive
calibration develops over time.

**Example (Crestview):** The risk assessment prompt was designed
against properties the FDE could verify: the output enumerates
observed factors before rendering a verdict; each factor is
mapped to a regulatory framework with citations; severity is
assigned per factor; missing information is named explicitly
rather than assumed; human review is triggered by explicit
criteria; SAR consideration is a first-class field; the risk
tier is derived from the factors, not rendered independently.
These are properties verifiable by reading the output. They make
the system defensible to a compliance officer regardless of
whether any specific tier is correct in any specific case —
which is the right order of operations, because tier accuracy
gets calibrated against analyst overrides over time, while
structural defensibility has to exist on day one.

**Resolution pattern:** When designing the output shape for a
regulated-domain system, list the structural properties a domain
expert would need before they could evaluate any specific output.
Build for those properties first. Substantive accuracy is what
calibration solves; structural defensibility is what engineering
solves.

---

## Principle: Build frameworks from primary sources, not from model training data

**When this applies:** Any deployment that requires the model to
reason against a regulatory, scientific, or otherwise specialized
framework — anywhere the model's output needs to be defensible
to a domain expert with citations.

**Principle:** When a model needs to apply a framework, extract
that framework from primary sources in a separate research-mode
session, with specific citations, and spot-check the citations
against the actual source text before using them in the
production prompt. Do not ask the model to generate the
framework from its training data.

**Why this matters:** A model asked to generate its own
framework and then apply it is doing circular reasoning that
cannot be defended. The framework will look authoritative — the
model is good at producing authoritative-sounding text — but a
domain expert will spot the missing citations, the conflated
sources, and the subtly wrong rule statements. Primary-source
extraction with verified citations produces a framework that
holds up to expert scrutiny, and the citations themselves
become the audit trail for every output the model produces
against the framework.

**Example (Crestview):** The risk assessment prompt was grounded
in extracted primary sources: 31 CFR 1010.230 for CDD, 31 CFR
1023.320 for SAR consideration, FATF Recommendation 12 for PEP
handling, FATF *Concealment of Beneficial Ownership* (July 2018)
for nominee director patterns, FFIEC Manual Appendix F for
shell company indicators. Each citation was spot-checked against
the actual regulatory text before inclusion. A compliance
reviewer reading the model's output can trace every regulatory
claim to a specific rule. The framework document
(`risk-framework.md`) was a separate artifact built before any
prompt iteration began, and it stands as a deliverable in its
own right.

**Resolution pattern:** Run framework extraction as a separate
session from prompt design. Capture the framework in a versioned
artifact with full citations. Spot-check at least 20% of
citations against source text. Reference the framework artifact
from the production prompt rather than re-deriving it inline.

---

## Principle: Diagnose in three layers — symptoms, mechanisms, inversion

**When this applies:** Any operational diagnosis where a customer
is asking for a faster version of their current process, or where
prior automation attempts have failed.

**Principle:** Operational problems have three layers, and the
diagnosis has to reach all three. Layer 1 is what's measurably
broken (symptoms). Layer 2 is the structural facts about the
process that produce the symptoms (mechanisms). Layer 3 is what
changed in the world that makes the architecture wrong now (the
inversion thesis). Diagnoses that stop at layer 1 produce faster
versions of the broken process. Diagnoses that reach layer 3
produce the redesign the customer actually needs.

**Why this matters:** Customer requests are typically framed at
layer 1 ("our onboarding takes 23 days, get it to 5"). Solutions
that respond only to layer 1 fail because they preserve the
mechanisms that produced the symptoms (RPA failed because it
automated the copy-paste between systems without fixing the fact
that there was no shared state). Solutions that reach layer 2
recognize the multi-mechanism interaction (you cannot fix one
without addressing the others). Solutions that reach layer 3
explain *why* the current architecture exists — typically because
it was correct for resource constraints that no longer hold —
which is what gives the customer permission to redesign rather
than patch.

**Example (Crestview):** Layer 1 — five symptoms on the dashboard
(cycle time, backlog, NPS, abandonment, revenue at risk), all
downstream of the same root. Layer 2 — three interlocking
mechanisms (every system handoff is a human copy-paste; compliance
review is a sequential blocker not a parallel workstream;
judgment workers are being used as data handlers) that multiply
rather than add. Layer 3 — the inversion: the process was
designed correctly for a 2020 resource model where compliance
judgment was scarce and ops time was cheap; in 2026 first-pass
compliance analysis is automatable and judgment-worker attention
is the scarce resource. Same architecture, opposite resource
model, opposite optimization. The previous RPA failure becomes
explicable in retrospect — it was correct execution of the wrong
design.

**Resolution pattern:** When taking on a diagnosis, build all
three layers as separate artifacts before designing solutions.
Layer 1 from the customer's existing measurement. Layer 2 from
process observation and stakeholder interviews — pay attention to
how the mechanisms interact, not just to each one alone. Layer 3
from research into how the customer's industry has changed in
the last 3-5 years and what comparable firms are doing differently.

---

## Principle: Quantify business value as the premium on existing payroll

**When this applies:** Building the business case for an
operational transformation, especially when the customer's
existing dashboards measure outputs but not the cost of producing
those outputs.

**Principle:** The strongest business case is often not future
revenue — it is the premium the customer is currently paying on
their existing payroll for work that doesn't require the salary
they're paying. This frame requires no projection; it's just
"existing payroll, multiplied by the share of work that doesn't
need that payroll." It puts the burden of proof on inaction
rather than on action.

**Why this matters:** Future-revenue business cases are easy to
discount — projections are projections, the customer can argue
with any number. Existing-payroll-premium business cases are
harder to discount because the customer is already paying the
cost. The question shifts from "will this generate value?" to
"do you want to keep paying this cost?" That's a different
conversation, and it usually goes faster.

**Example (Crestview):** Operations team spends ~70% of time on
data handling. Crestview hired and pays operations and RM staff
for their judgment. The firm is therefore paying a 70% premium
on its operations headcount for output it could get without that
headcount. The cost is invisible because it shows up as payroll
rather than as a line item, but it is real and it compounds with
every onboarding case. The lagging indicator is even harder to
ignore: two senior RMs left in the last quarter citing
administrative burden, which means Crestview has crossed the
threshold where the premium is now driving away the people the
firm most needs. The business case writes itself: the cost of
the engagement is bounded and known; the cost of the status quo
is unbounded and ongoing.

**Resolution pattern:** Find the metric the customer's
stakeholders name in conversation but don't measure on the
dashboard. That metric is usually the one that quantifies the
premium. Build the case around it. Express the engagement's
ROI as "stop paying the premium" rather than as "generate new
revenue."

---

## Principle: The asymmetry close

**When this applies:** Closing a strategic proposal where the
customer is weighing whether to commit to the engagement vs.
defer or do nothing.

**Principle:** Frame the buy decision as the asymmetry between
a bounded reversible cost (the engagement) and an unbounded
irreversible cost (the status quo). The cost of the engagement
is defined and time-limited; the cost of the status quo is
ongoing and compounds with every quarter the customer waits.
The case for acting now is not that the upside is enormous —
it is that the downside of waiting is the upside of competitors
who are not waiting.

**Why this matters:** Customers tend to evaluate proposals
against an implicit baseline of "do nothing," which carries no
visible cost in the proposal itself. Naming the asymmetry makes
the do-nothing baseline visible as a real, ongoing cost. It
also reframes the risk calculation: if the engagement fails,
the customer is in the same position they're in today minus
the engagement cost; if the status quo continues, the customer
is in a worse position six months from now and the cost of
catching up has grown.

**Example (Crestview):** Six-month FDE engagement cost is
bounded and known. Status quo cost is ongoing: every quarter,
more clients abandon (18% rate vs. 5% benchmark), more
mandates go to faster competitors (one $200M mandate already
lost), more senior people leave (two RMs already departed),
and the gap between Crestview and firms that have already made
this transition gets harder to close. At least one direct
competitor is already at five-day onboarding under the same
regulatory framework. The proof of feasibility is not a vendor
pitch — it is a competitor who already exists and is already
winning the customer's business with this capability.

**Resolution pattern:** End the strategic proposal with the
asymmetry frame. Quantify the engagement cost. Quantify or
narratively describe the ongoing status-quo cost. Name a
specific external proof point (a competitor, a peer firm, a
public benchmark) that establishes the transition is achievable.
Let the asymmetry close itself.

---

# Anti-patterns

**Don't add scope under deadline pressure.** When a build session
is running long and a "small addition" presents itself, the
default answer is no. The pattern of "this won't take long" is
nearly always wrong about how long it will take, and additions
near deadlines compound risk because there is no margin to
recover from surprises.

**Don't translate between prose and enums.** Both directions are
fragile. Reframe the surface instead.

**Don't parallelize when sequential is fast enough.** For batch
sizes under ~50 items where each operation is bounded,
sequential processing with clear logging is more debuggable and
demonstrable than parallelized execution. The performance
difference is not worth the loss of trace clarity.

**Don't build update paths when delete-and-recreate is simpler.**
For idempotent bootstrap flows, recreating mismatched resources
is simpler and more transparent than building update paths that
diff existing state. Update paths are often justified for
production but premature for a POC.

**Don't trust API documentation as authoritative.** Probe-first
applies. Documentation is a starting hypothesis, not ground
truth.

**Don't substitute FDE judgment for customer domain expertise.**
This is the strategic equivalent of the technical anti-patterns
above. Building an FDE-labeled eval set, an FDE-defined risk
framework, or an FDE-rendered compliance verdict creates the
appearance of rigor while hiding the absence of authority.

**Don't measure outputs without measuring the cost of producing
them.** Customer dashboards typically measure outputs (cycle
time, backlog, abandonment) without measuring the cost the
customer is paying to produce those outputs (judgment-worker
hours on clerical work). The unmeasured cost is usually where
the business case lives.

---

# Starting practices for engagement N+1

**Day 1:** Set up `decision_log.md`, `lessons.md`, and a
project-local `CLAUDE.md` (or equivalent AI handoff file) before
writing any code. These are infrastructure, not documentation.
Identify the customer-side domain expert whose authority any
regulated outputs will eventually be evaluated against — this is
who the system is being built to channel, not to replace.

**Week 1:** Three artifacts before any code: a layered diagnosis
(symptoms, mechanisms, inversion thesis); a primary-source
framework extraction for any regulated reasoning the system will
do; an evaluation methodology that names where ground truth comes
from and explicitly rejects FDE-as-labeler shortcuts.

**Before any new API integration:** Write a probe script that
exercises the rough payload shape. Read the response. Capture
findings in `lessons.md`. Then wire.

**At every integration boundary:** Cross-check producer schema
against consumer schema. Don't assume; verify. The check takes
five minutes and prevents a class of failure. Dry-run the
integration against the full dataset, not just one record,
before live writes.

**At every "I'll just add one more thing" moment near a
deadline:** Stop. Name it as the pattern. Default to no. If yes,
explicitly time-box.

**Before every panel or executive presentation:** Rehearse out
loud. The skills are performance skills, not analytical skills.
They require different practice than the build itself.

---

*Source engagement: Crestview Capital Group FDE engagement,
April 2026. Build artifacts: github.com/dixob/crestview-fde-poc.
Companion files in the source repo: CLAUDE.md (phase status and
decision log), monday_lessons.md (monday API empirical findings),
handoff.md (engagement context and panel preparation),
risk-framework.md (FATF/FinCEN/BSA primary-source extraction),
methodology.md (evaluation approach), business_case.md (ROI
framing), diagnosis_layers.md (three-layer diagnosis worked
example).*