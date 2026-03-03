// =============================================================================
// app.js - Main Application Controller
// MAGI - AI-POWERED EDITORIAL BOARD
// =============================================================================

import { setApiKey, getApiKey, clearApiKey, validateKeyAndFetchModels, abortAllRequests } from './api.js';
import { parseArticle } from './parser.js';
import {
    generatePersonas, assignModels, validateBoard,
    runDebate, buildEvaluationPrompt
} from './board.js';
import {
    synthesizeReport, renderReport,
    downloadMarkdown, downloadJson,
    downloadCsv, buildCsvExport,
    safeMarkdown
} from './report.js';

// =============================================================================
// SHARED APPLICATION STATE
// =============================================================================

const appState = {
    apiKey: null,
    availableModels: [],
    modelFamilies: [],
    articleTitle: '',
    articleText: '',
    articleFile: null,
    personas: [],
    debateResults: [],
    reportMarkdown: '',
    currentScreen: 1,
};

const SCREEN_IDS = {
    1: 'apikey',
    2: 'article',
    3: 'board',
    4: 'debate',
    5: 'report',
};

// =============================================================================
// SCREEN NAVIGATION
// =============================================================================

function navigateTo(screenNum) {
    // If leaving the debate or board generation screen mid-operation, abort pending API calls
    if ((appState.currentScreen === 4 || appState.currentScreen === 3) && screenNum < appState.currentScreen) {
        abortAllRequests();
    }

    document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));

    const targetId = `screen-${SCREEN_IDS[screenNum]}`;
    const target = document.getElementById(targetId);
    if (target) target.classList.add('active');

    // Update step indicator
    document.querySelectorAll('#step-indicator .step').forEach(stepEl => {
        const stepNum = parseInt(stepEl.dataset.step);
        stepEl.classList.remove('active', 'completed');
        if (stepNum === screenNum) stepEl.classList.add('active');
        else if (stepNum < screenNum) stepEl.classList.add('completed');
    });

    // Update connectors
    document.querySelectorAll('#step-indicator .step-connector').forEach((conn, index) => {
        if (index + 2 <= screenNum) conn.classList.add('completed');
        else conn.classList.remove('completed');
    });

    // Update header status
    const statusLabels = { 1: 'AUTHENTICATING', 2: 'DATA INPUT', 3: 'BOARD CONFIG', 4: 'LIVE DEBATE', 5: 'REPORT READY' };
    const headerStatus = document.getElementById('header-status');
    if (headerStatus) headerStatus.textContent = statusLabels[screenNum] || 'STANDBY';

    appState.currentScreen = screenNum;
    window.scrollTo(0, 0);
}

// =============================================================================
// SCREEN 1: API KEY
// =============================================================================

function setupScreen1() {
    const keyInput = document.getElementById('api-key-input');
    const validateBtn = document.getElementById('validate-btn');
    const statusDiv = document.getElementById('key-status');
    const toggleBtn = document.getElementById('toggle-key-visibility');
    const nextBtn = document.getElementById('goto-article-btn');

    const clearBtn = document.getElementById('clear-key-btn');

    const savedKey = getApiKey();
    if (savedKey) {
        keyInput.value = savedKey;
        clearBtn.style.display = 'inline-block';
    }

    toggleBtn.addEventListener('click', () => {
        keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
    });

    clearBtn.addEventListener('click', () => {
        clearApiKey();
        keyInput.value = '';
        clearBtn.style.display = 'none';
        nextBtn.style.display = 'none';
        showStatus(statusDiv, 'API KEY CLEARED FROM BROWSER', 'info');
    });

    validateBtn.addEventListener('click', async () => {
        const key = keyInput.value.trim();
        if (!key) {
            showStatus(statusDiv, 'ENTER API KEY', 'error');
            return;
        }

        showStatus(statusDiv, 'VALIDATING CONNECTION...', 'info');
        validateBtn.disabled = true;
        setApiKey(key);

        try {
            const result = await validateKeyAndFetchModels();
            if (result.valid) {
                appState.apiKey = key;
                appState.availableModels = result.models;
                appState.modelFamilies = result.families;
                showStatus(statusDiv,
                    `CONNECTED // ${result.models.length} models // ${result.families.length} families: ${result.families.join(', ')}`,
                    'success'
                );
                nextBtn.style.display = 'block';
                clearBtn.style.display = 'inline-block';
            } else {
                showStatus(statusDiv, `ERROR: ${result.error}`, 'error');
            }
        } catch (err) {
            showStatus(statusDiv, `CONNECTION FAILED: ${err.message}`, 'error');
        } finally {
            validateBtn.disabled = false;
        }
    });

    nextBtn.addEventListener('click', () => navigateTo(2));
}

