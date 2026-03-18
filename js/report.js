// =============================================================================
// report.js - Report Synthesis and Export
//
// FOR THE PYTHON PERSON:
// After the debate finishes, this module:
// 1. Sends all persona responses to one final LLM call for synthesis
// 2. Renders the markdown report as HTML
// 3. Handles file downloads (Markdown, JSON, CSV)
//
// The report template matches editorial-board.md Step 4 exactly.
// =============================================================================

import { chatCompletion } from './api.js';
import { SYNTHESIS_MODEL } from './config.js';

// =============================================================================
// MARKDOWN SANITIZATION
// =============================================================================
// LLM-generated content is rendered as HTML via marked.parse(). This is an XSS
// vector: a malicious or hijacked model could return <script>, <img onerror>,
// or other injection payloads. We configure marked to strip dangerous HTML.

/**
 * Sanitize HTML string by stripping all tags except a safe whitelist.
 * This runs AFTER marked converts markdown to HTML.
 */
function sanitizeHtml(html) {
    const ALLOWED_TAGS = new Set([
        'p', 'br', 'strong', 'em', 'b', 'i', 'u', 's', 'del',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
        'table', 'thead', 'tbody', 'tr', 'th', 'td',
        'hr', 'a', 'sup', 'sub',
    ]);
    const ALLOWED_ATTRS = { 'a': new Set(['href', 'title']) };

    const doc = new DOMParser().parseFromString(html, 'text/html');

    function walkAndClean(node) {
        const children = Array.from(node.childNodes);
        for (const child of children) {
            if (child.nodeType === Node.ELEMENT_NODE) {
                const tag = child.tagName.toLowerCase();
                if (!ALLOWED_TAGS.has(tag)) {
                    // Replace disallowed element with its text content
                    const text = document.createTextNode(child.textContent);
                    child.replaceWith(text);
                    continue;
                }
                // Strip disallowed attributes
                const allowedAttrs = ALLOWED_ATTRS[tag] || new Set();
                for (const attr of Array.from(child.attributes)) {
                    if (!allowedAttrs.has(attr.name)) {
                        child.removeAttribute(attr.name);
                    }
                }
                // For <a> tags, enforce safe href (no javascript: etc.)
                if (tag === 'a') {
                    const href = child.getAttribute('href') || '';
                    if (!href.startsWith('http://') && !href.startsWith('https://') && !href.startsWith('#')) {
                        child.removeAttribute('href');
                    }
                    child.setAttribute('rel', 'noopener noreferrer');
                    child.setAttribute('target', '_blank');
                }
                walkAndClean(child);
            }
        }
    }

    walkAndClean(doc.body);
    return doc.body.innerHTML;
}

/**
 * Parse markdown to sanitized HTML. Safe to use with innerHTML.
 * Falls back to escaped plaintext if marked is not loaded.
 */
export function safeMarkdown(markdown) {
    if (typeof marked === 'undefined') {
        // Fallback: escape and wrap in <pre>
        const div = document.createElement('div');
        div.textContent = markdown;
        return `<pre style="white-space: pre-wrap;">${div.innerHTML}</pre>`;
    }
    const rawHtml = marked.parse(markdown);
    return sanitizeHtml(rawHtml);
}

// =============================================================================
// REPORT TEMPLATE
// =============================================================================
// No date fields - the LLM was hallucinating dates from its training data.

const REPORT_TEMPLATE = `### EDITORIAL BOARD REPORT

**Story:** [headline/summary]
**Board Composition:** [all personas with stance and model]

**VERDICT:** [PUBLISH / HOLD / KILL / PUBLISH WITH CONDITIONS]

**Vote Tally:**
- For publication: X/N
- Against publication: X/N
- Neutral/Conditional: X/N

**Key Arguments For Publication:**
[strongest FOR arguments with specific reasoning - not summaries]

**Key Arguments Against Publication:**
[strongest AGAINST arguments with specific reasoning - not summaries]

**Framing Assessment (Primary Priority 1):**
Synthesize what ALL personas found regarding bias in the article's framing:
- Selective sourcing: [findings]
- Loaded language: [specific words/phrases identified]
- Analogy proportionality: [findings]
- Key omissions: [what's missing]
- Right of reply: [given/not given/pending]
- Overall framing verdict: [balanced / leans one direction / biased framing]

**Evidence Assessment (Primary Priority 2):**
List the article's major claims and evidence status:
- Claim 1: "[quote or paraphrase]" - Evidence: [supported/unsupported]
- Claim 2: "[quote or paraphrase]" - Evidence: [supported/unsupported]
- Characterizations flagged as inference: [list]
- Causal claims flagged as assumed: [list]
- Overall evidence verdict: [well-supported / partially supported / significant gaps]

**Standards Assessment:**
- Sourcing depth: [adequate/insufficient/strong]
- Harm assessment: [low/moderate/high/severe]
- Journalistic standards: [meets standards / falls short]

**Fault Lines:**
- Empirical disagreements (resolvable with evidence): [list]
- Values disagreements (irresolvable): [list]

**Conditions for Publication (if applicable):**
[specific changes/safeguards required]

**Dissenting Opinions:**
[strong minority views]

**Board Recommendation:**
[2-3 sentence final recommendation]`;

