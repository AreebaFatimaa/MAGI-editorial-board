// =============================================================================
// config.js - Application Configuration
//
// Centralized configuration for the MAGI Editorial Board.
// Default API key, synthesis model, board model families, and endpoints.
// =============================================================================

// Bring-your-own-key. Every user pastes their own OpenRouter key on
// screen 1; the key is held in memory only and never persisted.
export const DEFAULT_API_KEY = '';

// The model used for report synthesis (editor-in-chief). Always this model,
// regardless of what models are available on the user's key.
export const SYNTHESIS_MODEL = 'anthropic/claude-sonnet-4.6';

// Preferred model per family for the initial 8-persona board.
// Each persona gets a different family. Board size defaults to the number
// of available families from this list (capped at 8).
export const BOARD_MODEL_FAMILIES = [
    { family: 'openai',    model: 'openai/gpt-4o' },
    { family: 'x-ai',      model: 'x-ai/grok-3' },
    { family: 'mistralai', model: 'mistralai/mistral-large' },
    { family: 'amazon',    model: 'amazon/nova-pro-v1' },
    { family: 'qwen',      model: 'qwen/qwen-2.5-72b-instruct' },
    { family: 'nvidia',    model: 'nvidia/llama-3.1-nemotron-70b-instruct' },
    { family: 'anthropic', model: 'anthropic/claude-sonnet-4.6' },
    { family: 'google',    model: 'google/gemini-2.5-pro' },
];

// Telemetry endpoints — all telemetry goes through the Vercel serverless
// function to Google Sheets. No separate Apps Script needed.
export const TELEMETRY_ENDPOINT = ''; // Not used — Sheets export handles everything
export const FULL_SESSION_ENDPOINT = ''; // Not used — Sheets export handles everything

// Vercel serverless function for Google Sheets export
export const SHEETS_EXPORT_ENDPOINT = '/api/export-to-sheets';
