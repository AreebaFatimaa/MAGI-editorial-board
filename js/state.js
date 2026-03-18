// =============================================================================
// state.js - Session State Model
//
// Tracks everything about a session: timestamps, API call metadata (tokens,
// cost, latency), persona data, debate results, errors. The entire state is
// serializable (JSON export) and hydratable (JSON import to restore any step).
// =============================================================================

const STORAGE_KEY = 'magi_session';
const SCHEMA_VERSION = 1;

// Pricing lookup map — populated after model list is fetched
let pricingMap = {};

// =============================================================================
// SESSION CREATION
// =============================================================================

/**
 * Create a fresh session object.
 */
export function createSession() {
    return {
        schema_version: SCHEMA_VERSION,
        session_id: crypto.randomUUID(),
        created_at: new Date().toISOString(),

        current_step: 1,
        steps: {
            1: { entered_at: null, completed_at: null, key_source: null },
            2: { entered_at: null, completed_at: null, article_chars: 0, article_source: null },
            3: { entered_at: null, completed_at: null, board_size: 0, generation_call: null },
            4: { entered_at: null, completed_at: null, debate_calls: [] },
            5: { entered_at: null, completed_at: null, synthesis_call: null },
        },

        article: { title: '', text: '', char_count: 0 },
        personas: [],
        debate_results: [],
        report: { markdown: '', verdict: '' },

        errors: [],
        totals: { prompt_tokens: 0, completion_tokens: 0, total_cost: 0, total_latency_ms: 0 },
    };
}

// =============================================================================
// STEP TRACKING
// =============================================================================

/**
 * Record entry into a step.
 */
export function recordStepEntry(session, step) {
    if (session.steps[step]) {
        session.steps[step].entered_at = new Date().toISOString();
    }
    session.current_step = step;
}

/**
 * Record completion of a step.
 */
export function recordStepCompletion(session, step) {
    if (session.steps[step]) {
        session.steps[step].completed_at = new Date().toISOString();
    }
}

// =============================================================================
// CALL METADATA
// =============================================================================

/**
 * Create a call_meta object. Call this before an API call to get the start time.
 */
export function startCallMeta(model, streaming = false) {
    return {
        call_id: crypto.randomUUID(),
        model,
        started_at: new Date().toISOString(),
        finished_at: null,
        latency_ms: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cost_usd: 0,
        error: null,
        streaming,
    };
}

/**
 * Finalize a call_meta object with usage data from the API response.
 */
export function finishCallMeta(callMeta, usage = {}) {
    callMeta.finished_at = new Date().toISOString();
    callMeta.latency_ms = new Date(callMeta.finished_at) - new Date(callMeta.started_at);
    callMeta.prompt_tokens = usage.prompt_tokens || 0;
    callMeta.completion_tokens = usage.completion_tokens || 0;
    callMeta.total_tokens = usage.total_tokens || (callMeta.prompt_tokens + callMeta.completion_tokens);
    callMeta.cost_usd = calculateCost(callMeta.model, callMeta.prompt_tokens, callMeta.completion_tokens);
    return callMeta;
}

/**
 * Mark a call_meta as failed.
 */
export function failCallMeta(callMeta, errorMessage) {
    callMeta.finished_at = new Date().toISOString();
    callMeta.latency_ms = new Date(callMeta.finished_at) - new Date(callMeta.started_at);
    callMeta.error = errorMessage;
    return callMeta;
}

/**
 * Attach call metadata to the appropriate step in the session.
 */
export function recordCallMeta(session, step, callMeta) {
    if (step === 3) {
        session.steps[3].generation_call = callMeta;
    } else if (step === 4) {
        session.steps[4].debate_calls.push(callMeta);
    } else if (step === 5) {
        session.steps[5].synthesis_call = callMeta;
    }
}

// =============================================================================
// ERROR TRACKING
// =============================================================================

/**
 * Record an error in the session.
 */
export function recordError(session, step, message, model = null, raw = null) {
    session.errors.push({
        step,
        timestamp: new Date().toISOString(),
        message,
        model,
        raw: raw ? String(raw).substring(0, 1000) : null,
    });
}

