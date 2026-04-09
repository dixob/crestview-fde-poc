# Crestview Capital Group — AI-Powered Client Intake POC

This is a proof-of-concept AI pipeline for Crestview Capital Group's client onboarding process, built as part of the monday.com Forward Deployed Engineer take-home assignment. The pipeline processes client applications through a two-stage LLM workflow — risk assessment against FATF, FinCEN CDD, and BSA/AML frameworks, followed by onboarding summary generation — and produces schema-validated structured output suitable for downstream consumption by monday.com or Crestview's existing compliance systems.

## What this POC does

The pipeline reads 15 sample client applications from a CSV and processes each through two sequential LLM stages. Stage 1 (risk-assess) evaluates the application against a regulatory framework drawn from primary sources — FATF Recommendations, FinCEN's CDD rule at 31 CFR 1010.230, the SAR consideration standard at 31 CFR 1023.320, and FATF Recommendation 12 for PEP handling — and produces a structured risk assessment with an explicit tier (LOW/MEDIUM/HIGH/CRITICAL), a confidence score, named risk factors, regulatory flags with citations, and a recommended action. Stage 2 (summarize) takes the original application plus the risk assessment and produces an onboarding summary tailored to the risk context: a LOW-risk standard case and a CRITICAL-risk escalation case produce meaningfully different next-step guidance. Every model output is schema-validated against a Zod contract before it enters the pipeline; schema violations fall to human review rather than propagating downstream.

## How to run it

Requirements: Node 24, an Anthropic API key with credit.

```
git clone https://github.com/dixob/crestview-fde-poc.git
cd crestview-fde-poc
npm install
cp .env.example .env
# Edit .env to add your ANTHROPIC_API_KEY
npm start
```

The pipeline reads `crestview_client_applications.csv` from the project root, processes all 15 applications, prints per-stage structured logs to the console, and saves the full JSON output to `output/final-15.json`.

## Architecture

The POC implements a two-stage LLM pipeline with hard schema contracts at every boundary. Applications flow through risk-assess → summarize, with each stage defined as a separate module under `src/stages/`. Prompts live in `src/prompts/` as version-controlled markdown files — not inline strings in code — so that a compliance reviewer could read, edit, and audit them without touching TypeScript. The Anthropic SDK call is localized to one function per stage. Swapping to Azure OpenAI — which Crestview already has through their M365 agreement — is a localized change to the SDK call sites, not a re-architecture. The model provider is a configuration decision in this design, not a foundational one.

Schema validation is done with Zod via the SDK's `messages.parse()` helper. The schema is defined once in `src/types.ts` and enforced by the SDK before any output enters the pipeline. This is the structural response to what broke in the previous RPA implementation — the previous system assumed clean documents and broke on variance. This one assumes variance and routes schema violations, low confidence, and missing data to human review by design.

The full Crestview architecture — what Part 1 of the proposal covers — is a three-layer AI model: monday's native AI blocks for low-stakes work (draft account setup, status updates), this custom TypeScript pipeline for compliance-grade work (anything that lands in front of a compliance analyst), and Copilot Studio over monday MCP for the M365-native RM experience. This POC implements layer two. Layers one and three — native blocks for recoverable work and Copilot-over-MCP for the RM surface — are described in Part 1 of the proposal.

## AI-assisted development

AI tooling was used throughout this engagement across four distinct layers, each with a different tool and a different prompting strategy.

**Strategic analysis.** The diagnosis of Crestview's onboarding problem, the business case, and the architectural decisions were developed in a Claude chat session under a "harsh, rigorous mentor" prompt frame. The mentor stance was explicit and maintained across turns: push beyond the JD expectations, hold scope, refuse re-planning, keep responses short. This produced a three-layer diagnosis (symptoms, mechanisms, hypothesis) and a business case framed around the "70% premium" — the observation that Crestview is not deciding whether to spend money on client operations but whether to keep spending it on data handling that their most expensive people are doing by hand.

Two of the architectural calls in this proposal went against the mentor's initial framing. The first was choosing a sequential stage 4 risk gate instead of a parallelized compliance topology — parallelization would have required organizational buy-in from Priya's team that I couldn't verify from the transcript alone. The second was building a custom pipeline for document extraction rather than relying on monday's native AI blocks, because regulated fields like beneficial owners can't be allowed to fail silently. In both cases the mentor's framing was the better default; the override was the situation-specific call.

**Regulatory framework extraction.** The risk assessment prompt is grounded in FATF, FinCEN, and BSA primary sources. Rather than asking a model to generate a compliance framework from its training data (which would be circular and undefended), a separate research-mode session was used to extract the framework from primary sources, with specific citations — 31 CFR 1010.230 for CDD, 31 CFR 1023.320 for SAR consideration, FATF Recommendation 12 for PEP handling. Those citations were spot-checked against the actual regulatory text before being used in the prompt. The result is that a compliance reviewer reading the model's reasoning can trace every regulatory claim back to a specific rule. That's the property that makes the output defensible in an audit, and it's the property the previous RPA system couldn't provide regardless of how well it worked.

