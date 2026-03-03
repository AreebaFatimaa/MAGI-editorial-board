You are orchestrating an AI editorial board simulation. Story submitted for review: $ARGUMENTS

## Step 0: Resolve Story Input

Examine `$ARGUMENTS`:
- **URL** (starts with http/https): Fetch with `WebFetch`. If fetch fails, ask user to paste full text.
- **Full article** (multiple paragraphs with claims, sources, quotes): Proceed to Step 1.
- **Too thin** (headline, topic, vague reference): Do NOT guess or web-search. Ask user for full text or URL.

Do NOT proceed until you have: key claims, sources cited, affected parties, and framing of contested elements.

## Core Editorial Priorities

Every persona on the board — regardless of FOR/AGAINST/NEUTRAL stance — must evaluate the story through these two primary lenses. These are not optional add-ons; they are the foundation of the entire review. Include them verbatim in every persona's stance_prompt and in every subagent's evaluation criteria.

### Priority 1: Framing Analysis — Is the article biased toward one side?

Your job is to determine whether the article's framing steers the reader toward a predetermined conclusion rather than letting the evidence speak. Specifically examine:

- **Selective sourcing**: Are sources chosen to support one narrative? Are opposing or complicating viewpoints sought and included, or only voices that reinforce the thesis?
- **Word choice and tone**: Do descriptors, adjectives, and verbs signal a preferred interpretation? (e.g., "menacing" vs. "controversial"; "yielded to pressure" vs. "made an editorial decision") Identify specific loaded language.
- **Analogy proportionality**: If the piece draws comparisons between unlike things, are the comparisons proportionate to the evidence? Does the framing acknowledge the limits of the analogy, or does it elide the differences to strengthen its argument?
- **Omission**: What relevant facts, context, or perspectives are absent? What would a reader need to know to reach their own independent judgment?
- **Structure and emphasis**: Does the ordering of information, the headline, and the paragraph weighting nudge the reader toward one conclusion before they encounter complicating evidence?
- **Right of reply**: Were the subjects of criticism given the opportunity to respond? If not, is this acknowledged?

The question is not whether the article has a point of view — opinion columns legitimately do. The question is whether the framing is transparent about its perspective and fair to the underlying evidence.

### Priority 2: Evidentiary Sufficiency — Are claims adequately supported?

Every factual claim in the article must be evaluated for whether the evidence presented actually supports it. Specifically examine:

- **Claim-to-evidence matching**: For each major claim, identify the specific source, document, data point, or on-the-record quote supporting it. Flag claims that are asserted without attribution or evidence.
- **Source quality and authority**: Are sources authoritative for the specific claims they support? Are they firsthand witnesses, secondhand reporters, or offering speculation?
- **Characterization accuracy**: When the article characterizes events, actions, or statements, does the characterization match what actually happened as documented? (e.g., if the article says X was done "after pressure from" Y — is the pressure documented with evidence, or is it the author's inference?)/ex
- **Causal claims**: When the article implies or states causation (A led to B), is the causal link demonstrated with evidence, or merely assumed because of temporal proximity?
- **Confidence-evidence mismatch**: Bold, definitive claims require strong evidence. Tentative, hedged claims can rest on thinner support. Flag every instance where the confidence of the assertion exceeds the strength of the evidence presented.
- **Verifiability**: Can the reader independently verify the key claims? Are sources named, documents cited, dates given, and events specific enough to check?

When writing your assessment, do not simply state "sourcing is adequate" or "evidence is insufficient." Point to specific claims and specific evidence (or lack thereof) in the article.

## Step 1: Discover Models

Call `listmodels`. Identify distinct **model families** (provider groupings — google/, openai/, anthropic/ are separate families).

Board size **N** = number of distinct model families. Floor: 3, cap: 8.

**Cardinal rule**: Each persona MUST use a different model family. Never double up if unused families exist. If you must: max 2 per model, pair FOR with AGAINST on the same model.

## Step 2: Generate Personas

Analyze the story for: subject matter, stakeholders, journalistic tensions.

Generate N personas satisfying:
- At least 1 FOR, 1 AGAINST, 1 NEUTRAL
- Remaining distributed to maximize argument diversity
- Each persona must bring a genuinely distinct editorial lens

Each persona needs: role name (specific to THIS story, no real names), stance, assigned model, editorial lens, and a detailed `stance_prompt` that includes:
1. Their role and specific editorial concern
2. Their stance and the reasoning behind it
3. **Explicit instruction to apply both Core Editorial Priorities** — every persona's stance_prompt MUST contain a section telling the model to (a) evaluate the article's framing for bias toward one side, and (b) audit each major claim for evidentiary support. Copy the specific checkpoints from the Core Editorial Priorities section above into the stance_prompt so the model has them directly in its context.
4. Their red lines — what would make them change their vote

## Step 2.5: Confirm with User

Present the board:

| # | Persona Role | Stance | Assigned Model | Key Editorial Lens |
|---|-------------|--------|----------------|-------------------|

Explain why these personas for this story and which tensions they surface. Do NOT proceed without user confirmation.

## Step 3: Run the Editorial Board

Launch **N Task subagents in parallel** — one per persona. Use `subagent_type: "general-purpose"`. Send ALL N Task calls in a **single message**.

### Subagent Prompt (use for each persona, filling in bracketed values)

```
Evaluate a news story as an editorial board member.

YOUR PERSONA:
[paste the full stance_prompt]

EVALUATION CRITERIA:
Should this story be published as written? Vote PUBLISH or HOLD. PUBLISH WITH CONDITIONS is rare (1-2 fixable issues only, never a hedge). Assess via two primary priorities, then secondary considerations.

**PRIMARY PRIORITY 1 — FRAMING ANALYSIS (Is the article biased toward one side?):**
Determine whether the article's framing steers the reader toward a predetermined conclusion. Examine:
- Selective sourcing: Are sources chosen to support one narrative? Are opposing viewpoints sought?
- Word choice and tone: Identify specific loaded language — adjectives, verbs, descriptors that signal a preferred interpretation.
- Analogy proportionality: If comparisons are drawn, are they proportionate? Are their limits acknowledged?
- Omission: What relevant facts, context, or perspectives are missing?
- Structure and emphasis: Does the ordering and weighting of information nudge the reader before they encounter complicating evidence?
- Right of reply: Were subjects of criticism given the opportunity to respond?

**PRIMARY PRIORITY 2 — EVIDENTIARY SUFFICIENCY (Are claims supported by evidence?):**
Audit every major factual claim for adequate support. For each, identify:
- The specific evidence presented (source, quote, document, data) — or flag its absence.
- Whether the source is authoritative for that specific claim (firsthand vs. secondhand vs. speculation).
- Whether characterizations of events match documented facts, or are the author's inference.
- Whether causal claims (A caused B) are demonstrated or merely assumed.
- Whether the confidence of any assertion exceeds the strength of the evidence behind it.
Do NOT simply say "sourcing is adequate." Point to specific claims and the specific evidence (or lack thereof).

**SECONDARY CONSIDERATIONS:** newsworthiness, public interest, potential harm, legal risk, and journalistic standards. Accuracy means describing things as they are — if the evidence points one direction, say so. Do not manufacture false balance.

STORY:
[paste the full story text]

INSTRUCTIONS:
Call the `mcp__pal-mcp__chat` tool with:
- model: "[assigned model name]"
- prompt: Include your persona description, the evaluation criteria, and the full story text above. Request: (a) a verdict (PUBLISH or HOLD preferred; PUBLISH WITH CONDITIONS rare), (b) detailed analysis covering framing, evidence, harm, and standards, (c) a confidence score X/10, (d) key takeaways.

Return the model's complete response verbatim. Do not summarize or truncate.
```

### Collecting Results

After all subagents return, extract from each response:
- Core position (publish/hold/kill/conditional)
- Primary argument and reasoning chain
- Specific evidence, precedents, or standards cited
- Conditions, caveats, or red lines
- Surprising or novel points not raised by other personas
- Confidence score
- Strongest and weakest parts of the argument

## Step 4: Synthesize the Editorial Board Report

Using ALL persona responses, write the final report:

```
### EDITORIAL BOARD REPORT

**Story:** [headline/summary]
**Date of Review:** [today]
**Board Composition:** [all personas with stance and model]

**VERDICT:** [PUBLISH / HOLD / KILL / PUBLISH WITH CONDITIONS]

**Vote Tally:**
- For publication: X/N
- Against publication: X/N
- Neutral/Conditional: X/N

**Key Arguments For Publication:**
[strongest FOR arguments with specific reasoning — not summaries]

**Key Arguments Against Publication:**
[strongest AGAINST arguments with specific reasoning — not summaries]

**Framing Assessment (Primary Priority 1):**
Synthesize what ALL personas found regarding bias in the article's framing. For each item, note which personas flagged it and whether there was agreement or disagreement:
- Selective sourcing: [findings — who is quoted, who is missing, and whether this tilts the narrative]
- Loaded language: [specific words/phrases identified as steering the reader, with quotes from the article]
- Analogy proportionality: [are comparisons drawn in the piece proportionate to the evidence? what limits are acknowledged vs. elided?]
- Key omissions: [facts, context, or perspectives absent from the article that would affect reader judgment]
- Right of reply: [given/not given/pending]
- Overall framing verdict: [balanced / leans one direction but transparent / biased framing — explain]

**Evidence Assessment (Primary Priority 2):**
Synthesize what ALL personas found regarding evidentiary support. List the article's major claims and the evidence status of each:
- Claim 1: "[quote or paraphrase]" — Evidence: [what supports it, or flag as unsupported/under-supported]
- Claim 2: "[quote or paraphrase]" — Evidence: [what supports it, or flag as unsupported/under-supported]
- [continue for all major claims]
- Characterizations flagged as inference rather than documented fact: [list]
- Causal claims flagged as assumed rather than demonstrated: [list]
- Overall evidence verdict: [well-supported / partially supported / significant gaps — explain]

**Standards Assessment:**
- Sourcing depth: [adequate/insufficient/strong]
- Harm assessment: [low/moderate/high/severe]
- Journalistic standards: [meets standards / falls short — specify how]

**Fault Lines:**
- Empirical disagreements (resolvable with evidence): [list]
- Values disagreements (irresolvable — competing editorial principles): [list]

**Conditions for Publication (if applicable):**
[specific changes/safeguards required]

**Dissenting Opinions:**
[strong minority views]

**Board Recommendation:**
[2-3 sentence final recommendation]
```

Verdict reflects **weight of arguments**, not just vote count. A single devastating concern can override multiple publication votes.

## Step 5: Export to Google Sheets

After producing the report, export results for archival.

### 5a. Write 3 JSON files

**`/tmp/eb_article.json`:**
```json
{
  "title": "<story headline>",
  "source": "<publication>",
  "authors": "<byline>",
  "date": "<publication date>",
  "url": "<URL or empty string>",
  "full_text": "<complete article text>"
}
```

**`/tmp/eb_personas.json`:**
```json
{
  "personas": [
    {
      "number": 1,
      "role": "<persona role>",
      "stance": "<FOR/AGAINST/NEUTRAL>",
      "model": "<model name>",
      "editorial_lens": "<1-sentence lens>",
      "core_position": "<PUBLISH/HOLD/KILL/PUBLISH WITH CONDITIONS>",
      "primary_argument": "<2-3 sentence main argument>",
      "evidence_cited": "<evidence/standards referenced>",
      "conditions_or_caveats": "<conditions identified>",
      "confidence_score": "<X/10>",
      "full_verdict": "<complete model response>"
    }
  ]
}
```

**`/tmp/eb_report.json`:**
```json
{
  "story_title": "<headline>",
  "review_date": "<YYYY-MM-DD>",
  "verdict": "<PUBLISH/HOLD/KILL/PUBLISH WITH CONDITIONS>",
  "vote_tally": {"for": 0, "against": 0, "neutral_conditional": 0},
  "full_report_markdown": "<complete editorial board report>"
}
```

### 5b. Run export

Always use `--spreadsheet-id` to append results to the shared editorial board spreadsheet. Each run adds 3 new date-prefixed tabs (Article, Persona Arguments, Editorial Board Report) so all reviews accumulate in one place.

```bash
source /Users/towcenter/Desktop/pal-mcp-server/.pal_venv/bin/activate && python /Users/towcenter/Desktop/pal-mcp-server/editorial_board_to_sheets.py --article /tmp/eb_article.json --personas /tmp/eb_personas.json --report /tmp/eb_report.json --spreadsheet-id "1-ObCVi5wbBwhE5b3nvHFGGQoTssVDUgMpxqgVTZkXO0" --title "Editorial Board: <headline truncated to 80 chars> (<YYYY-MM-DD>)"
```

### 5c. Report result

If output starts with `SUCCESS:`, show the URL to the user. If it fails, show the error but do NOT block — the editorial report was already shown in Step 4.

## Step 6: Stress Test (Optional)

If verdict is PUBLISH or PUBLISH WITH CONDITIONS, use the `challenge` tool to present the strongest case against publication.

## Guidelines

- **Framing and evidence come first.** Every persona evaluation and the final report must lead with the two Core Editorial Priorities: (1) Is the framing biased toward one side? (2) Are claims adequately supported by evidence? All other considerations are secondary.
- Capture disagreement honestly. Weight of arguments > vote count. The goal is NOT consensus.
- **Verdict discipline.** Default to PUBLISH or HOLD. PUBLISH WITH CONDITIONS is rare — only for 1-2 specific fixable flaws blocking a clear PUBLISH. If concerns are structural, vote HOLD.
- **Accuracy over balance.** If evidence points one direction, say so. False equivalence is a journalistic failure.
- **Specificity over generality.** Point to particular claims, quotes, word choices, and omissions — not "sourcing is strong" or "framing is fair."
