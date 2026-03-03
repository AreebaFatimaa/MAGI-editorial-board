// =============================================================================
// board.js - Editorial Board Logic
//
// FOR THE PYTHON PERSON:
// This is the "brain" of the application. It contains:
// 1. The prompt engineering for persona generation
// 2. The editorial evaluation criteria (from editorial-board.md)
// 3. The debate orchestration (running personas sequentially)
//
// Think of this as the domain logic layer - it knows WHAT to ask the LLMs.
// api.js knows HOW to talk to OpenRouter. This separation means you can
// change editorial criteria without touching network code, and vice versa.
// =============================================================================

import { chatCompletion, streamChatCompletion } from './api.js';

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
// DEFAULT MODEL PREFERENCES
// =============================================================================
// When auto-assigning models, pick the "best" model per family.
// First available in the list wins. These are capable models that won't
// bankrupt users on a single editorial board run.

const DEFAULT_MODEL_PREFERENCES = {
    'anthropic': ['anthropic/claude-sonnet-4', 'anthropic/claude-3.5-sonnet', 'anthropic/claude-haiku-4'],
    'openai': ['openai/gpt-4o', 'openai/gpt-4o-mini', 'openai/chatgpt-4o-latest'],
    'google': ['google/gemini-2.5-pro', 'google/gemini-2.0-flash', 'google/gemini-pro-1.5'],
    'meta-llama': ['meta-llama/llama-3.3-70b-instruct', 'meta-llama/llama-3.1-70b-instruct'],
    'deepseek': ['deepseek/deepseek-chat-v3-0324', 'deepseek/deepseek-chat'],
    'mistralai': ['mistralai/mistral-large', 'mistralai/mixtral-8x22b-instruct'],
    'qwen': ['qwen/qwen-2.5-72b-instruct', 'qwen/qwen-2.5-coder-32b-instruct'],
    'cohere': ['cohere/command-r-plus', 'cohere/command-r'],
};

