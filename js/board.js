// =============================================================================
// board.js - Editorial Board Logic
//
// FOR THE PYTHON PERSON:
// This is the "brain" of the application. It contains:
// 1. The prompt engineering for persona generation
// 2. The editorial evaluation criteria (from editorial-board.md)
// 3. The debate orchestration (running personas in parallel)
//
// Think of this as the domain logic layer - it knows WHAT to ask the LLMs.
// api.js knows HOW to talk to OpenRouter. This separation means you can
// change editorial criteria without touching network code, and vice versa.
// =============================================================================

import { chatCompletion, streamChatCompletion } from './api.js';
import { BOARD_MODEL_FAMILIES } from './config.js';

// =============================================================================
// EDITORIAL CRITERIA (copied from editorial-board.md)
// These appear in EVERY persona's evaluation prompt.
// =============================================================================

const FRAMING_ANALYSIS_CRITERIA = `**PRIMARY PRIORITY 1 - FRAMING ANALYSIS (Is the article biased toward one side?):**
Determine whether the article's framing steers the reader toward a predetermined conclusion. Examine:
- Selective sourcing: Are sources chosen to support one narrative? Are opposing viewpoints sought?
- Word choice and tone: Identify specific loaded language - adjectives, verbs, descriptors that signal a preferred interpretation.
- Analogy proportionality: If comparisons are drawn, are they proportionate? Are their limits acknowledged?
- Omission: What relevant facts, context, or perspectives are missing?
- Structure and emphasis: Does the ordering and weighting of information nudge the reader before they encounter complicating evidence?
- Right of reply: Were subjects of criticism given the opportunity to respond?`;

const EVIDENTIARY_SUFFICIENCY_CRITERIA = `**PRIMARY PRIORITY 2 - EVIDENTIARY SUFFICIENCY (Are claims supported by evidence?):**
Audit every major factual claim for adequate support. For each, identify:
- The specific evidence presented (source, quote, document, data) - or flag its absence.
- Whether the source is authoritative for that specific claim (firsthand vs. secondhand vs. speculation).
- Whether characterizations of events match documented facts, or are the author's inference.
- Whether causal claims (A caused B) are demonstrated or merely assumed.
- Whether the confidence of any assertion exceeds the strength of the evidence behind it.
Do NOT simply say "sourcing is adequate." Point to specific claims and the specific evidence (or lack thereof).`;

// =============================================================================
// META MODEL PREFERENCE (for persona generation / curator tasks)
// =============================================================================

const META_MODEL_PREFERENCE = [
    'anthropic/claude-sonnet-4-20250514',
    'anthropic/claude-sonnet-4',
    'anthropic/claude-3.5-sonnet',
    'openai/gpt-4o',
    'google/gemini-2.5-pro',
    'google/gemini-2.0-flash',
];

// =============================================================================
// PERSONA GENERATION
// =============================================================================

/**
 * Build the prompt that asks an LLM to generate editorial board personas.
 *
 * @param {string} articleText - The full article text
 * @param {number} boardSize - How many personas (3-8)
 * @returns {Array} Messages array for chatCompletion
 */
