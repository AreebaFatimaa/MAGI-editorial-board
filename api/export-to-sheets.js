// =============================================================================
// Vercel Serverless Function — Google Sheets Export
// POST /api/export-to-sheets
//
// Receives session JSON from the frontend, appends rows to a Google Sheet.
// Uses a Google service account for authentication.
// No user API keys ever touch this function.
//
// Required Vercel environment variables:
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_PRIVATE_KEY
//   GOOGLE_SPREADSHEET_ID
// =============================================================================

import { google } from 'googleapis';

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    // Check env vars
    const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const privateKey = process.env.GOOGLE_PRIVATE_KEY;
    const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

    if (!email || !privateKey || !spreadsheetId) {
        return res.status(500).json({ error: 'Google Sheets credentials not configured' });
    }

    try {
        const session = req.body;
        if (!session?.session_id) {
            return res.status(400).json({ error: 'Invalid session data: missing session_id' });
        }

        // Authenticate with Google via service account JWT
        const auth = new google.auth.JWT(
            email,
            null,
            privateKey.replace(/\\n/g, '\n'),
            ['https://www.googleapis.com/auth/spreadsheets']
        );

        const sheets = google.sheets({ version: 'v4', auth });

        // --- TAB 1: Sessions (one row per session) ---
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: 'Sessions!A:L',
            valueInputOption: 'RAW',
            requestBody: {
                values: [[
                    session.session_id,
                    session.created_at,
                    session.article?.title || '',
                    session.personas?.length || 0,
                    (session.personas || []).map(p => p.model).join(', '),
                    session.totals?.prompt_tokens || 0,
                    session.totals?.completion_tokens || 0,
                    session.totals?.total_cost || 0,
                    session.totals?.total_latency_ms || 0,
                    session.report?.verdict || '',
                    session.errors?.length || 0,
                    session.steps?.[1]?.key_source || 'unknown',
                ]],
            },
        });

        // --- TAB 2: Personas (one row per persona per session) ---
        const personaRows = (session.debate_results || []).map((dr, i) => [
            session.session_id,
            session.created_at,
            i + 1,
            dr.persona?.role || session.personas?.[i]?.role || '',
            dr.persona?.stance || session.personas?.[i]?.stance || '',
            dr.persona?.model || session.personas?.[i]?.model || '',
            dr.call_meta?.prompt_tokens || 0,
            dr.call_meta?.completion_tokens || 0,
            dr.call_meta?.latency_ms || 0,
            dr.call_meta?.cost_usd || 0,
            dr.call_meta?.error || '',
            dr.response || '',
        ]);

        if (personaRows.length > 0) {
            await sheets.spreadsheets.values.append({
                spreadsheetId,
                range: 'Personas!A:L',
                valueInputOption: 'RAW',
                requestBody: { values: personaRows },
            });
        }

        // --- TAB 3: Reports (one row per session) ---
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: 'Reports!A:D',
            valueInputOption: 'RAW',
            requestBody: {
                values: [[
                    session.session_id,
                    session.created_at,
                    session.article?.title || '',
                    session.report?.markdown || '',
                ]],
            },
        });

        return res.status(200).json({ success: true, session_id: session.session_id });
    } catch (err) {
        console.error('Sheets export failed:', err);
        return res.status(500).json({ error: err.message });
    }
}