// =============================================================================
// SCREEN 2: ARTICLE INPUT
// =============================================================================

function setupScreen2() {
    const tabs = document.querySelectorAll('.tab');
    const tabContents = document.querySelectorAll('.tab-content');
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const fileInfo = document.getElementById('file-info');
    const pasteArea = document.getElementById('paste-area');
    const titleInput = document.getElementById('article-title');
    const previewArea = document.getElementById('article-preview');
    const previewText = document.getElementById('preview-text');
    const statusDiv = document.getElementById('article-status');
    const analyzeBtn = document.getElementById('analyze-btn');
    const backBtn = document.getElementById('back-to-key-btn');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tabContents.forEach(tc => tc.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
        });
    });

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });

    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileInput.click();
        }
    });
    fileInput.addEventListener('change', () => {
        if (fileInput.files[0]) handleFile(fileInput.files[0]);
    });

    function handleFile(file) {
        const ext = file.name.split('.').pop().toLowerCase();
        if (!['docx', 'pdf'].includes(ext)) {
            showStatus(statusDiv, `UNSUPPORTED FILE: .${ext} // USE .docx OR .pdf`, 'error');
            return;
        }
        appState.articleFile = file;
        fileInfo.style.display = 'block';
        fileInfo.textContent = `LOADED: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
        showStatus(statusDiv, '', '');
    }

    // Live character count for paste area
    const charCount = document.getElementById('char-count');
    pasteArea.addEventListener('input', () => {
        const len = pasteArea.value.length;
        const words = pasteArea.value.trim() ? pasteArea.value.trim().split(/\s+/).length : 0;
        charCount.textContent = `${len.toLocaleString()} characters (~${words.toLocaleString()} words)`;
        if (len > 60000) {
            charCount.classList.add('warning');
            charCount.textContent += ' — article will be truncated for analysis';
        } else {
            charCount.classList.remove('warning');
        }
    });

    backBtn.addEventListener('click', () => navigateTo(1));

    analyzeBtn.addEventListener('click', async () => {
        const activeTab = document.querySelector('.tab.active').dataset.tab;
        const pastedText = activeTab === 'paste' ? pasteArea.value : null;
        const file = activeTab === 'upload' ? appState.articleFile : null;

        if (!file && (!pastedText || !pastedText.trim())) {
            showStatus(statusDiv, 'NO INPUT DETECTED // UPLOAD FILE OR PASTE TEXT', 'error');
            return;
        }

        showStatus(statusDiv, 'PARSING ARTICLE...', 'info');
        analyzeBtn.disabled = true;

        try {
            const text = await parseArticle(file, pastedText);
            if (!text || text.trim().length < 50) {
                showStatus(statusDiv, 'ARTICLE TOO SHORT // PROVIDE FULL TEXT', 'error');
                analyzeBtn.disabled = false;
                return;
            }

            appState.articleText = text;
            appState.articleTitle = titleInput.value.trim() || 'Untitled Article';

            previewArea.style.display = 'block';
            const truncated = text.length > 500 ? text.substring(0, 500) + '...' : text;
            previewText.textContent = truncated;

            const truncWarning = text.length > 60000
                ? ` // WARNING: Article exceeds 60,000 chars — analysis will use first ~15,000 words`
                : '';
            showStatus(statusDiv, `EXTRACTED ${text.length} CHARS${truncWarning} // INITIALIZING BOARD...`, text.length > 60000 ? 'info' : 'success');

            setTimeout(() => {
                navigateTo(3);
                startBoardGeneration();
            }, 800);
        } catch (err) {
            showStatus(statusDiv, `PARSE ERROR: ${err.message}`, 'error');
        } finally {
            analyzeBtn.disabled = false;
        }
    });
}

