// =============================================================================
// api.js - OpenRouter API Client
//
// FOR THE PYTHON PERSON:
// This is like a requests.py wrapper. It handles ALL network communication
// with OpenRouter's API. Other modules never call fetch() for LLM work directly.
//
// OpenRouter's API is "OpenAI-compatible," meaning it uses the same request/
// response format as OpenAI's API (same JSON structure, same endpoints).
// This is great because tons of tools/libraries work with this format.
//
// KEY CONCEPTS:
// - fetch() = like requests.get()/requests.post() in Python
// - async/await = like Python's async/await (same idea, different syntax)
// - Promise = like Python's Future (a value that will arrive later)
// - ReadableStream = like iterating response.iter_lines() in Python
// =============================================================================

const BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes

// Module-level state (like a Python module-level variable)
let apiKey = null;

// Active AbortControllers for cancellation support
const activeControllers = new Set();

// =============================================================================
// API KEY MANAGEMENT
// =============================================================================

/**
 * Set the API key for all subsequent requests.
 * Also saves to localStorage so it persists across page reloads.
 *
 * localStorage is like a tiny database in the browser - it stores key/value
 * pairs that survive closing and reopening the tab. Think of it like a
 * persistent dict that lives in the browser.
 */
export function setApiKey(key) {
    apiKey = key;
    try {
        localStorage.setItem('openrouter_api_key', key);
    } catch (e) {
        // localStorage might be disabled (private browsing, etc.) - that's fine
        console.warn('Could not save API key to localStorage:', e);
    }
}

/**
 * Clear the API key from memory and localStorage.
 * Used when user clicks "Clear Key" to protect against shared computers.
 */
export function clearApiKey() {
    apiKey = null;
    try {
        localStorage.removeItem('openrouter_api_key');
    } catch (e) {
        // localStorage might be unavailable
    }
}

/**
 * Get the stored API key (from memory or localStorage).
 * Returns null if none is set.
 */
export function getApiKey() {
    if (apiKey) return apiKey;
    try {
        const saved = localStorage.getItem('openrouter_api_key');
        if (saved) {
            apiKey = saved;
            return saved;
        }
    } catch (e) {
        // localStorage might be unavailable
    }
    return null;
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/**
 * Build the standard headers for all OpenRouter requests.
 *
 * OpenRouter requires:
 * - Authorization: Your API key (like any API)
 * - Content-Type: We're sending JSON
 * - HTTP-Referer: Tells OpenRouter where the request comes from (for analytics)
 * - X-Title: A friendly name for your app (shows in OpenRouter dashboard)
 */
function buildHeaders() {
    if (!apiKey) {
        throw new Error('API key not set. Please enter your OpenRouter API key.');
    }
    return {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': window.location.origin || 'https://editorial-board.local',
        'X-Title': 'AI Editorial Board',
    };
}

/**
 * Create an AbortController with a timeout.
 * Automatically aborts after timeoutMs milliseconds.
 * Returns { controller, signal } for use with fetch.
 */
function createTimeoutController(timeoutMs = DEFAULT_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);
    activeControllers.add(controller);
    // Clean up timeout when the signal aborts (whether by timeout or manual cancel)
    controller.signal.addEventListener('abort', () => {
        clearTimeout(timeoutId);
        activeControllers.delete(controller);
    });
    return controller;
}

/**
 * Abort all active API requests.
 * Used when user navigates away mid-debate or cancels an operation.
 */
export function abortAllRequests() {
    for (const controller of activeControllers) {
        controller.abort(new Error('Request cancelled by user'));
    }
    activeControllers.clear();
}

/**
 * Parse an error response from OpenRouter into a human-readable message.
 * OpenRouter returns errors in various formats; this normalizes them.
 */
function parseApiError(status, body) {
    // Try to extract error message from response body
    if (body?.error?.message) return body.error.message;
    if (body?.error) return typeof body.error === 'string' ? body.error : JSON.stringify(body.error);

    // Fall back to status code mapping
    const statusMessages = {
        401: 'Invalid API key. Check your key at openrouter.ai/keys',
        402: 'Insufficient credits. Add credits at openrouter.ai/credits',
        403: 'Access denied. Your key may not have access to this model.',
        429: 'Rate limited. Too many requests - wait a moment and try again.',
        500: 'OpenRouter server error. Try again in a moment.',
        502: 'OpenRouter is temporarily unavailable. Try again.',
        503: 'OpenRouter is temporarily overloaded. Try again.',
    };
    return statusMessages[status] || `HTTP ${status}: Unknown error`;
}