// =============================================================================
// COST CALCULATION
// =============================================================================

/**
 * Set the pricing map from the models list returned by OpenRouter.
 * Call this after validateKeyAndFetchModels().
 *
 * @param {Array} models - Array of model objects with { id, pricing: { prompt, completion } }
 */
export function setPricingMap(models) {
    pricingMap = {};
    for (const m of models) {
        if (m.pricing) {
            pricingMap[m.id] = m.pricing;
        }
    }
}

/**
 * Calculate cost in USD for a given model and token counts.
 * Pricing is per-token (as strings from OpenRouter).
 */
export function calculateCost(modelId, promptTokens, completionTokens) {
    const pricing = pricingMap[modelId];
    if (!pricing) return 0;
    const promptCost = promptTokens * parseFloat(pricing.prompt || '0');
    const completionCost = completionTokens * parseFloat(pricing.completion || '0');
    return promptCost + completionCost;
}

// =============================================================================
// TOTALS
// =============================================================================

/**
 * Recompute session totals from all recorded call metadata.
 */
export function computeTotals(session) {
    let prompt_tokens = 0;
    let completion_tokens = 0;
    let total_cost = 0;
    let total_latency_ms = 0;

    const allCalls = getAllCallMetas(session);
    for (const cm of allCalls) {
        prompt_tokens += cm.prompt_tokens || 0;
        completion_tokens += cm.completion_tokens || 0;
        total_cost += cm.cost_usd || 0;
        total_latency_ms += cm.latency_ms || 0;
    }

    session.totals = { prompt_tokens, completion_tokens, total_cost, total_latency_ms };
    return session.totals;
}

/**
 * Collect all call_meta objects across all steps.
 */
export function getAllCallMetas(session) {
    const calls = [];
    if (session.steps[3]?.generation_call) calls.push(session.steps[3].generation_call);
    if (session.steps[4]?.debate_calls) calls.push(...session.steps[4].debate_calls);
    if (session.steps[5]?.synthesis_call) calls.push(session.steps[5].synthesis_call);
    return calls;
}

// =============================================================================
// SERIALIZATION / HYDRATION
// =============================================================================

/**
 * Export the full session as a plain JSON-serializable object.
 */
export function exportSession(session) {
    computeTotals(session);
    return JSON.parse(JSON.stringify(session));
}

/**
 * Validate and hydrate a session from imported JSON.
 * Returns the session object if valid, or throws an error.
 */
export function hydrateSession(json) {
    if (!json || !json.session_id) {
        throw new Error('Invalid session data: missing session_id');
    }
    if (json.schema_version && json.schema_version > SCHEMA_VERSION) {
        throw new Error(`Session schema version ${json.schema_version} is newer than supported (${SCHEMA_VERSION})`);
    }
    // Ensure all expected fields exist with defaults
    const session = createSession();
    return deepMerge(session, json);
}

/**
 * Deep merge source into target. Source values take precedence.
 */
function deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
        if (source[key] !== null && typeof source[key] === 'object' && !Array.isArray(source[key])
            && target[key] !== null && typeof target[key] === 'object' && !Array.isArray(target[key])) {
            result[key] = deepMerge(target[key], source[key]);
        } else {
            result[key] = source[key];
        }
    }
    return result;
}

// =============================================================================
// LOCAL STORAGE PERSISTENCE
// =============================================================================

/**
 * Save session to localStorage.
 */
export function persistToLocalStorage(session) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(exportSession(session)));
    } catch (e) {
        console.warn('Could not persist session to localStorage:', e);
    }
}

/**
 * Load session from localStorage. Returns null if none exists.
 */
export function loadFromLocalStorage() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        return hydrateSession(JSON.parse(raw));
    } catch (e) {
        console.warn('Could not load session from localStorage:', e);
        return null;
    }
}

/**
 * Clear session from localStorage.
 */
export function clearLocalStorage() {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
        // ignore
    }
}