// =============================================================================
// SCREEN 3: BOARD CONFIGURATION
// =============================================================================

function setupScreen3() {
    const backBtn = document.getElementById('back-to-article-btn');
    const startBtn = document.getElementById('start-debate-btn');
    const addBtn = document.getElementById('add-persona-btn');
    const validationDiv = document.getElementById('board-validation');

    backBtn.addEventListener('click', () => navigateTo(2));

    startBtn.addEventListener('click', () => {
        syncPersonasFromDOM();
        const result = validateBoard(appState.personas);
        if (!result.valid) {
            showStatus(validationDiv, result.errors.join(' // '), 'error');
            return;
        }
        if (result.errors.length > 0) {
            showStatus(validationDiv, result.errors.join(' // '), 'info');
        }
        navigateTo(4);
        startDebate();
    });

    addBtn.addEventListener('click', () => {
        if (appState.personas.length >= 8) return;
        syncPersonasFromDOM();
        appState.personas.push({
            role: 'New Unit',
            stance: 'NEUTRAL',
            model: appState.availableModels[0]?.id || '',
            editorial_lens: 'Define editorial perspective...',
            stance_prompt: '',
            red_lines: '',
        });
        renderPersonaCards();
    });
}

async function startBoardGeneration() {
    const loadingDiv = document.getElementById('board-loading');
    const container = document.getElementById('persona-container');
    const addBtn = document.getElementById('add-persona-btn');
    const buttons = document.getElementById('board-buttons');

    loadingDiv.style.display = 'block';
    container.style.display = 'none';
    addBtn.style.display = 'none';
    buttons.style.display = 'none';

    try {
        const personas = await generatePersonas(appState.articleText, appState.availableModels);
        appState.personas = personas;

        loadingDiv.style.display = 'none';
        container.style.display = 'block';
        addBtn.style.display = 'block';
        buttons.style.display = 'flex';

        renderPersonaCards();
    } catch (err) {
        loadingDiv.textContent = '';
        const errorP = document.createElement('p');
        errorP.style.color = 'var(--neon-red)';
        errorP.textContent = `BOARD GENERATION FAILED: ${err.message}`;
        const retryBtn = document.createElement('button');
        retryBtn.className = 'btn-secondary';
        retryBtn.textContent = 'RETRY';
        retryBtn.addEventListener('click', () => startBoardGeneration());
        loadingDiv.appendChild(errorP);
        loadingDiv.appendChild(retryBtn);
    }
}

function renderPersonaCards() {
    const container = document.getElementById('persona-container');
    container.innerHTML = '';

    appState.personas.forEach((persona, index) => {
        const card = document.createElement('div');
        const stanceClass = `stance-${persona.stance.toLowerCase()}`;
        card.className = `persona-card ${stanceClass}`;
        card.dataset.index = index;

        const modelOptions = buildModelOptions(persona.model);

        card.innerHTML = `
            <div class="persona-header">
                <span class="persona-number">${String(index + 1).padStart(2, '0')}</span>
                <input type="text" class="persona-role" value="${escapeHtml(persona.role)}"
                       data-index="${index}" placeholder="Role designation">
                <button class="btn-remove" data-index="${index}"
                        ${appState.personas.length <= 3 ? 'disabled' : ''}>REMOVE</button>
            </div>
            <div class="persona-fields">
                <label>STANCE
                    <select class="persona-stance" data-index="${index}">
                        <option value="FOR" ${persona.stance === 'FOR' ? 'selected' : ''}>FOR publication</option>
                        <option value="AGAINST" ${persona.stance === 'AGAINST' ? 'selected' : ''}>AGAINST publication</option>
                        <option value="NEUTRAL" ${persona.stance === 'NEUTRAL' ? 'selected' : ''}>NEUTRAL</option>
                    </select>
                </label>
                <label>MODEL
                    <select class="persona-model" data-index="${index}">
                        ${modelOptions}
                    </select>
                </label>
                <label class="full-width">EDITORIAL LENS
                    <textarea class="persona-lens" data-index="${index}"
                              rows="2">${escapeHtml(persona.editorial_lens)}</textarea>
                </label>
            </div>
        `;
        container.appendChild(card);
    });

    container.querySelectorAll('.btn-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.index);
            syncPersonasFromDOM();
            appState.personas.splice(idx, 1);
            renderPersonaCards();
        });
    });
}