// For the "curator" model (persona generation) and "synthesizer" (report):
const META_MODEL_PREFERENCE = [
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
 *
 * WHY ask the LLM to generate personas? Because personas should be
 * SPECIFIC to this article's subject matter. A story about AI regulation
 * needs different voices than one about climate policy.
 */
function buildPersonaGenerationPrompt(articleText, boardSize) {
    const systemPrompt = `You are an editorial board curator. Your job is to assemble a diverse editorial board to review a news article.

Analyze the article for: subject matter, stakeholders, journalistic tensions, and potential points of contention.

Generate exactly ${boardSize} personas satisfying these rules:
- At least 1 FOR publication, 1 AGAINST publication, 1 NEUTRAL
- Remaining distributed to maximize argument diversity
- Each persona must bring a genuinely DISTINCT editorial lens
- No persona should duplicate another's perspective

For each persona, provide:
1. "role": A specific role name tied to THIS article's subject matter (e.g., "National Security Editor" not just "Editor"). Do NOT use real people's names.
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
 * Pick a "meta" model for curator/synthesis tasks.
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
// Conservative estimate: ~4 chars per token, most models have 128k+ context,
// but we cap at ~60k chars to leave room for system prompt + response.
const MAX_ARTICLE_CHARS = 60_000;

/**
 * Truncate article text if it exceeds the safe limit for LLM context windows.
 * Appends a notice so the LLM knows the text was truncated.
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
 * @returns {Promise<Array>} Array of persona objects with model assignments
 */
export async function generatePersonas(articleText, availableModels) {
    if (!availableModels || availableModels.length === 0) {
        throw new Error('No models available. Validate your API key first.');
    }

    // 1. Determine board size based on available model families
    const families = [...new Set(availableModels.map(m => m.id.split('/')[0]))];
    const boardSize = Math.max(3, Math.min(8, families.length));

    // 2. Pick a curator model
    const curatorModel = pickMetaModel(availableModels);
    if (!curatorModel) {
        throw new Error('No suitable model found for board generation.');
    }

    // 3. Build prompt and call LLM (truncate article if needed)
    const messages = buildPersonaGenerationPrompt(truncateArticle(articleText), boardSize);
    const response = await chatCompletion(curatorModel, messages, {
        temperature: 0.7,
        max_tokens: 4000,
    });

    // 4. Parse JSON from response with multiple fallback strategies
    let parsed;
    try {
        parsed = JSON.parse(response);
    } catch (e) {
        // LLM might wrap JSON in markdown code fences - try to extract
        const match = response.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (match) {
            try {
                parsed = JSON.parse(match[1]);
            } catch (innerErr) {
                throw new Error('Failed to parse persona suggestions. The AI returned invalid JSON inside code fences.');
            }
        } else {
            // Last resort: try to find a JSON object or array in the response
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

    // Validate persona structure - ensure required fields exist
    for (const p of personas) {
        if (!p.role || typeof p.role !== 'string') p.role = 'Editorial Board Member';
        if (!['FOR', 'AGAINST', 'NEUTRAL'].includes(p.stance)) p.stance = 'NEUTRAL';
        if (!p.editorial_lens || typeof p.editorial_lens !== 'string') p.editorial_lens = '';
    }

    // 5. Auto-assign models
    return assignModels(personas, availableModels);
}

/**
 * Auto-assign models to personas. Each persona should use a different
 * model family (the "cardinal rule" from editorial-board.md).
 *
 * @param {Array} personas - Persona objects (without model assignments)
 * @param {Array} availableModels - All models from OpenRouter
 * @returns {Array} Personas with .model field populated
 *
 * STRATEGY:
 * 1. Group models by family (the prefix before "/")
 * 2. For each family, pick the preferred model from DEFAULT_MODEL_PREFERENCES
 * 3. Assign one family per persona, round-robin
 * 4. If more personas than families: pair FOR with AGAINST on same model
 */
export function assignModels(personas, availableModels) {
    const modelIds = new Set(availableModels.map(m => m.id));

    // Group by family and pick the best model per family
    const familyModels = {};
    const families = [...new Set(availableModels.map(m => m.id.split('/')[0]))];

    for (const family of families) {
        const prefs = DEFAULT_MODEL_PREFERENCES[family] || [];
        // Find first preferred model that's actually available
        const preferred = prefs.find(p => modelIds.has(p));
        // Fallback: first model in this family
        const fallback = availableModels.find(m => m.id.startsWith(family + '/'))?.id;
        familyModels[family] = preferred || fallback;
    }

    // Get list of family names that have a usable model
    const usableFamilies = Object.entries(familyModels)
        .filter(([, model]) => model)
        .map(([family]) => family);

    // Assign round-robin
    return personas.map((persona, index) => ({
        ...persona,
        model: familyModels[usableFamilies[index % usableFamilies.length]] || availableModels[0]?.id,
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
 *
 * Rules (from editorial-board.md):
 * - Minimum 3, maximum 8 personas
 * - At least 1 FOR, 1 AGAINST, 1 NEUTRAL
 * - Duplicate model families are warned (not blocked)
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

        // Warn about duplicate model families (not a hard error)
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

        // Check for empty roles or missing models
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
 * Build the evaluation prompt for a single persona.
 * This is the prompt each persona receives to evaluate the article.
 *
 * @param {Object} persona - The persona object
 * @param {string} articleText - The full article text
 * @param {Array} previousResponses - Array of {persona, response} from earlier speakers
 * @returns {Array} Messages array for streaming chat completion
 *
 * DESIGN: The first persona is "blinded" (sees only the article).
 * Subsequent personas see a summary of what previous members said and are
 * instructed to reference them by name - agreeing, disagreeing, or building
 * on their points. This makes the debate feel like a real conversation.
 */
export function buildEvaluationPrompt(persona, articleText, previousResponses = []) {
    // Build a stance-specific preamble
    let stanceGuidance;
    if (persona.stance === 'FOR') {
        stanceGuidance = `You are inclined to recommend publication. Look for the story's strengths, its public interest value, and the adequacy of its sourcing. However, you MUST still honestly flag serious framing or evidentiary problems if they exist. A good story should withstand scrutiny.`;
    } else if (persona.stance === 'AGAINST') {
        stanceGuidance = `You approach with rigorous scrutiny and a high bar for publication. Look for weaknesses in sourcing, framing bias, potential harm, and gaps in evidence. However, you MUST acknowledge if the story is exceptionally well-sourced or serves an urgent public interest. Do not manufacture objections.`;
    } else {
        stanceGuidance = `You take a balanced, analytical approach. Weigh evidence proportionally. Neither champion nor oppose publication reflexively. Your job is to surface the most important considerations the board should weigh, giving each its fair weight based on the evidence.`;
    }

    // Build the "previous discussion" section for personas after the first
    let discussionContext = '';
    if (previousResponses.length > 0) {
        const summaries = previousResponses.map(r =>
            `**@${r.persona.role}** (${r.persona.stance}): ${r.response.substring(0, 800)}${r.response.length > 800 ? '...' : ''}`
        ).join('\n\n');

        discussionContext = `
PREVIOUS BOARD DISCUSSION:
The following board members have already spoken. You are joining an ongoing editorial discussion.
Read their positions carefully, then provide YOUR OWN assessment. You MUST:
- Reference other board members BY NAME using @Name format (e.g., "@${previousResponses[0].persona.role}")
- Explicitly agree or disagree with specific points they raised
- Build on their analysis where relevant, or challenge it where you see flaws
- Do NOT simply repeat what others said - add new insights from YOUR editorial lens
- If someone made a strong point, acknowledge it: "As @Name correctly noted..."
- If you disagree, be direct: "I disagree with @Name's assessment that..."

${summaries}

---
Now provide YOUR assessment, engaging with the discussion above:`;
    }

    const systemPrompt = `You are participating in an editorial board debate about whether to publish a news story.${previousResponses.length > 0 ? ' Other board members have already spoken - you are responding in an ongoing group discussion. Write as if you are in a WhatsApp group chat with your colleagues: direct, conversational, and referencing others by name.' : ' You are the first to speak.'}

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
${previousResponses.length > 0 ? 'Engage with the ongoing discussion. Reference other board members by @Name. Then provide:' : 'Provide your assessment in this format:'}
1. **Verdict**: PUBLISH or HOLD (PUBLISH WITH CONDITIONS only if 1-2 specific fixable issues)
2. **Framing Analysis**: Your assessment of the article's framing, with specific examples
3. **Evidence Audit**: Specific claims and whether they are supported, under-supported, or unsupported
4. **Key Concerns**: The most important issues you see
5. **Confidence**: X/10 with brief justification
6. **Key Takeaways**: 3-5 bullet points of your most critical insights

Be specific. Point to particular claims, quotes, word choices, and omissions. Do not be vague.`;

    const userContent = previousResponses.length > 0
        ? `Here is the article under review:\n\n${articleText}\n\n${discussionContext}`
        : `Here is the article for your editorial review:\n\n${articleText}`;

    return [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
    ];
}