**Prompt engineering.** The `risk-assess.md` prompt went through three iterations against a targeted test set of four applications: APP-2026-0303 (pattern recognition — should flag placement/layering), APP-2026-0315 (SAR escalation — should flag concealment pattern), APP-2026-0307 (PEP with disclosure — should stay HIGH, not over-flag to CRITICAL), and APP-2026-0313 (regulated activity with full disclosure — should be MEDIUM, not LOW). An earlier iteration correctly flagged 0303 and 0315 but incorrectly classified 0313 as LOW; the model had interpreted a "complexity is not risk" calibration sentence as permission to downgrade regulated activity when it was fully disclosed. The fix was a rubric rewrite that explicitly separated structural complexity from regulated-activity coordination: the former is LOW, the latter is MEDIUM even with full disclosure. The final iteration handled all four cases correctly and held across the full 15-application run. In production, this same iteration loop would continue under shadow-mode validation against analyst overrides — the difference is that the test cases would come from real disagreements rather than from my judgment about what was hard.

**Code generation.** The TypeScript scaffold — project structure, Zod schemas, SDK integration, CSV parsing, pipeline orchestration — was generated with Claude Code under a tightly constrained build prompt that specified the file structure, the schema contracts, the model string, and the rule to build for one application first before looping over 15. The constraint mattered: Claude Code will happily over-build scope if given room, and the "one application first" rule prevented that. Throughout iteration, schema changes were avoided in favor of prompt changes — the schema is the contract, the prompt serves the contract.

**The meta-principle.** The common thread across these four layers is that AI tooling was applied with different constraints at each layer because each layer has a different failure mode. Strategic analysis fails by producing bland generic advice, so the mentor frame forced sharpness and I accepted pushback on some calls and overrode pushback on others based on organizational reality. Framework extraction fails by hallucinating citations, so spot-checking was mandatory. Prompt engineering fails by over-fitting to easy cases, so the test set was designed around the hardest ones and the prompt was iterated against failures, not successes. Code generation fails by expanding scope, so the build prompt was constrained hard. "Using AI well" isn't a single skill. It's a set of skills matched to failure modes — and the skill that matters most is knowing which constraint each situation needs.

## Limitations and failure modes

**No synthetic eval set, by design.** There is no synthetic eval set in this POC, and that's a design decision rather than a gap. Two reasons. First, LLM-as-judge evaluation of LLM output is circular — the same model class that generates the output can't be trusted to grade it. Second, hand-labeling 15 applications without compliance domain expertise produces ground truth that's worse than no ground truth, because it creates a number that looks rigorous and isn't. The real validation mechanism for production deployment is shadow-mode rollout against Priya's compliance analyst team: the model runs against every incoming application, the analyst's decision is ground truth, and analyst override rate is the model quality metric. Disagreements at the case level are how the prompt gets tuned over time. The POC demonstrates the capability; the analyst team validates it in production.

**Text-only input.** The pipeline assumes applications arrive as structured text. Document ingestion — OCR on scanned forms, layout parsing on multi-page PDFs, extraction from Word documents and email attachments — is a separate engineering problem and is not solved here. In the full Crestview architecture, document ingestion is an upstream stage handled by a mix of SharePoint connectors and the monday document extraction features; the output of that stage is the input to this pipeline.

**Self-reported confidence.** The confidence scores produced by the model are self-reported and are not calibrated probabilities. They should be treated as a gating signal — cases under 0.7 route to human review — rather than as a reliable statistical measure. Calibration of confidence against analyst override decisions is a production concern, not a POC concern.

**Inter-run variance.** LLM outputs on this task are not deterministic. Running the same pipeline against the same 15 applications on separate runs produced tier shifts on three borderline cases (a MEDIUM/LOW boundary issue on complex-but-disclosed structures). The four cases with clear regulatory signal — CRITICAL on placement/layering and SAR-triggering concealment, HIGH on PEP with documentation gaps, MEDIUM on 10b5-1 regulated activity — were stable across runs. The shifts occurred only on structurally complex but fully disclosed cases — the kind of borderline call where two compliance analysts could reach different conclusions on the same application. The HITL gate is the actual safety mechanism here: any case under the confidence threshold routes to a human regardless of which side of the boundary the model lands on. Temperature tuning and shadow-mode calibration would tighten the variance further in production, but the architectural answer is that the model isn't the decision-maker — the analyst is.

**Single-model dependency in the POC.** This implementation calls Anthropic's API directly. The model provider abstraction is localized to one function per stage, so swapping providers is straightforward, but the POC does not implement fallback or ensemble strategies. In production, the graceful degradation path is to HITL on any API failure, not to a secondary model.

## What I would do with more time

**monday.com board integration.** Wire the pipeline output into a live monday board with HITL columns, RM briefing views, and a compliance queue. The architecture for this is in Part 1 of the proposal; the POC currently produces structured JSON that would be written via the monday GraphQL API or the monday MCP server.

**Document ingestion pipeline.** Add an upstream stage that ingests PDFs and scanned documents, extracts structured fields, and feeds the extraction into the risk assessment stage. This closes the loop on the RPA problem Crestview experienced.

**Shadow-mode evaluation harness.** Build a test harness that runs the pipeline against historical labeled cases (once labeled by Priya's team, not synthetically) and tracks override rate over time as prompts iterate. This is the production validation mechanism described in the limitations section.

**Copilot Studio agent over monday MCP.** The M365-native RM experience described in the proposal's three-layer AI model. RMs never touch monday directly — they interact with Copilot in Outlook and Teams, which reads and writes monday data via MCP. This is the architecture that addresses what Claire identified in discovery as the core problem — judgment workers spending their day on data entry instead of judgment.

---

Built for the monday.com Forward Deployed Engineer take-home assignment, April 2026.