// =============================================================================
// MODEL LISTING
// =============================================================================

/**
 * Validate the API key by fetching the model list.
 * This serves double duty: validates the key AND populates our model list.
 *
 * @returns {Object} { valid: boolean, models: Array, families: Array, error: string|null }
 *
 * The OpenRouter /models endpoint returns:
 * {
 *   data: [
 *     { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", context_length: 200000, ... },
 *     { id: "openai/gpt-4o", name: "GPT-4o", context_length: 128000, ... },
 *     ...
 *   ]
 * }
 */
export async function validateKeyAndFetchModels() {
    if (!apiKey) {
        return { valid: false, models: [], families: [], error: 'No API key provided.' };
    }

    const controller = createTimeoutController(30_000); // 30s timeout for validation

    try {
        const response = await fetch(`${BASE_URL}/models`, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
            },
            signal: controller.signal,
        });

        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            return { valid: false, models: [], families: [], error: parseApiError(response.status, body) };
        }

        const data = await response.json();
        const models = data.data || [];

        // Filter to chat-capable models (have reasonable context length)
        const chatModels = models
            .filter(m => m.context_length > 1000)
            .map(m => ({
                id: m.id,
                name: m.name || m.id,
                context_length: m.context_length,
                pricing: m.pricing,
            }))
            .sort((a, b) => a.id.localeCompare(b.id));

        // Extract unique model families
        // Family = the prefix before "/" in the model ID
        // e.g., "anthropic/claude-sonnet-4" → family is "anthropic"
        const families = [...new Set(chatModels.map(m => m.id.split('/')[0]))].sort();

        activeControllers.delete(controller);
        return { valid: true, models: chatModels, families, error: null };
    } catch (err) {
        activeControllers.delete(controller);
        if (err.name === 'AbortError') {
            return { valid: false, models: [], families: [], error: 'Validation request timed out. Try again.' };
        }
        return { valid: false, models: [], families: [], error: `Network error: ${err.message}` };
    }
}

// =============================================================================
// CHAT COMPLETION (Non-Streaming)
// =============================================================================

/**
 * Send a non-streaming chat completion request.
 * Used for: persona generation (Screen 3), report synthesis (Screen 5).
 *
 * @param {string} model - Model ID like "anthropic/claude-sonnet-4"
 * @param {Array} messages - Array of {role, content} message objects
 *   role is one of: "system", "user", "assistant"
 *   content is the text
 * @param {Object} options - Optional: { temperature, max_tokens }
 * @returns {string} The assistant's response text
 *
 * WHY non-streaming for some calls?
 * For persona generation and synthesis, we need the COMPLETE response before
 * we can parse/display it (it's JSON). Streaming adds complexity with no
 * benefit when the output isn't shown incrementally.
 */
export async function chatCompletion(model, messages, options = {}) {
    const controller = createTimeoutController(options.timeoutMs);

    const response = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: buildHeaders(),
        signal: controller.signal,
        body: JSON.stringify({
            model,
            messages,
            temperature: options.temperature ?? 0.7,
            ...(options.max_tokens && { max_tokens: options.max_tokens }),
        }),
    });

    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(parseApiError(response.status, body));
    }

    const data = await response.json();
    activeControllers.delete(controller);

    // The response format matches OpenAI's:
    // { choices: [{ message: { role: "assistant", content: "..." } }] }
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
        throw new Error('Empty response from model. The model may be overloaded - try again.');
    }

    return content;
}

// =============================================================================
// CHAT COMPLETION (Streaming)
// =============================================================================

/**
 * Send a STREAMING chat completion request.
 * Used for: the debate (Screen 4), where each token appears in real-time.
 *
 * BACKGROUND FOR PYTHON PEOPLE:
 * In Python, you'd iterate over response lines with:
 *   for line in response.iter_lines():
 *       data = json.loads(line)
 *
 * In browser JavaScript, the equivalent uses ReadableStream. You get a "reader"
 * that yields Uint8Array chunks (raw bytes), which you decode to text.
 * The tricky part: chunks DON'T align with line boundaries, so you need a buffer.
 *
 * SSE (Server-Sent Events) format:
 *   Each event is a line starting with "data: " followed by JSON.
 *   Events are separated by blank lines.
 *   The stream ends with "data: [DONE]".
 *   OpenRouter also sends ":" comment lines as keepalives - we ignore these.
 *
 * @param {string} model - Model ID
 * @param {Array} messages - Message array
 * @param {Object} callbacks:
 *   - onToken(string): called with each text chunk as it arrives
 *   - onDone(): called when stream completes
 *   - onError(Error): called if an error occurs
 * @param {Object} options - Optional: { temperature, max_tokens }
 */