function buildModelOptions(selectedModel) {
    const families = {};
    appState.availableModels.forEach(m => {
        const family = m.id.split('/')[0];
        if (!families[family]) families[family] = [];
        families[family].push(m);
    });

    let html = '';
    for (const [family, models] of Object.entries(families).sort()) {
        html += `<optgroup label="${escapeHtml(family)}">`;
        models.forEach(m => {
            const selected = m.id === selectedModel ? 'selected' : '';
            html += `<option value="${escapeHtml(m.id)}" ${selected}>${escapeHtml(m.id)}</option>`;
        });
        html += '</optgroup>';
    }
    return html;
}

function syncPersonasFromDOM() {
    const container = document.getElementById('persona-container');
    if (!container) return;

    container.querySelectorAll('.persona-card').forEach((card, index) => {
        if (appState.personas[index]) {
            appState.personas[index].role = card.querySelector('.persona-role').value;
            appState.personas[index].stance = card.querySelector('.persona-stance').value;
            appState.personas[index].model = card.querySelector('.persona-model').value;
            appState.personas[index].editorial_lens = card.querySelector('.persona-lens').value;
        }
    });
}

// =============================================================================
// SCREEN 4: DEBATE
// =============================================================================

function setupScreen4() {
    document.getElementById('generate-report-btn').addEventListener('click', () => {
        navigateTo(5);
        startReportGeneration();
    });
}

async function startDebate() {
    const messagesDiv = document.getElementById('chat-messages');
    const typingDiv = document.getElementById('typing-indicator');
    const typingName = document.getElementById('typing-name');
    const chatTitle = document.getElementById('chat-title');
    const chatSubtitle = document.getElementById('chat-subtitle');
    const reportBtn = document.getElementById('generate-report-btn');
    const statusDiv = document.getElementById('debate-status');

    messagesDiv.innerHTML = '';
    reportBtn.style.display = 'none';
    showStatus(statusDiv, '', '');

    chatTitle.textContent = appState.articleTitle;
    chatSubtitle.textContent = `${appState.personas.length} UNITS ENGAGED`;

    addSystemMessage(messagesDiv, 'EDITORIAL BOARD DEBATE INITIATED // ALL UNITS REVIEWING ARTICLE');

    let currentBubble = null;

    // Throttle scroll updates during streaming to avoid layout thrashing.
    // requestAnimationFrame ensures at most one scroll per frame (~60/sec).
    let scrollPending = false;
    function scheduleScroll() {
        if (scrollPending) return;
        scrollPending = true;
        requestAnimationFrame(() => {
            const container = document.getElementById('chat-container');
            if (container) container.scrollTop = container.scrollHeight;
            scrollPending = false;
        });
    }

    try {
        await runDebate(appState.personas, appState.articleText, {
            onPersonaStart: (persona, index) => {
                typingDiv.style.display = 'flex';
                typingName.textContent = `${persona.role} // EVALUATING (${index + 1}/${appState.personas.length})`;

                // Update subtitle with progress
                chatSubtitle.textContent = `UNIT ${index + 1} OF ${appState.personas.length} ACTIVE`;

                currentBubble = createChatBubble(persona, index);
                messagesDiv.appendChild(currentBubble);
            },

            onToken: (persona, token) => {
                if (!currentBubble) return;
                const content = currentBubble.querySelector('.bubble-content');
                content.textContent += token;
                scheduleScroll();
            },

            onPersonaDone: (persona, fullResponse) => {
                typingDiv.style.display = 'none';

                if (currentBubble) {
                    const content = currentBubble.querySelector('.bubble-content');
                    content.innerHTML = safeMarkdown(fullResponse);

                    const time = document.createElement('div');
                    time.className = 'bubble-time';
                    time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    currentBubble.appendChild(time);

                    const model = document.createElement('div');
                    model.className = 'bubble-model';
                    model.textContent = `VIA ${persona.model}`;
                    currentBubble.appendChild(model);
                }

                scheduleScroll();
            },

            onAllDone: (results) => {
                appState.debateResults = results;
                addSystemMessage(messagesDiv, `ALL ${results.length} UNITS COMPLETE // READY FOR SYNTHESIS`);
                reportBtn.style.display = 'block';

                scheduleScroll();
            },

            onError: (persona, error) => {
                typingDiv.style.display = 'none';
                if (currentBubble) {
                    const content = currentBubble.querySelector('.bubble-content');
                    content.innerHTML = `<em style="color: var(--neon-red);">ERROR: ${escapeHtml(error.message)}</em>`;
                }
            },
        });
    } catch (err) {
        showStatus(statusDiv, `DEBATE FAILED: ${err.message}`, 'error');
    }
}