// =============================================================================
// SYNTHESIS
// =============================================================================

function buildSynthesisPrompt(articleTitle, articleText, debateResults) {
    const personaResponses = debateResults.map((r, i) => {
        return `--- PERSONA ${i + 1}: ${r.persona.role} (${r.persona.stance}) via ${r.persona.model} ---
${r.response}`;
    }).join('\n\n');

    const systemPrompt = `You are the editor-in-chief synthesizing an editorial board review.

You have received evaluations from ${debateResults.length} editorial board members. Your job is to synthesize their findings into a comprehensive editorial board report.

CRITICAL INSTRUCTIONS:
- Verdict reflects WEIGHT OF ARGUMENTS, not just vote count. A single devastating concern can override multiple publication votes.
- Framing and evidence come first (Primary Priorities 1 and 2).
- Be specific: point to particular claims, quotes, word choices, and omissions from the article.
- Capture disagreement honestly. The goal is NOT consensus.
- PUBLISH WITH CONDITIONS is rare - only for 1-2 specific fixable flaws. If concerns are structural, the verdict should be HOLD.
- Accuracy over balance. If evidence points one direction, say so. False equivalence is a journalistic failure.
- Do NOT include any dates in the report. No "Date of Review" field. No dates at all.

YOUR OUTPUT MUST FOLLOW THIS EXACT TEMPLATE:
${REPORT_TEMPLATE}

Fill in every bracket with actual content from the persona evaluations. Be thorough and specific.`;

    const userPrompt = `Article Title: ${articleTitle}

=== ARTICLE TEXT ===
${articleText}

=== EDITORIAL BOARD EVALUATIONS ===
${personaResponses}

Please synthesize these ${debateResults.length} evaluations into the editorial board report using the exact template format. Do NOT include any dates.`;

    return [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ];
}

export async function synthesizeReport(articleTitle, articleText, debateResults) {
    if (!debateResults || debateResults.length === 0) {
        throw new Error('No debate results to synthesize. Run the debate first.');
    }
    const messages = buildSynthesisPrompt(articleTitle, articleText, debateResults);
    const result = await chatCompletion(SYNTHESIS_MODEL, messages, {
        temperature: 0.3,
        max_tokens: 8000,
    });
    // Return content + metadata for state tracking
    return result;
}

// =============================================================================
// RENDERING
// =============================================================================

export function renderReport(markdown) {
    return safeMarkdown(markdown);
}

// =============================================================================
// FILE DOWNLOADS
// =============================================================================

function downloadFile(content, filename, mimeType) {
    if (!content) {
        console.warn('downloadFile called with empty content for', filename);
        return;
    }
    try {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // Delay revokeObjectURL to ensure download starts
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
        console.error('Download failed:', err);
        alert(`Download failed: ${err.message}`);
    }
}

export function downloadMarkdown(markdown, filename = 'editorial-board-report.md') {
    downloadFile(markdown, filename, 'text/markdown');
}

export function downloadJson(sessionData, filename = 'editorial-board-session.json') {
    downloadFile(JSON.stringify(sessionData, null, 2), filename, 'application/json');
}

// =============================================================================
// CSV EXPORT
// =============================================================================
// Exports the entire process: board constitution, debate transcript, and report.

/**
 * Escape a value for CSV. Wraps in quotes if it contains commas, quotes, or newlines.
 */