function buildPersonaGenerationPrompt(articleText, boardSize) {
    const systemPrompt = `You are an editorial board curator. Your job is to assemble a diverse editorial board to review a news article.

Analyze the article for: subject matter, stakeholders, journalistic tensions, and potential points of contention.

Generate exactly ${boardSize} personas satisfying these rules:
- At least 1 FOR publication, 1 AGAINST publication, 1 NEUTRAL
- Remaining distributed to maximize argument diversity
- Each persona must bring a genuinely DISTINCT editorial lens
- No persona should duplicate another's perspective

CRITICAL REQUIREMENT — STAKEHOLDER REPRESENTATION:
Your board must NOT be composed entirely of journalists, editors, or media professionals.
At least 2 of the ${boardSize} personas must be real-world STAKEHOLDERS directly affected
by or involved in the story's subject matter. These stakeholders must represent opposing
sides of the issue.

Examples:
- Story about war in Iran → include a persona representing Iranian civilian perspective
  AND a persona representing the opposing state/military perspective
- Story about police shooting of a Black person → include a young Black American
  perspective AND a law enforcement/community safety perspective
- Story about Palestine → include a young Palestinian from Gaza AND an Israeli
  civilian or security perspective
- Story about tech regulation → include a tech worker/founder AND a consumer
  advocate or affected community member
- Story about immigration → include an immigrant or asylum seeker AND a border
  community resident or enforcement perspective
- Story about healthcare policy → include a patient/caregiver AND a healthcare
  provider or insurance industry perspective

These stakeholder personas should evaluate the article from their lived-experience
perspective: Does the article accurately represent their reality? What is missing?
What is distorted? They are NOT journalists — they bring the voice of the people
the story is about.

The remaining personas should be editorial/journalistic roles as before.

For each persona, provide:
1. "role": A specific role name tied to THIS article's subject matter (e.g., "National Security Editor" not just "Editor"). For stakeholder personas, use descriptive names like "Iranian Civilian in Tehran" or "Young Black Community Organizer, Chicago". Do NOT use real people's names.
2. "stance": Exactly one of "FOR", "AGAINST", or "NEUTRAL"
3. "editorial_lens": One sentence describing their specific editorial concern
4. "stance_prompt": A detailed 3-4 sentence description of:
   - Their role and specific editorial concern
   - Their stance and the reasoning behind it
   - Their red lines (what would make them change their vote)
5. "red_lines": What would make them flip their position

RESPOND WITH ONLY A JSON object in this exact format (no markdown fences, no explanation):
{
  "personas": [
    {
      "role": "Role Name",
      "stance": "FOR",
      "editorial_lens": "One sentence lens",
      "stance_prompt": "Detailed stance description...",
      "red_lines": "What would flip their position..."
    }
  ]
}`;

    return [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Here is the article to analyze. Generate ${boardSize} editorial board personas:\n\n${articleText}` },
    ];
}

/**
 * Pick a "meta" model for curator tasks.
 * Returns the first preferred model that's actually available.
 */
function pickMetaModel(availableModels) {
    const ids = new Set(availableModels.map(m => m.id));
    for (const model of META_MODEL_PREFERENCE) {
        if (ids.has(model)) return model;
    }
    return availableModels[0]?.id;
}

// Maximum character count sent to any single LLM call.
const MAX_ARTICLE_CHARS = 60_000;

/**
 * Truncate article text if it exceeds the safe limit for LLM context windows.
 */
function truncateArticle(text) {
    if (text.length <= MAX_ARTICLE_CHARS) return text;
    return text.substring(0, MAX_ARTICLE_CHARS) +
        '\n\n[NOTE: Article was truncated to fit context window. Analysis is based on the text above.]';
}

/**
 * Generate editorial board personas by calling an LLM.
 *
 * @param {string} articleText - The article to analyze
 * @param {Array} availableModels - All models from OpenRouter [{id, name, ...}]
 * @returns {Promise<{personas: Array, callMeta: {content, usage, model, latency_ms}}>}
 */
export async function generatePersonas(articleText, availableModels) {
    if (!availableModels || availableModels.length === 0) {
        throw new Error('No models available. Validate your API key first.');
    }

    // 1. Determine board size based on available families from config
    const modelIds = new Set(availableModels.map(m => m.id));
    const availableFamilies = BOARD_MODEL_FAMILIES.filter(f => {
        // Check if any model from this family is available
        return availableModels.some(m => m.id.startsWith(f.family + '/'));
    });
    const boardSize = Math.max(3, Math.min(8, availableFamilies.length));

    // 2. Pick a curator model
    const curatorModel = pickMetaModel(availableModels);
    if (!curatorModel) {
        throw new Error('No suitable model found for board generation.');
    }

    // 3. Build prompt and call LLM (truncate article if needed)
    const messages = buildPersonaGenerationPrompt(truncateArticle(articleText), boardSize);
    const result = await chatCompletion(curatorModel, messages, {
        temperature: 0.7,
        max_tokens: 4000,
    });

    // 4. Parse JSON from response with multiple fallback strategies
    const response = result.content;
    let parsed;
    try {
        parsed = JSON.parse(response);
    } catch (e) {
        const match = response.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (match) {
            try {
                parsed = JSON.parse(match[1]);
            } catch (innerErr) {
                throw new Error('Failed to parse persona suggestions. The AI returned invalid JSON inside code fences.');
            }
        } else {
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    parsed = JSON.parse(jsonMatch[0]);
                } catch (innerErr) {
                    throw new Error('Failed to parse persona suggestions. The AI returned invalid JSON.');
                }
            } else {
                throw new Error('Failed to parse persona suggestions. The AI returned no JSON.');
            }
        }
    }

    const personas = parsed.personas || parsed;
    if (!Array.isArray(personas) || personas.length === 0) {
        throw new Error('No personas generated. Try again.');
    }

    // Validate persona structure
    for (const p of personas) {
        if (!p.role || typeof p.role !== 'string') p.role = 'Editorial Board Member';
        if (!['FOR', 'AGAINST', 'NEUTRAL'].includes(p.stance)) p.stance = 'NEUTRAL';
        if (!p.editorial_lens || typeof p.editorial_lens !== 'string') p.editorial_lens = '';
    }

    // 5. Auto-assign models
    const assignedPersonas = assignModels(personas, availableModels);

    // Return personas + raw call metadata for state tracking
    return { personas: assignedPersonas, callMeta: result };
}

/**
 * Auto-assign models to personas using BOARD_MODEL_FAMILIES from config.
 * Each persona gets a different model family.
 *
 * @param {Array} personas - Persona objects (without model assignments)
 * @param {Array} availableModels - All models from OpenRouter
 * @returns {Array} Personas with .model field populated
 */
export function assignModels(personas, availableModels) {
    const modelIds = new Set(availableModels.map(m => m.id));

    // Build ordered list of available models from config families
    const assignableModels = [];
    for (const familyConfig of BOARD_MODEL_FAMILIES) {
        // First try the exact preferred model
        if (modelIds.has(familyConfig.model)) {
            assignableModels.push(familyConfig.model);
            continue;
        }
        // Fallback: first available model from this family
        const fallback = availableModels.find(m => m.id.startsWith(familyConfig.family + '/'))?.id;
        if (fallback) {
            assignableModels.push(fallback);
        }
    }

    // If we have fewer assignable models than personas, supplement with any remaining models
    if (assignableModels.length < personas.length) {
        const used = new Set(assignableModels);
        for (const m of availableModels) {
            if (!used.has(m.id) && assignableModels.length < personas.length) {
                assignableModels.push(m.id);
                used.add(m.id);
            }
        }
    }

    // Assign round-robin
    return personas.map((persona, index) => ({
        ...persona,
        model: assignableModels[index % assignableModels.length] || availableModels[0]?.id,
    }));
}

// =============================================================================
// BOARD VALIDATION
// =============================================================================

/**
 * Validate that the board configuration meets requirements.
 *
 * @param {Array} personas
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateBoard(personas) {
    const errors = [];
    const warnings = [];

    if (!personas || personas.length < 3) errors.push('Minimum 3 personas required.');
    else if (personas.length > 8) errors.push('Maximum 8 personas allowed.');

    if (personas && personas.length > 0) {
        const stances = personas.map(p => p.stance);
        if (!stances.includes('FOR')) errors.push('At least 1 FOR persona required.');
        if (!stances.includes('AGAINST')) errors.push('At least 1 AGAINST persona required.');
        if (!stances.includes('NEUTRAL')) errors.push('At least 1 NEUTRAL persona required.');

        const families = personas.map(p => (p.model || '').split('/')[0]);
        const seen = {};
        const dupes = [];
        families.forEach(f => {
            if (f) {
                seen[f] = (seen[f] || 0) + 1;
                if (seen[f] === 2) dupes.push(f);
            }
        });
        if (dupes.length > 0) {
            warnings.push(`Duplicate model families: ${dupes.join(', ')}. Different families give more diverse perspectives.`);
        }

        personas.forEach((p, i) => {
            if (!p.role || !p.role.trim()) {
                errors.push(`Persona #${i + 1} needs a role name.`);
            }
            if (!p.model || !p.model.trim()) {
                errors.push(`Persona #${i + 1} needs a model assignment.`);
            }
        });
    }

    return {
        valid: errors.length === 0,
        errors: [...errors, ...warnings.map(w => `Warning: ${w}`)],
    };
}

