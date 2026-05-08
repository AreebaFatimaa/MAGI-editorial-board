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
import { DEFAULT_API_KEY, SYNTHESIS_MODEL } from './config.js';
import { sendAllTelemetry } from './telemetry.js';
import {
    createSession, recordStepEntry, recordStepCompletion,
    recordCallMeta, recordError, startCallMeta, finishCallMeta, failCallMeta,
    computeTotals, exportSession, hydrateSession, setPricingMap,
    persistToLocalStorage, loadFromLocalStorage, clearLocalStorage
} from './state.js';

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
    session: createSession(),
    keySource: null, // 'default' or 'user'
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
    if ((appState.currentScreen === 4 || appState.currentScreen === 3) && screenNum < appState.currentScreen) {
        abortAllRequests();
    }

    document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));

    const targetId = `screen-${SCREEN_IDS[screenNum]}`;
    const target = document.getElementById(targetId);
    if (target) target.classList.add('active');

    document.querySelectorAll('#step-indicator .step').forEach(stepEl => {
        const stepNum = parseInt(stepEl.dataset.step);
        stepEl.classList.remove('active', 'completed');
        if (stepNum === screenNum) stepEl.classList.add('active');
        else if (stepNum < screenNum) stepEl.classList.add('completed');
    });

    document.querySelectorAll('#step-indicator .step-connector').forEach((conn, index) => {
        if (index + 2 <= screenNum) conn.classList.add('completed');
        else conn.classList.remove('completed');
    });

    const statusLabels = { 1: 'AUTHENTICATING', 2: 'DATA INPUT', 3: 'BOARD CONFIG', 4: 'LIVE DEBATE', 5: 'REPORT READY' };
    const headerStatus = document.getElementById('header-status');
    if (headerStatus) headerStatus.textContent = statusLabels[screenNum] || 'STANDBY';

    appState.currentScreen = screenNum;
    recordStepEntry(appState.session, screenNum);
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

    // Default key always loads first. Users can override by entering their own.
    // This prevents stale localStorage keys from blocking the app.
    const hasDefaultKey = DEFAULT_API_KEY && !DEFAULT_API_KEY.includes('xxxxxxxxxxxx');
    const savedKey = getApiKey();

    if (hasDefaultKey) {
        // Always start with the default community key
        keyInput.value = DEFAULT_API_KEY;
        appState.keySource = 'default';
        showStatus(statusDiv, 'USING COMMUNITY KEY // ENTER YOUR OWN KEY FOR UNLIMITED USE', 'info');
        setTimeout(() => validateBtn.click(), 300);
    } else if (savedKey) {
        keyInput.value = savedKey;
        appState.keySource = 'user';
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
        appState.keySource = null;
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

        // Determine key source
        if (key === DEFAULT_API_KEY) {
            appState.keySource = 'default';
        } else {
            appState.keySource = 'user';
        }

        try {
            const result = await validateKeyAndFetchModels();
            if (result.valid) {
                appState.apiKey = key;
                appState.availableModels = result.models;
                appState.modelFamilies = result.families;

                // Set pricing map for cost calculations
                setPricingMap(result.models);

                // Record in session
                appState.session.steps[1].key_source = appState.keySource;
                recordStepCompletion(appState.session, 1);

                const keyLabel = appState.keySource === 'default' ? ' [COMMUNITY KEY]' : '';
                showStatus(statusDiv,
                    `CONNECTED${keyLabel} // ${result.models.length} models // ${result.families.length} families: ${result.families.join(', ')}`,
                    'success'
                );
                nextBtn.style.display = 'block';
                clearBtn.style.display = 'inline-block';
            } else {
                // Check for 402 (insufficient credits)
                if (result.error && result.error.includes('credit')) {
                    handleCreditExhausted(statusDiv, keyInput, validateBtn);
                } else {
                    showStatus(statusDiv, `ERROR: ${result.error}`, 'error');
                }
            }
        } catch (err) {
            showStatus(statusDiv, `CONNECTION FAILED: ${err.message}`, 'error');
        } finally {
            validateBtn.disabled = false;
        }
    });

    nextBtn.addEventListener('click', () => navigateTo(2));
}

/**
 * Handle 402 / credit exhaustion. If using default key, prompt for user's own key.
 */