function createChatBubble(persona, colorIndex) {
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble persona-color-${colorIndex % 8}`;

    const header = document.createElement('div');
    header.className = 'bubble-header';
    header.textContent = `@${persona.role} [${persona.stance}]`;

    const content = document.createElement('div');
    content.className = 'bubble-content';

    bubble.appendChild(header);
    bubble.appendChild(content);
    return bubble;
}

function addSystemMessage(container, text) {
    const msg = document.createElement('div');
    msg.className = 'chat-system-msg';
    msg.textContent = `// ${text}`;
    container.appendChild(msg);
}

// =============================================================================
// SCREEN 5: REPORT
// =============================================================================

function setupScreen5() {
    document.getElementById('download-md-btn').addEventListener('click', () => {
        downloadMarkdown(appState.reportMarkdown, `editorial-board-${slugify(appState.articleTitle)}.md`);
    });

    document.getElementById('download-json-btn').addEventListener('click', () => {
        const sessionData = {
            article: { title: appState.articleTitle, full_text: appState.articleText },
            personas: appState.personas.map((p, i) => ({
                number: i + 1,
                role: p.role,
                stance: p.stance,
                model: p.model,
                editorial_lens: p.editorial_lens,
                full_verdict: appState.debateResults[i]?.response || '',
            })),
            report: {
                story_title: appState.articleTitle,
                full_report_markdown: appState.reportMarkdown,
            },
        };
        downloadJson(sessionData, `editorial-board-${slugify(appState.articleTitle)}.json`);
    });

    // CSV export
    document.getElementById('download-csv-btn').addEventListener('click', () => {
        const csv = buildCsvExport(
            appState.articleTitle,
            appState.articleText,
            appState.personas,
            appState.debateResults,
            appState.reportMarkdown
        );
        downloadCsv(csv, `editorial-board-${slugify(appState.articleTitle)}.csv`);
    });

    // Email CSV via Gmail
    document.getElementById('email-csv-btn').addEventListener('click', () => {
        // First download the CSV so the user has it
        const csv = buildCsvExport(
            appState.articleTitle,
            appState.articleText,
            appState.personas,
            appState.debateResults,
            appState.reportMarkdown
        );
        downloadCsv(csv, `editorial-board-${slugify(appState.articleTitle)}.csv`);

        // Open Gmail compose with pre-filled fields
        const subject = encodeURIComponent(`Editorial Board Data Donation: ${appState.articleTitle}`);
        const body = encodeURIComponent(
            `Hi!\n\nAttached is my editorial board CSV export for the article: "${appState.articleTitle}"\n\n` +
            `Board size: ${appState.personas.length} personas\n` +
            `Models used: ${appState.personas.map(p => p.model).join(', ')}\n\n` +
            `Please attach the CSV file that was just downloaded.\n\n` +
            `Thanks!`
        );
        const gmailUrl = `https://mail.google.com/mail/?view=cm&to=af3618@columbia.edu&su=${subject}&body=${body}`;
        window.open(gmailUrl, '_blank');
    });

    // New review
    document.getElementById('new-review-btn').addEventListener('click', () => {
        appState.articleTitle = '';
        appState.articleText = '';
        appState.articleFile = null;
        appState.personas = [];
        appState.debateResults = [];
        appState.reportMarkdown = '';

        document.getElementById('paste-area').value = '';
        document.getElementById('article-title').value = '';
        document.getElementById('article-preview').style.display = 'none';
        document.getElementById('file-info').style.display = 'none';

        // Reset file input so re-uploading the same file triggers a change event
        const fileInput = document.getElementById('file-input');
        if (fileInput) fileInput.value = '';

        navigateTo(2);
    });
}