// =============================================================================
// DEBATE: EVALUATION PROMPTS
// =============================================================================

/**
 * Build the evaluation prompt for a single persona (parallel mode — no
 * previous speaker context).
 *
 * @param {Object} persona - The persona object
 * @param {string} articleText - The full article text
 * @returns {Array} Messages array for streaming chat completion
 */
export function buildEvaluationPrompt(persona, articleText) {
    let stanceGuidance;
    if (persona.stance === 'FOR') {
        stanceGuidance = `You are inclined to recommend publication. Look for the story's strengths, its public interest value, and the adequacy of its sourcing. However, you MUST still honestly flag serious framing or evidentiary problems if they exist. A good story should withstand scrutiny.`;
    } else if (persona.stance === 'AGAINST') {
        stanceGuidance = `You approach with rigorous scrutiny and a high bar for publication. Look for weaknesses in sourcing, framing bias, potential harm, and gaps in evidence. However, you MUST acknowledge if the story is exceptionally well-sourced or serves an urgent public interest. Do not manufacture objections.`;
    } else {
        stanceGuidance = `You take a balanced, analytical approach. Weigh evidence proportionally. Neither champion nor oppose publication reflexively. Your job is to surface the most important considerations the board should weigh, giving each its fair weight based on the evidence.`;
    }

    const systemPrompt = `You are participating in an editorial board debate about whether to publish a news story. You are evaluating independently — other board members are evaluating simultaneously, but you cannot see their responses.

YOUR PERSONA:
Role: ${persona.role}
Stance: ${persona.stance}
Editorial Lens: ${persona.editorial_lens}
${persona.stance_prompt ? `\nDetailed Perspective:\n${persona.stance_prompt}` : ''}
${persona.red_lines ? `\nRed Lines (what would flip your position): ${persona.red_lines}` : ''}

STANCE GUIDANCE:
${stanceGuidance}

EVALUATION CRITERIA:
Should this story be published as written? Vote PUBLISH or HOLD. PUBLISH WITH CONDITIONS is rare (1-2 fixable issues only, never a hedge). Assess via two primary priorities, then secondary considerations.

${FRAMING_ANALYSIS_CRITERIA}

${EVIDENTIARY_SUFFICIENCY_CRITERIA}

**SECONDARY CONSIDERATIONS:** newsworthiness, public interest, potential harm, legal risk, and journalistic standards. Accuracy means describing things as they are - if the evidence points one direction, say so. Do not manufacture false balance.

INSTRUCTIONS:
Provide your assessment in this format:
1. **Verdict**: PUBLISH or HOLD (PUBLISH WITH CONDITIONS only if 1-2 specific fixable issues)
2. **Framing Analysis**: Your assessment of the article's framing, with specific examples
3. **Evidence Audit**: Specific claims and whether they are supported, under-supported, or unsupported
4. **Key Concerns**: The most important issues you see
5. **Confidence**: X/10 with brief justification
6. **Key Takeaways**: 3-5 bullet points of your most critical insights

Be specific. Point to particular claims, quotes, word choices, and omissions. Do not be vague.`;

    return [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Here is the article for your editorial review:\n\n${articleText}` },
    ];
}

// =============================================================================
// DEBATE ORCHESTRATION (PARALLEL)
// =============================================================================

/**
 * Run the full debate: all personas evaluate the article in parallel.
 * Each persona streams simultaneously into its own chat bubble.
 *
 * @param {Array} personas - The configured persona array
 * @param {string} articleText - The full article text
 * @param {Object} callbacks:
 *   - onPersonaStart(persona, index): when a persona begins
 *   - onToken(persona, index, token): for each streamed token
 *   - onPersonaDone(persona, index, fullResponse, meta): when a persona finishes
 *   - onAllDone(results): when all personas have finished
 *   - onError(persona, index, error): on error
 * @returns {Promise<Array>} Array of { persona, response, callMeta } objects
 */
export async function runDebate(personas, articleText, callbacks) {
    const safeArticleText = truncateArticle(articleText);

    // Notify UI that all personas are starting
    for (let i = 0; i < personas.length; i++) {
        callbacks.onPersonaStart(personas[i], i);
    }

    // Launch all personas in parallel
    const promises = personas.map((persona, i) => {
        const messages = buildEvaluationPrompt(persona, safeArticleText);
        let fullResponse = '';

        return new Promise((resolve) => {
            streamChatCompletion(persona.model, messages, {
                onToken: (token) => {
                    fullResponse += token;
                    callbacks.onToken(persona, i, token);
                },
                onMeta: (meta) => {
                    // meta = { usage, model, latency_ms }
                    const result = { persona, response: fullResponse, streamMeta: meta };
                    callbacks.onPersonaDone(persona, i, fullResponse, meta);
                    resolve(result);
                },
                onDone: () => {
                    // onMeta fires before onDone for streams with usage data.
                    // If onMeta didn't fire (no usage), resolve here.
                },
                onError: (error) => {
                    callbacks.onError(persona, i, error);
                    resolve({ persona, response: `[Error: ${error.message}]`, streamMeta: null, error: error.message });
                },
                temperature: 0.7,
                max_tokens: 4000,
            });

            // Safety timeout: if neither onMeta nor onDone fires in 5 min, resolve anyway
            setTimeout(() => {
                if (fullResponse) {
                    resolve({ persona, response: fullResponse, streamMeta: null });
                } else {
                    resolve({ persona, response: '[Error: Timed out]', streamMeta: null, error: 'Timed out' });
                }
            }, 300_000);
        });
    });

    const results = await Promise.allSettled(promises);
    const finalResults = results.map(r => r.status === 'fulfilled' ? r.value : { persona: null, response: '[Error]', streamMeta: null });

    callbacks.onAllDone(finalResults);
    return finalResults;
}
