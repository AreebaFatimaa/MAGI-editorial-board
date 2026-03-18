// =============================================================================
// telemetry.js - Fire-and-Forget Analytics
//
// Sends session data to external endpoints without blocking the UI.
// Two tiers:
//   1. Lightweight step telemetry → Google Apps Script (metadata only)
//   2. Full session export → Vercel serverless function → Google Sheets
//
// API keys are NEVER included in telemetry payloads.
// =============================================================================

import { TELEMETRY_ENDPOINT, FULL_SESSION_ENDPOINT, SHEETS_EXPORT_ENDPOINT } from './config.js';
import { exportSession } from './state.js';

/**
 * Send lightweight per-step telemetry (metadata only, no content).
 * Fires after each step completes.
 */
export function sendStepTelemetry(session, step) {
    if (!TELEMETRY_ENDPOINT) return;

    const payload = {
        session_id: session.session_id,
        step,
        timestamp: new Date().toISOString(),
        board_size: session.personas?.length,
        models_used: session.personas?.map(p => p.model),
        key_source: session.steps?.[1]?.key_source,
        step_meta: session.steps?.[step],
    };

    fetch(TELEMETRY_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
    }).catch(() => {}); // silently fail
}

/**
 * Send full session data to the session storage endpoint.
 * Used for developer debug panel (viewing other users' sessions).
 * Includes persona responses and article title, but NEVER API keys.
 */
export function sendFullSession(session) {
    if (!FULL_SESSION_ENDPOINT) return;

    const payload = exportSession(session);
    // Explicitly strip any key that might have leaked into state
    delete payload.api_key;
    delete payload.apiKey;

    fetch(FULL_SESSION_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
    }).catch(() => {});
}

/**
 * Export session to Google Sheets via Vercel serverless function.
 * Fires after report synthesis completes.
 */
export function exportToSheets(session) {
    if (!SHEETS_EXPORT_ENDPOINT) return;

    const payload = exportSession(session);
    delete payload.api_key;
    delete payload.apiKey;

    fetch(SHEETS_EXPORT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    }).catch(() => {}); // silently fail
}

/**
 * Send all telemetry for a completed session.
 * Call this once after the report is generated.
 */
export function sendAllTelemetry(session) {
    sendStepTelemetry(session, 5);
    sendFullSession(session);
    exportToSheets(session);
}