function csvEscape(val) {
    if (val == null) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

/**
 * Build a CSV string from the full session data.
 * The CSV has three sections separated by empty rows:
 * 1. BOARD CONSTITUTION - persona details
 * 2. DEBATE TRANSCRIPT - full responses
 * 3. EDITORIAL REPORT - the synthesis
 */
export function buildCsvExport(articleTitle, articleText, personas, debateResults, reportMarkdown, sessionState) {
    const rows = [];

    // Section 1: Board Constitution
    rows.push([csvEscape('=== BOARD CONSTITUTION ===')]);
    rows.push([csvEscape('Article Title'), csvEscape(articleTitle)]);
    rows.push([csvEscape('Article Text (first 500 chars)'), csvEscape((articleText || '').substring(0, 500))]);
    rows.push([]);
    rows.push([csvEscape('#'), csvEscape('Role'), csvEscape('Stance'), csvEscape('Model'), csvEscape('Editorial Lens')]);
    (personas || []).forEach((p, i) => {
        rows.push([
            csvEscape(i + 1),
            csvEscape(p.role),
            csvEscape(p.stance),
            csvEscape(p.model),
            csvEscape(p.editorial_lens),
        ]);
    });

    rows.push([]);
    rows.push([]);

    // Section 2: Debate Transcript (with metadata)
    rows.push([csvEscape('=== DEBATE TRANSCRIPT ===')]);
    rows.push([
        csvEscape('#'), csvEscape('Role'), csvEscape('Stance'), csvEscape('Model'),
        csvEscape('Prompt Tokens'), csvEscape('Completion Tokens'),
        csvEscape('Latency (s)'), csvEscape('Cost ($)'),
        csvEscape('Full Response'),
    ]);
    (debateResults || []).forEach((r, i) => {
        const meta = r.callMeta || r.call_meta || {};
        rows.push([
            csvEscape(i + 1),
            csvEscape(r.persona?.role),
            csvEscape(r.persona?.stance),
            csvEscape(r.persona?.model),
            csvEscape(meta.prompt_tokens || ''),
            csvEscape(meta.completion_tokens || ''),
            csvEscape(meta.latency_ms ? (meta.latency_ms / 1000).toFixed(1) : ''),
            csvEscape(meta.cost_usd ? meta.cost_usd.toFixed(6) : ''),
            csvEscape(r.response),
        ]);
    });

    rows.push([]);
    rows.push([]);

    // Section 3: Editorial Report
    rows.push([csvEscape('=== EDITORIAL REPORT ===')]);
    rows.push([csvEscape('Full Report')]);
    rows.push([csvEscape(reportMarkdown || '')]);

    rows.push([]);
    rows.push([]);

    // Section 4: Session Metadata
    if (sessionState) {
        rows.push([csvEscape('=== SESSION METADATA ===')]);
        rows.push([csvEscape('Session ID'), csvEscape(sessionState.session_id || '')]);
        rows.push([csvEscape('Created At'), csvEscape(sessionState.created_at || '')]);
        rows.push([csvEscape('Total Prompt Tokens'), csvEscape(sessionState.totals?.prompt_tokens || 0)]);
        rows.push([csvEscape('Total Completion Tokens'), csvEscape(sessionState.totals?.completion_tokens || 0)]);
        rows.push([csvEscape('Total Cost ($)'), csvEscape(sessionState.totals?.total_cost?.toFixed(6) || '0')]);
        rows.push([csvEscape('Total Duration (s)'), csvEscape(sessionState.totals?.total_latency_ms ? (sessionState.totals.total_latency_ms / 1000).toFixed(1) : '0')]);
        rows.push([csvEscape('Key Source'), csvEscape(sessionState.steps?.[1]?.key_source || 'unknown')]);
        rows.push([csvEscape('Synthesis Model'), csvEscape(sessionState.steps?.[5]?.synthesis_call?.model || '')]);
    }

    // Convert rows to CSV string
    return rows.map(row => row.join(',')).join('\n');
}

export function downloadCsv(csvContent, filename = 'editorial-board-export.csv') {
    downloadFile(csvContent, filename, 'text/csv');
}

/**
 * Get the CSV content as a string (for email attachment instructions).
 */
export function getCsvContent(articleTitle, articleText, personas, debateResults, reportMarkdown) {
    return buildCsvExport(articleTitle, articleText, personas, debateResults, reportMarkdown);
}