// =============================================================================
// DEBATE ORCHESTRATION
// =============================================================================

/**
 * Run the full debate: each persona evaluates the article sequentially.
 * Each persona after the first can see what previous members said,
 * enabling them to reference, agree with, or challenge each other.
 *
 * @param {Array} personas - The configured persona array
 * @param {string} articleText - The full article text
 * @param {Object} callbacks:
 *   - onPersonaStart(persona, index): when a persona begins
 *   - onToken(persona, token): for each streamed token
 *   - onPersonaDone(persona, fullResponse): when a persona finishes
 *   - onAllDone(results): when all personas have finished
 *   - onError(persona, error): on error
 * @returns {Promise<Array>} Array of { persona, response } objects
 */
export async function runDebate(personas, articleText, callbacks) {
    const results = [];
    const safeArticleText = truncateArticle(articleText);

    for (let i = 0; i < personas.length; i++) {
        const persona = personas[i];
        callbacks.onPersonaStart(persona, i);

        // Pass previous responses so this persona can reference others
        const messages = buildEvaluationPrompt(persona, safeArticleText, results);
        let fullResponse = '';

        try {
            // Wrap streaming in a Promise so we can await it in our sequential loop
            await new Promise((resolve, reject) => {
                streamChatCompletion(persona.model, messages, {
                    onToken: (token) => {
                        fullResponse += token;
                        callbacks.onToken(persona, token);
                    },
                    onDone: () => {
                        callbacks.onPersonaDone(persona, fullResponse);
                        results.push({ persona, response: fullResponse });
                        resolve();
                    },
                    onError: (error) => {
                        callbacks.onError(persona, error);
                        // Still add a result entry so we don't skip this persona
                        results.push({ persona, response: `[Error: ${error.message}]` });
                        resolve(); // Don't reject - continue with remaining personas
                    },
                    temperature: 0.7,
                    max_tokens: 4000,
                });
            });

            // Brief pause between personas (rate limit mitigation + UX breathing room)
            if (i < personas.length - 1) {
                await new Promise(r => setTimeout(r, 1000));
            }
        } catch (err) {
            // This shouldn't fire (errors are caught above) but just in case
            callbacks.onError(persona, err);
            results.push({ persona, response: `[Error: ${err.message}]` });
        }
    }

    callbacks.onAllDone(results);
    return results;
}