function handleCreditExhausted(statusDiv, keyInput, validateBtn) {
    if (appState.keySource === 'default') {
        showStatus(statusDiv,
            'COMMUNITY KEY CREDITS EXHAUSTED FOR TODAY // ENTER YOUR OWN OPENROUTER KEY TO CONTINUE',
            'error'
        );
        keyInput.value = '';
        keyInput.focus();
    } else {
        showStatus(statusDiv, 'INSUFFICIENT CREDITS // ADD CREDITS AT openrouter.ai/credits', 'error');
    }
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

            // Record in session
            appState.session.article = {
                title: appState.articleTitle,
                text: appState.articleText,
                char_count: text.length,
            };
            appState.session.steps[2].article_chars = text.length;
            appState.session.steps[2].article_source = file ? file.name.split('.').pop().toLowerCase() : 'paste';
            recordStepCompletion(appState.session, 2);
            persistToLocalStorage(appState.session);

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

        // Record personas in session
        appState.session.personas = appState.personas.map(p => ({ ...p }));
        recordStepCompletion(appState.session, 3);
        persistToLocalStorage(appState.session);

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

    // If personas already exist (back-navigation), just render them
    if (appState.personas.length > 0) {
        loadingDiv.style.display = 'none';
        container.style.display = 'block';
        addBtn.style.display = 'block';
        buttons.style.display = 'flex';
        renderPersonaCards();
        return;
    }

    loadingDiv.style.display = 'block';
    container.style.display = 'none';
    addBtn.style.display = 'none';
    buttons.style.display = 'none';

    try {
        const result = await generatePersonas(appState.articleText, appState.availableModels);
        appState.personas = result.personas;

        // Record generation call metadata in session
        const callMeta = startCallMeta(result.callMeta.model, false);
        finishCallMeta(callMeta, result.callMeta.usage);
        callMeta.latency_ms = result.callMeta.latency_ms;
        recordCallMeta(appState.session, 3, callMeta);
        appState.session.steps[3].board_size = result.personas.length;

        loadingDiv.style.display = 'none';
        container.style.display = 'block';
        addBtn.style.display = 'block';
        buttons.style.display = 'flex';

        renderPersonaCards();
    } catch (err) {
        recordError(appState.session, 3, err.message);
        loadingDiv.textContent = '';
        const errorP = document.createElement('p');
        errorP.style.color = 'var(--neon-red)';
        errorP.textContent = `BOARD GENERATION FAILED: ${err.message}`;
        const retryBtn = document.createElement('button');
        retryBtn.className = 'btn-secondary';
        retryBtn.textContent = 'RETRY';
        retryBtn.addEventListener('click', () => {
            appState.personas = []; // Clear so retry works
            startBoardGeneration();
        });
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
// SCREEN 4: DEBATE (PARALLEL)
// =============================================================================

function setupScreen4() {
    document.getElementById('generate-report-btn').addEventListener('click', () => {
        navigateTo(5);
        startReportGeneration();
    });

    document.getElementById('back-to-board-btn').addEventListener('click', () => {
        navigateTo(3);
        startBoardGeneration(); // Will render cached personas, not regenerate
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

    // If debate results already exist (back-navigation), render them
    if (appState.debateResults.length > 0) {
        renderExistingDebate(messagesDiv, reportBtn, chatTitle, chatSubtitle);
        return;
    }

    messagesDiv.innerHTML = '';
    reportBtn.style.display = 'none';
    showStatus(statusDiv, '', '');

    chatTitle.textContent = appState.articleTitle;
    chatSubtitle.textContent = `${appState.personas.length} UNITS ENGAGED // PARALLEL MODE`;

    addSystemMessage(messagesDiv, 'EDITORIAL BOARD DEBATE INITIATED // ALL UNITS EVALUATING IN PARALLEL');

    // Create all bubbles upfront for parallel streaming
    const bubbles = [];
    let completedCount = 0;

    // Per-persona call metadata trackers
    const callMetas = appState.personas.map(p => startCallMeta(p.model, true));

    // Throttle scroll
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
                const bubble = createChatBubble(persona, index);
                messagesDiv.appendChild(bubble);
                bubbles[index] = bubble;

                // Show typing indicator for all
                typingDiv.style.display = 'flex';
                typingName.textContent = `${appState.personas.length} UNITS EVALUATING IN PARALLEL`;
                scheduleScroll();
            },

            onToken: (persona, index, token) => {
                const bubble = bubbles[index];
                if (!bubble) return;
                const content = bubble.querySelector('.bubble-content');
                content.textContent += token;
                scheduleScroll();
            },

            onPersonaDone: (persona, index, fullResponse, meta) => {
                completedCount++;
                const bubble = bubbles[index];

                // Finalize call metadata
                if (meta?.usage) {
                    finishCallMeta(callMetas[index], meta.usage);
                } else {
                    finishCallMeta(callMetas[index], {});
                }
                if (meta?.latency_ms) {
                    callMetas[index].latency_ms = meta.latency_ms;
                }
                recordCallMeta(appState.session, 4, callMetas[index]);

                if (bubble) {
                    const content = bubble.querySelector('.bubble-content');
                    content.innerHTML = safeMarkdown(fullResponse);

                    const time = document.createElement('div');
                    time.className = 'bubble-time';
                    time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    bubble.appendChild(time);

                    const model = document.createElement('div');
                    model.className = 'bubble-model';
                    const cost = callMetas[index].cost_usd;
                    const costStr = cost > 0 ? ` // $${cost.toFixed(4)}` : '';
                    model.textContent = `VIA ${persona.model}${costStr}`;
                    bubble.appendChild(model);
                }

                // Update progress
                chatSubtitle.textContent = `${completedCount}/${appState.personas.length} UNITS COMPLETE`;
                if (completedCount >= appState.personas.length) {
                    typingDiv.style.display = 'none';
                }

                scheduleScroll();
            },

            onAllDone: (results) => {
                // Attach callMeta to each result
                appState.debateResults = results.map((r, i) => ({
                    ...r,
                    callMeta: callMetas[i],
                }));
                appState.session.debate_results = appState.debateResults.map((r, i) => ({
                    persona_index: i,
                    response: r.response,
                    call_meta: callMetas[i],
                }));
                recordStepCompletion(appState.session, 4);
                persistToLocalStorage(appState.session);

                addSystemMessage(messagesDiv, `ALL ${results.length} UNITS COMPLETE // READY FOR SYNTHESIS`);
                reportBtn.style.display = 'block';
                scheduleScroll();
            },

            onError: (persona, index, error) => {
                failCallMeta(callMetas[index], error.message);
                recordError(appState.session, 4, error.message, persona.model);

                const bubble = bubbles[index];
                if (bubble) {
                    const content = bubble.querySelector('.bubble-content');
                    content.innerHTML = `<em style="color: var(--neon-red);">ERROR: ${escapeHtml(error.message)}</em>`;
                }
            },
        });
    } catch (err) {
        showStatus(statusDiv, `DEBATE FAILED: ${err.message}`, 'error');
        recordError(appState.session, 4, err.message);
    }
}