export async function streamChatCompletion(model, messages, { onToken, onDone, onError, ...options }) {
    const controller = createTimeoutController(options.timeoutMs || 300_000); // 5min for streaming

    try {
        const response = await fetch(`${BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: buildHeaders(),
            signal: controller.signal,
            body: JSON.stringify({
                model,
                messages,
                stream: true,    // This enables streaming
                temperature: options.temperature ?? 0.7,
                ...(options.max_tokens && { max_tokens: options.max_tokens }),
            }),
        });

        // Check for HTTP-level errors BEFORE trying to read the stream
        if (!response.ok) {
            const errorBody = await response.json().catch(() => ({}));
            throw new Error(parseApiError(response.status, errorBody));
        }

        // Guard against missing response body (should not happen, but defensive)
        if (!response.body) {
            throw new Error('Streaming not supported by this browser or response has no body.');
        }

        // Get the ReadableStream reader.
        const reader = response.body.getReader();

        // TextDecoder converts raw bytes (Uint8Array) to strings.
        // { stream: true } in decode() handles multi-byte characters (emoji, CJK)
        // that might be split across network chunks.
        const decoder = new TextDecoder();

        // Buffer for incomplete lines.
        // WHY: A network chunk might end mid-line: "data: {\"ch"
        // The next chunk completes it: "oices\":[...]}\n"
        // We accumulate in the buffer until we hit a newline.
        let buffer = '';

        while (true) {
            // Read the next chunk from the stream
            // `done` = true when the server closes the connection
            // `value` = Uint8Array of raw bytes
            const { done, value } = await reader.read();

            if (done) {
                // Server closed the connection
                activeControllers.delete(controller);
                onDone();
                return;
            }

            // Decode bytes to text and add to buffer
            buffer += decoder.decode(value, { stream: true });

            // Split buffer into lines. SSE lines end with \n.
            const lines = buffer.split('\n');

            // The LAST element might be incomplete - keep it in the buffer.
            // If the chunk ended with \n, the last element is '' (which is fine).
            buffer = lines.pop();

            for (const line of lines) {
                const trimmed = line.trim();

                // Skip empty lines (SSE event separators)
                if (!trimmed) continue;

                // Skip SSE comments (keepalives from OpenRouter like ": OPENROUTER PROCESSING")
                if (trimmed.startsWith(':')) continue;

                // We only care about "data: " lines
                if (!trimmed.startsWith('data: ')) continue;

                // Extract the JSON after "data: "
                const jsonStr = trimmed.slice(6);  // "data: ".length === 6

                // Check for the end-of-stream signal
                if (jsonStr === '[DONE]') {
                    activeControllers.delete(controller);
                    onDone();
                    return;
                }

                // Parse the JSON chunk
                let chunk;
                try {
                    chunk = JSON.parse(jsonStr);
                } catch (parseError) {
                    // Malformed JSON - skip silently. This can happen with
                    // partial data or non-standard SSE from some providers.
                    console.warn('Failed to parse SSE chunk:', jsonStr);
                    continue;
                }

                // Handle streaming error objects from OpenRouter
                if (chunk.error) {
                    throw new Error(chunk.error.message || JSON.stringify(chunk.error));
                }

                // In streaming, content arrives in choices[0].delta.content
                // (NOT choices[0].message.content like non-streaming)
                const token = chunk.choices?.[0]?.delta?.content;
                if (token) {
                    onToken(token);
                }
            }
        }
    } catch (error) {
        activeControllers.delete(controller);
        // Distinguish abort/timeout from other errors
        if (error.name === 'AbortError') {
            const abortError = new Error('Request was cancelled or timed out.');
            abortError.name = 'AbortError';
            if (onError) { onError(abortError); } else { throw abortError; }
            return;
        }
        if (onError) {
            onError(error);
        } else {
            throw error;
        }
    }
}