async function startReportGeneration() {
    const loadingDiv = document.getElementById('report-loading');
    const contentDiv = document.getElementById('report-content');
    const actionsDiv = document.getElementById('report-actions');

    loadingDiv.style.display = 'block';
    contentDiv.style.display = 'none';
    actionsDiv.style.display = 'none';

    try {
        const report = await synthesizeReport(
            appState.articleTitle,
            appState.articleText,
            appState.debateResults,
            pickSynthesisModel()
        );

        appState.reportMarkdown = report;

        loadingDiv.style.display = 'none';
        contentDiv.style.display = 'block';
        actionsDiv.style.display = 'block';

        contentDiv.innerHTML = renderReport(report);
    } catch (err) {
        loadingDiv.textContent = '';
        const errorP = document.createElement('p');
        errorP.style.color = 'var(--neon-red)';
        errorP.textContent = `SYNTHESIS FAILED: ${err.message}`;
        const retryBtn = document.createElement('button');
        retryBtn.className = 'btn-secondary';
        retryBtn.textContent = 'RETRY';
        retryBtn.addEventListener('click', () => startReportGeneration());
        loadingDiv.appendChild(errorP);
        loadingDiv.appendChild(retryBtn);
    }
}

function pickSynthesisModel() {
    const preferred = [
        'anthropic/claude-sonnet-4',
        'anthropic/claude-3.5-sonnet',
        'openai/gpt-4o',
        'google/gemini-2.5-pro',
        'google/gemini-2.0-flash',
    ];
    const ids = new Set(appState.availableModels.map(m => m.id));
    for (const model of preferred) {
        if (ids.has(model)) return model;
    }
    return appState.personas[0]?.model || appState.availableModels[0]?.id;
}

// =============================================================================
// HELPERS
// =============================================================================

function showStatus(element, message, type) {
    element.textContent = message;
    element.className = 'status-area';
    if (type) element.classList.add(type);
}

function escapeHtml(str) {
    if (str == null) return '';
    const s = String(str);
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

function slugify(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').substring(0, 50);
}

// =============================================================================
// CDN LIBRARY CHECKS
// =============================================================================

/**
 * Check if required CDN libraries loaded successfully.
 * Warns in the UI if critical libraries are missing.
 */
function checkDependencies() {
    const missing = [];
    if (typeof mammoth === 'undefined') missing.push('mammoth.js (DOCX parsing)');
    if (typeof pdfjsLib === 'undefined') missing.push('pdf.js (PDF parsing)');
    if (typeof marked === 'undefined') missing.push('marked.js (Markdown rendering)');

    if (missing.length > 0) {
        console.warn('Missing CDN libraries:', missing);
        // Show a non-blocking warning if libraries are missing
        const header = document.getElementById('header-status');
        if (header) {
            header.textContent = 'DEGRADED: CDN LIBS MISSING';
            header.style.color = 'var(--neon-orange)';
        }
    }
}

// =============================================================================
// INITIALIZATION
// =============================================================================

document.addEventListener('DOMContentLoaded', () => {
    checkDependencies();
    setupScreen1();
    setupScreen2();
    setupScreen3();
    setupScreen4();
    setupScreen5();
});