/**
 * Render existing debate results (for back-navigation).
 */
function renderExistingDebate(messagesDiv, reportBtn, chatTitle, chatSubtitle) {
    messagesDiv.innerHTML = '';
    chatTitle.textContent = appState.articleTitle;
    chatSubtitle.textContent = `${appState.debateResults.length} UNITS COMPLETE`;

    addSystemMessage(messagesDiv, 'EDITORIAL BOARD DEBATE // REVIEWING CACHED RESULTS');

    appState.debateResults.forEach((result, index) => {
        const persona = result.persona || appState.personas[index];
        if (!persona) return;

        const bubble = createChatBubble(persona, index);
        const content = bubble.querySelector('.bubble-content');
        content.innerHTML = safeMarkdown(result.response);

        const time = document.createElement('div');
        time.className = 'bubble-time';
        time.textContent = 'CACHED';
        bubble.appendChild(time);

        const model = document.createElement('div');
        model.className = 'bubble-model';
        model.textContent = `VIA ${persona.model}`;
        bubble.appendChild(model);

        messagesDiv.appendChild(bubble);
    });

    addSystemMessage(messagesDiv, `ALL ${appState.debateResults.length} UNITS COMPLETE // READY FOR SYNTHESIS`);
    reportBtn.style.display = 'block';
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
        // Export full session state as JSON
        computeTotals(appState.session);
        const sessionExport = exportSession(appState.session);
        downloadJson(sessionExport, `editorial-board-${slugify(appState.articleTitle)}.json`);
    });

    document.getElementById('download-csv-btn').addEventListener('click', () => {
        computeTotals(appState.session);
        const csv = buildCsvExport(
            appState.articleTitle,
            appState.articleText,
            appState.personas,
            appState.debateResults,
            appState.reportMarkdown,
            appState.session
        );
        downloadCsv(csv, `editorial-board-${slugify(appState.articleTitle)}.csv`);
    });

    document.getElementById('email-csv-btn').addEventListener('click', () => {
        computeTotals(appState.session);
        const csv = buildCsvExport(
            appState.articleTitle,
            appState.articleText,
            appState.personas,
            appState.debateResults,
            appState.reportMarkdown,
            appState.session
        );
        downloadCsv(csv, `editorial-board-${slugify(appState.articleTitle)}.csv`);

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

    // Export full session JSON (new button)
    const exportBtn = document.getElementById('export-session-btn');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            computeTotals(appState.session);
            const blob = new Blob([JSON.stringify(exportSession(appState.session), null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `magi-session-${appState.session.session_id.substring(0, 8)}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        });
    }

    document.getElementById('back-to-debate-btn').addEventListener('click', () => {
        navigateTo(4);
        startDebate(); // Will render cached debate, not re-run
    });

    document.getElementById('new-review-btn').addEventListener('click', () => {
        appState.articleTitle = '';
        appState.articleText = '';
        appState.articleFile = null;
        appState.personas = [];
        appState.debateResults = [];
        appState.reportMarkdown = '';
        appState.session = createSession();

        document.getElementById('paste-area').value = '';
        document.getElementById('article-title').value = '';
        document.getElementById('article-preview').style.display = 'none';
        document.getElementById('file-info').style.display = 'none';

        const fileInput = document.getElementById('file-input');
        if (fileInput) fileInput.value = '';

        clearLocalStorage();
        navigateTo(2);
    });
}

async function startReportGeneration() {
    const loadingDiv = document.getElementById('report-loading');
    const contentDiv = document.getElementById('report-content');
    const actionsDiv = document.getElementById('report-actions');

    // If report already exists (back-navigation), just render it
    if (appState.reportMarkdown) {
        loadingDiv.style.display = 'none';
        contentDiv.style.display = 'block';
        actionsDiv.style.display = 'block';
        contentDiv.innerHTML = renderReport(appState.reportMarkdown);
        return;
    }

    loadingDiv.style.display = 'block';
    contentDiv.style.display = 'none';
    actionsDiv.style.display = 'none';

    try {
        const result = await synthesizeReport(
            appState.articleTitle,
            appState.articleText,
            appState.debateResults
        );

        appState.reportMarkdown = result.content;

        // Record synthesis call metadata
        const callMeta = startCallMeta(result.model || SYNTHESIS_MODEL, false);
        finishCallMeta(callMeta, result.usage);
        callMeta.latency_ms = result.latency_ms;
        recordCallMeta(appState.session, 5, callMeta);
        appState.session.report = {
            markdown: result.content,
            verdict: extractVerdict(result.content),
        };
        recordStepCompletion(appState.session, 5);
        computeTotals(appState.session);
        persistToLocalStorage(appState.session);

        // Fire telemetry (non-blocking)
        sendAllTelemetry(appState.session);

        loadingDiv.style.display = 'none';
        contentDiv.style.display = 'block';
        actionsDiv.style.display = 'block';

        contentDiv.innerHTML = renderReport(result.content);
    } catch (err) {
        recordError(appState.session, 5, err.message);
        loadingDiv.textContent = '';
        const errorP = document.createElement('p');
        errorP.style.color = 'var(--neon-red)';
        errorP.textContent = `SYNTHESIS FAILED: ${err.message}`;
        const retryBtn = document.createElement('button');
        retryBtn.className = 'btn-secondary';
        retryBtn.textContent = 'RETRY';
        retryBtn.addEventListener('click', () => {
            appState.reportMarkdown = ''; // Clear so retry works
            startReportGeneration();
        });
        loadingDiv.appendChild(errorP);
        loadingDiv.appendChild(retryBtn);
    }
}

/**
 * Extract the verdict from the report markdown.
 */
function extractVerdict(markdown) {
    const match = markdown.match(/\*\*VERDICT:\*\*\s*(.+)/i);
    return match ? match[1].trim() : '';
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
// STEP INDICATOR NAVIGATION
// =============================================================================

function setupStepNavigation() {
    // Click any step to navigate there (if data exists for that step)
    document.querySelectorAll('#step-indicator .step').forEach(stepEl => {
        stepEl.style.cursor = 'pointer';
        stepEl.addEventListener('click', () => {
            const targetStep = parseInt(stepEl.dataset.step);
            if (targetStep === appState.currentScreen) return;
            navigateToStep(targetStep);
        });
    });

    // Click MAGI logo to go to screen 1 (home)
    const logo = document.querySelector('.nerv-logo');
    if (logo) {
        logo.style.cursor = 'pointer';
        logo.addEventListener('click', () => navigateToStep(1));
    }
}

function navigateToStep(targetStep) {
    // Screen 1 is always accessible
    if (targetStep === 1) {
        navigateTo(1);
        return;
    }

    // Screen 2 requires a validated key
    if (targetStep === 2) {
        if (!appState.apiKey) return;
        navigateTo(2);
        return;
    }

    // Screen 3 requires article text
    if (targetStep === 3) {
        if (!appState.articleText) return;
        navigateTo(3);
        startBoardGeneration(); // Renders cached personas or generates new
        return;
    }

    // Screen 4 requires personas
    if (targetStep === 4) {
        if (!appState.personas.length) return;
        navigateTo(4);
        startDebate(); // Renders cached debate or starts new
        return;
    }

    // Screen 5 requires debate results
    if (targetStep === 5) {
        if (!appState.debateResults.length) return;
        navigateTo(5);
        startReportGeneration(); // Renders cached report or generates new
        return;
    }
}

// =============================================================================
// DEBUG PANEL TOGGLE
// =============================================================================

function setupDebugToggle() {
    const footer = document.getElementById('app-footer');
    if (!footer) return;

    let clickCount = 0;
    let clickTimer = null;

    footer.addEventListener('click', () => {
        clickCount++;
        if (clickTimer) clearTimeout(clickTimer);
        clickTimer = setTimeout(() => { clickCount = 0; }, 1000);

        if (clickCount >= 3) {
            clickCount = 0;
            toggleDebugPanel();
        }
    });
}

function toggleDebugPanel() {
    let panel = document.getElementById('debug-panel');
    if (panel) {
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        if (panel.style.display === 'block') {
            updateDebugPanel();
        }
        return;
    }

    // Create debug panel
    panel = document.createElement('div');
    panel.id = 'debug-panel';
    panel.style.cssText = `
        position: fixed; bottom: 0; left: 0; right: 0; max-height: 50vh;
        overflow-y: auto; background: #0a0a0a; border-top: 2px solid var(--neon-green);
        padding: 1rem; font-family: var(--font-mono); font-size: 0.875rem;
        color: var(--neon-green); z-index: 9998;
    `;
    document.body.appendChild(panel);
    updateDebugPanel();
}

function updateDebugPanel() {
    const panel = document.getElementById('debug-panel');
    if (!panel) return;

    computeTotals(appState.session);
    const s = appState.session;
    const t = s.totals;

    let html = `<div style="margin-bottom:0.5rem;color:var(--neon-orange);">// MAGI DEBUG CONSOLE</div>`;
    html += `<div>SESSION: ${s.session_id.substring(0, 8)} | KEY: ${s.steps[1]?.key_source || '?'} | STEP: ${s.current_step}</div>`;
    html += `<div>TOKENS: ${t.prompt_tokens + t.completion_tokens} (${t.prompt_tokens}p + ${t.completion_tokens}c) | COST: $${t.total_cost.toFixed(4)} | LATENCY: ${(t.total_latency_ms / 1000).toFixed(1)}s</div>`;
    html += `<div>ERRORS: ${s.errors.length}</div>`;

    if (s.steps[4]?.debate_calls?.length > 0) {
        html += `<div style="margin-top:0.5rem;color:var(--neon-orange);">// PER-PERSONA</div>`;
        s.steps[4].debate_calls.forEach((c, i) => {
            const persona = appState.personas[i];
            const name = persona ? persona.role.substring(0, 25) : `#${i + 1}`;
            html += `<div>${name} | ${c.model?.split('/')[1] || '?'} | ${c.total_tokens}tok | ${(c.latency_ms / 1000).toFixed(1)}s | $${(c.cost_usd || 0).toFixed(4)}${c.error ? ' | ERR' : ''}</div>`;
        });
    }

    if (s.errors.length > 0) {
        html += `<div style="margin-top:0.5rem;color:var(--neon-red);">// ERRORS</div>`;
        s.errors.forEach(e => {
            html += `<div>Step ${e.step}: ${e.message}</div>`;
        });
    }

    html += `<div style="margin-top:0.5rem;"><button id="debug-close-btn" style="background:none;border:1px solid var(--neon-green);color:var(--neon-green);padding:0.25rem 0.5rem;cursor:pointer;font-family:inherit;">CLOSE</button></div>`;
    panel.innerHTML = html;
    document.getElementById('debug-close-btn')?.addEventListener('click', () => {
        panel.style.display = 'none';
    });
}

// =============================================================================
// CDN LIBRARY CHECKS
// =============================================================================

function checkDependencies() {
    const missing = [];
    if (typeof mammoth === 'undefined') missing.push('mammoth.js (DOCX parsing)');
    if (typeof pdfjsLib === 'undefined') missing.push('pdf.js (PDF parsing)');
    if (typeof marked === 'undefined') missing.push('marked.js (Markdown rendering)');

    if (missing.length > 0) {
        console.warn('Missing CDN libraries:', missing);
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
    setupDebugToggle();
    setupStepNavigation();
});
