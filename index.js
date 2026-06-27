/**
 * Dandeleon Multiverse — Multiverse RP World-Keeper
 *
 * An external DM (cheap external LLM) manages each roleplay universe for you.
 * It holds the FULL canon outside Caleb's context window and injects only:
 *   - a compact <currently> scene block at a shallow depth (frames the next reply)
 *   - a condensed second-person <past_events> memory at a deep depth (his memory)
 * Future beats stay dark until the story reaches them (spoiler gate).
 *
 * Built on the caleb-media-companion engine. By Lei.
 */

import { eventSource, event_types, extension_prompt_types, setExtensionPrompt } from '../../../../script.js';
import { getContext } from '../../../extensions.js';

const EXT_ID = 'dandeleon-multiverse';
const SCENE_PROMPT_ID = 'dandeleon_multiverse_scene';
const CHRONICLE_PROMPT_ID = 'dandeleon_multiverse_chronicle';
const STORAGE_KEY = 'dandeleon_multiverse_settings';
const CHAT_META_KEY = 'dandeleon_multiverse';

// =============================================================================
// Defaults
// =============================================================================

const PROVIDER_PRESETS = {
    openrouter: {
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        hint: 'OpenRouter model names (e.g. moonshotai/kimi-k2)'
    },
    moonshot: {
        endpoint: 'https://api.moonshot.ai/v1/chat/completions',
        hint: 'Moonshot models: moonshot-v1-8k, moonshot-v1-32k'
    },
    glm: {
        endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
        hint: 'GLM models: glm-4-flash (free!), glm-4-air, glm-4'
    },
    custom: {
        endpoint: '',
        hint: 'Any OpenAI-compatible endpoint'
    }
};

const DEFAULT_SETTINGS = {
    enabled: true,
    autoRun: true,          // run the DM automatically each turn
    showFab: true,
    messageDepth: 6,        // how many recent messages the DM sees
    sceneDepth: 3,          // <currently> injection depth (shallow)
    chronicleDepth: 10,     // <past_events> injection depth (deep)
    condenseEvery: 4,       // re-condense the chronicle every N turns
    // External DM API (don't burn Caleb's tokens)
    apiProvider: 'openrouter',
    apiEndpoint: 'https://openrouter.ai/api/v1/chat/completions',
    apiKey: '',
    apiModel: 'moonshotai/kimi-k2',
    verseLibrary: {}        // id -> verse
};

function defaultVerse(id, name, type) {
    return {
        id,
        name,
        type: type || 'rp',
        canon: '',                  // full unbounded history — never injected raw
        chronicle: '',              // condensed 2nd-person memory (depth-10 payload)
        futureBeats: [],            // [{ id, text, revealed }]
        world: { locations: [] },   // the map: [{ name, note }]
        scene: {
            weather: '', time: '', mood: '', location: '',
            characters: [],         // [{ name, note }] present cast / audience
            threads: [],            // active gossip/world threads
            currently: ''           // compiled <currently> block (depth-3 payload)
        },
        prose: '',                  // latest full narration (your side, not injected)
        dmChat: [],                 // [{ role, content }] your convo with the world-keeper
        turnsSinceCondense: 0
    };
}

let settings = { ...DEFAULT_SETTINGS };
let isRunning = false;
let fallbackChatData = null;

// =============================================================================
// Init
// =============================================================================

export async function init() {
    console.log('[Multiverse] Initializing...');
    loadSettings();
    injectSettingsUI();
    injectPanelUI();
    updateUI();

    eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    console.log('[Multiverse] Ready!');
}

// =============================================================================
// Settings persistence (localStorage)
// =============================================================================

function loadSettings() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            settings = { ...DEFAULT_SETTINGS, ...parsed };
            if (!settings.verseLibrary) settings.verseLibrary = {};
        }
    } catch (e) {
        console.warn('[Multiverse] Failed to load settings:', e);
    }
}

function saveSettings() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
        console.warn('[Multiverse] Failed to save settings:', e);
    }
}

// =============================================================================
// Per-chat data (active verse pointer via chat_metadata)
// =============================================================================

function getChatData() {
    try {
        const ctx = getContext();
        if (ctx.chat_metadata) {
            if (!ctx.chat_metadata[CHAT_META_KEY]) {
                ctx.chat_metadata[CHAT_META_KEY] = fallbackChatData || { activeVerseId: null };
            }
            fallbackChatData = ctx.chat_metadata[CHAT_META_KEY];
            return ctx.chat_metadata[CHAT_META_KEY];
        }
    } catch (e) { /* fall through */ }
    if (!fallbackChatData) fallbackChatData = { activeVerseId: null };
    return fallbackChatData;
}

function saveChatData(data) {
    fallbackChatData = data;
    try {
        const ctx = getContext();
        if (ctx.chat_metadata) ctx.chat_metadata[CHAT_META_KEY] = data;
    } catch (e) {
        console.warn('[Multiverse] Failed to save chat data:', e);
    }
}

function getActiveVerse() {
    const chatData = getChatData();
    if (!chatData.activeVerseId) return null;
    return settings.verseLibrary[chatData.activeVerseId] || null;
}

// =============================================================================
// External DM API call (OpenAI-compatible)
// =============================================================================

async function callExternalAPI(messages, opts = {}) {
    if (!settings.apiKey) {
        console.warn('[Multiverse] No API key configured');
        return null;
    }

    const body = {
        model: settings.apiModel,
        messages,
        max_tokens: opts.maxTokens || 1200,
        temperature: opts.temperature ?? 0.7,
        stream: false
    };

    try {
        const response = await fetch(settings.apiEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${settings.apiKey}`,
                'HTTP-Referer': 'https://github.com/SillyTavern/SillyTavern',
                'X-Title': 'Dandeleon Multiverse'
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            console.warn(`[Multiverse] API Error ${response.status}: ${errText.slice(0, 200)}`);
            return null;
        }

        const data = await response.json();
        return data?.choices?.[0]?.message?.content
            || data?.choices?.[0]?.text
            || data?.output_text
            || '';
    } catch (e) {
        console.warn('[Multiverse] API call failed:', e);
        return null;
    }
}

async function testExternalAPI() {
    try {
        const r = await callExternalAPI(
            [{ role: 'user', content: 'Reply with exactly: ok' }],
            { maxTokens: 10, temperature: 0 }
        );
        if (r && r.toLowerCase().includes('ok')) return { ok: true };
        return { ok: false, error: r || 'Empty response' };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

function extractJSON(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { /* try to slice */ }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
        try { return JSON.parse(text.slice(start, end + 1)); } catch (e) { /* give up */ }
    }
    return null;
}

// =============================================================================
// The DM head — one call returns prose + currently + (maybe) pastEvents
// =============================================================================

const DM_SYSTEM = `You are the GAME MASTER and world engine for an ongoing roleplay set in a specific universe. You manage everything AROUND the user's scene partner — weather, location, other characters present, events, gossip, atmosphere, and the rerolls of fate. You NEVER write dialogue or actions for the user's scene partner (a separate model voices them) and you NEVER write for the user.

You are given the established CANON, the CURRENT SCENE, secret GM-ONLY FUTURE BEATS, recent roleplay, and the user's latest action. Surface a future beat ONLY if it naturally triggers THIS turn.

Output STRICT JSON ONLY — no text outside the JSON object:
{
  "prose": "Cinematic narration of the present moment for the human to read (2-5 sentences): weather, the room, who's around, what's stirring.",
  "currently": "A COMPACT scene block for the partner's context window. Exactly this shape:\\nweather|mood|time tags\\naudience: <count> (<named characters present>)\\ngossip: <active rumor or world thread>\\n\\n<0-4 short lines of live banter from OTHER present characters, formatted Name: line>",
  "scene": {
    "weather": "", "time": "", "mood": "", "location": "",
    "characters": [{"name": "", "note": "what they're doing"}],
    "threads": ["active world thread"]
  },
  "pastEvents": "ONLY fill this when REFRESH_MEMORY is yes; otherwise return an empty string. A SECOND-PERSON condensed memory addressed to the scene partner ('You grew up in...', 'You have...'). Tight bullet-like sentences covering everything REVEALED so far. NEVER include future beats.",
  "revealBeats": ["id of any future beat that triggers now"],
  "canonAppend": "optional one or two sentences of NEW established fact to append to canon from what just happened"
}`;

function getRecentMessages(depth) {
    try {
        const ctx = getContext();
        const chat = ctx?.chat;
        if (!chat || chat.length === 0) return [];
        const out = [];
        for (let i = chat.length - 1; i >= 0 && out.length < depth; i--) {
            const m = chat[i];
            if (m && m.mes) out.unshift(`${m.is_user ? 'User' : 'Partner'}: ${m.mes}`);
        }
        return out;
    } catch (e) { return []; }
}

function buildDMUserPrompt(verse, recent, refreshMemory) {
    const beats = verse.futureBeats.filter(b => !b.revealed)
        .map(b => `[${b.id}] ${b.text}`).join('\n') || '(none)';
    const cast = verse.scene.characters.map(c => `${c.name}${c.note ? ` (${c.note})` : ''}`).join(', ') || '(none set)';
    const locations = verse.world.locations.map(l => l.name).join(', ') || '(none set)';

    return `VERSE: ${verse.name}

CANON (established history — the source of truth):
${verse.canon || '(empty — nothing established yet)'}

CURRENT SCENE:
- weather: ${verse.scene.weather || '?'}
- time: ${verse.scene.time || '?'}
- mood: ${verse.scene.mood || '?'}
- location: ${verse.scene.location || '?'}
- present characters: ${cast}
- active threads: ${verse.scene.threads.join('; ') || '(none)'}

KNOWN LOCATIONS (map): ${locations}

GM-ONLY FUTURE BEATS (secret — surface only if triggered this turn):
${beats}

RECENT ROLEPLAY:
${recent.join('\n') || '(start of scene)'}

REFRESH_MEMORY: ${refreshMemory ? 'yes' : 'no'}

Advance the world one beat in response to the latest action. Return the JSON.`;
}

async function runDM() {
    const verse = getActiveVerse();
    if (!verse) return;
    if (isRunning) return;

    const recent = getRecentMessages(settings.messageDepth);
    if (recent.length === 0) return;

    const refreshMemory = (verse.turnsSinceCondense || 0) >= settings.condenseEvery || !verse.chronicle;

    isRunning = true;
    updateProcessingIndicator(true);
    try {
        const messages = [
            { role: 'system', content: DM_SYSTEM },
            { role: 'user', content: buildDMUserPrompt(verse, recent, refreshMemory) }
        ];
        const raw = await callExternalAPI(messages, { maxTokens: 1400, temperature: 0.8 });
        const result = extractJSON(raw);
        if (!result) {
            console.warn('[Multiverse] DM returned unparseable output');
            return;
        }

        // Update scene
        if (result.scene && typeof result.scene === 'object') {
            const s = result.scene;
            verse.scene.weather = s.weather ?? verse.scene.weather;
            verse.scene.time = s.time ?? verse.scene.time;
            verse.scene.mood = s.mood ?? verse.scene.mood;
            verse.scene.location = s.location ?? verse.scene.location;
            if (Array.isArray(s.characters)) verse.scene.characters = s.characters.filter(c => c && c.name);
            if (Array.isArray(s.threads)) verse.scene.threads = s.threads.filter(Boolean);
        }
        if (typeof result.currently === 'string' && result.currently.trim()) {
            verse.scene.currently = result.currently.trim();
        }

        // Chronicle (memory) — only refreshed on the condense cadence
        if (refreshMemory && typeof result.pastEvents === 'string' && result.pastEvents.trim()) {
            verse.chronicle = result.pastEvents.trim();
            verse.turnsSinceCondense = 0;
        } else {
            verse.turnsSinceCondense = (verse.turnsSinceCondense || 0) + 1;
        }

        // Reveal triggered future beats → fold into canon
        if (Array.isArray(result.revealBeats) && result.revealBeats.length) {
            for (const id of result.revealBeats) {
                const beat = verse.futureBeats.find(b => String(b.id) === String(id));
                if (beat && !beat.revealed) {
                    beat.revealed = true;
                    verse.canon = (verse.canon ? verse.canon + '\n\n' : '') + beat.text;
                }
            }
        }

        // Append new canon
        if (typeof result.canonAppend === 'string' && result.canonAppend.trim()) {
            verse.canon = (verse.canon ? verse.canon + '\n\n' : '') + result.canonAppend.trim();
        }

        // Prose (your side)
        if (typeof result.prose === 'string' && result.prose.trim()) {
            verse.prose = result.prose.trim();
        }

        saveSettings();
        injectVerse();
        updateSceneDisplay();
        updateProseDisplay();
        console.log('[Multiverse] DM advanced the world', refreshMemory ? '(memory refreshed)' : '');
    } catch (e) {
        console.warn('[Multiverse] runDM failed:', e);
    } finally {
        isRunning = false;
        updateProcessingIndicator(false);
    }
}

// =============================================================================
// Two-depth injection (no API — uses stored verse data)
// =============================================================================

function clearInjection() {
    setExtensionPrompt(SCENE_PROMPT_ID, '', extension_prompt_types.IN_CHAT, settings.sceneDepth);
    setExtensionPrompt(CHRONICLE_PROMPT_ID, '', extension_prompt_types.IN_CHAT, settings.chronicleDepth);
}

function injectVerse() {
    if (!settings.enabled) { clearInjection(); return; }
    const verse = getActiveVerse();
    if (!verse) { clearInjection(); return; }

    const sceneBlock = verse.scene.currently?.trim()
        ? `<currently>\n${verse.scene.currently.trim()}\n</currently>`
        : '';
    const chronicleBlock = verse.chronicle?.trim()
        ? `<past_events>\n${verse.chronicle.trim()}\n</past_events>`
        : '';

    setExtensionPrompt(SCENE_PROMPT_ID, sceneBlock, extension_prompt_types.IN_CHAT, settings.sceneDepth);
    setExtensionPrompt(CHRONICLE_PROMPT_ID, chronicleBlock, extension_prompt_types.IN_CHAT, settings.chronicleDepth);
}

// =============================================================================
// World-keeper chat (you converse with the DM to manage the verse)
// =============================================================================

function worldkeeperSystem(verse) {
    return `You are the WORLD-KEEPER for the roleplay universe "${verse.name}". You collaborate with the user to build and manage this world: its canon/backstory, cast of characters, locations/map, tone, and secret future beats. Be concise, concrete, and collaborative. When the user hands you canon or asks you to plan, integrate it and reflect it back cleanly. Suggest scene setups, NPCs, and plot beats when useful. Keep replies short unless asked to expand.

CURRENT CANON:
${verse.canon || '(empty)'}

CURRENT SCENE: ${verse.scene.location || '?'} — ${verse.scene.weather || '?'}, present: ${verse.scene.characters.map(c => c.name).join(', ') || 'no one'}.`;
}

async function chatWithDM(message) {
    const verse = getActiveVerse();
    if (!verse || !message.trim()) return;

    verse.dmChat.push({ role: 'user', content: message.trim() });
    saveSettings();
    renderDMChat();

    const history = verse.dmChat.slice(-12).map(m => ({ role: m.role, content: m.content }));
    const messages = [{ role: 'system', content: worldkeeperSystem(verse) }, ...history];

    updateProcessingIndicator(true);
    try {
        const reply = await callExternalAPI(messages, { maxTokens: 800, temperature: 0.7 });
        if (reply && reply.trim()) {
            verse.dmChat.push({ role: 'assistant', content: reply.trim() });
            saveSettings();
            renderDMChat();
        }
    } finally {
        updateProcessingIndicator(false);
    }
}

async function recondenseNow() {
    const verse = getActiveVerse();
    if (!verse) return;
    verse.turnsSinceCondense = settings.condenseEvery; // force refresh next run
    // Do a direct condense pass from canon right now
    updateProcessingIndicator(true);
    try {
        const messages = [
            { role: 'system', content: 'You compress a roleplay history into the scene partner\'s long-term memory. Write in SECOND PERSON addressed to the partner ("You grew up...", "You have..."). Tight, a handful of sentences. Only established/past facts. Output the memory text only, no preamble.' },
            { role: 'user', content: `VERSE: ${verse.name}\n\nCANON:\n${verse.canon || '(empty)'}\n\nWrite the condensed second-person memory.` }
        ];
        const reply = await callExternalAPI(messages, { maxTokens: 600, temperature: 0.4 });
        if (reply && reply.trim()) {
            verse.chronicle = reply.trim();
            verse.turnsSinceCondense = 0;
            saveSettings();
            injectVerse();
            updateChronicleDisplay();
        }
    } finally {
        updateProcessingIndicator(false);
    }
}

// =============================================================================
// Event handlers
// =============================================================================

async function onMessageSent() {
    if (!settings.enabled) return;
    const verse = getActiveVerse();
    if (!verse) return;
    if (settings.autoRun && !isRunning) {
        await runDM();
    } else {
        injectVerse();
    }
}

function onGenerationStarted(type, data, dryRun) {
    if (dryRun) return;
    if (!settings.enabled) return;
    if (data?.quietImage || data?.quiet_image || data?.isImageGeneration) return;
    if (data?.quiet_prompt || type === 'quiet') return;
    injectVerse();
}

function onChatChanged() {
    updateUI();
    if (settings.enabled) injectVerse();
}

// =============================================================================
// Settings UI (Extensions tab)
// =============================================================================

function injectSettingsUI() {
    const html = `
    <div id="dmv-settings" class="dandeleon-multiverse-block">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Dandeleon Multiverse</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="padding:10px;">
                <label class="dmv-check"><input type="checkbox" id="dmv-enabled" ${settings.enabled ? 'checked' : ''}> Enable Dandeleon Multiverse</label>
                <label class="dmv-check"><input type="checkbox" id="dmv-auto-run" ${settings.autoRun ? 'checked' : ''}> Run DM automatically each turn</label>
                <label class="dmv-check"><input type="checkbox" id="dmv-show-fab" ${settings.showFab ? 'checked' : ''}> Show floating button</label>

                <div class="dmv-grid2">
                    <div><label>Scene depth</label><input type="number" id="dmv-scene-depth" value="${settings.sceneDepth}" min="0" max="50"></div>
                    <div><label>Chronicle depth</label><input type="number" id="dmv-chronicle-depth" value="${settings.chronicleDepth}" min="0" max="100"></div>
                    <div><label>Msgs DM sees</label><input type="number" id="dmv-msg-depth" value="${settings.messageDepth}" min="2" max="30"></div>
                    <div><label>Re-condense every</label><input type="number" id="dmv-condense-every" value="${settings.condenseEvery}" min="1" max="50"></div>
                </div>

                <div class="dmv-api">
                    <label class="dmv-api-title">External DM API</label>
                    <select id="dmv-api-provider">
                        <option value="openrouter" ${settings.apiProvider === 'openrouter' ? 'selected' : ''}>OpenRouter</option>
                        <option value="moonshot" ${settings.apiProvider === 'moonshot' ? 'selected' : ''}>Moonshot AI</option>
                        <option value="glm" ${settings.apiProvider === 'glm' ? 'selected' : ''}>GLM / Zhipu AI</option>
                        <option value="custom" ${settings.apiProvider === 'custom' ? 'selected' : ''}>Custom Endpoint</option>
                    </select>
                    <input type="password" id="dmv-api-key" value="${escapeHtml(settings.apiKey)}" placeholder="API key">
                    <input type="text" id="dmv-api-endpoint" value="${escapeHtml(settings.apiEndpoint)}" placeholder="Endpoint URL">
                    <input type="text" id="dmv-api-model" value="${escapeHtml(settings.apiModel)}" placeholder="Model (e.g. moonshotai/kimi-k2)">
                    <div id="dmv-model-hint" class="dmv-hint"></div>
                    <div class="dmv-btn-row">
                        <button id="dmv-api-test" class="dmv-btn dmv-btn-info">Test</button>
                        <button id="dmv-api-save" class="dmv-btn dmv-btn-ok">Save</button>
                    </div>
                    <div id="dmv-api-status" class="dmv-status"></div>
                </div>

                <button id="dmv-open-panel" class="menu_button" style="width:100%;margin-top:8px;">Open World Manager</button>
            </div>
        </div>
    </div>`;

    const targets = ['#extensions_settings2', '#extensions_settings', '#extension_settings'];
    for (const sel of targets) {
        const t = document.querySelector(sel);
        if (t) { t.insertAdjacentHTML('beforeend', html); break; }
    }

    bind('dmv-enabled', 'change', e => { settings.enabled = e.target.checked; saveSettings(); settings.enabled ? injectVerse() : clearInjection(); updateFabVisibility(); });
    bind('dmv-auto-run', 'change', e => { settings.autoRun = e.target.checked; saveSettings(); });
    bind('dmv-show-fab', 'change', e => { settings.showFab = e.target.checked; saveSettings(); updateFabVisibility(); });
    bind('dmv-scene-depth', 'change', e => { settings.sceneDepth = parseInt(e.target.value) || 3; saveSettings(); injectVerse(); });
    bind('dmv-chronicle-depth', 'change', e => { settings.chronicleDepth = parseInt(e.target.value) || 10; saveSettings(); injectVerse(); });
    bind('dmv-msg-depth', 'change', e => { settings.messageDepth = parseInt(e.target.value) || 6; saveSettings(); });
    bind('dmv-condense-every', 'change', e => { settings.condenseEvery = parseInt(e.target.value) || 4; saveSettings(); });
    bind('dmv-open-panel', 'click', () => togglePanel(true));

    bind('dmv-api-provider', 'change', e => {
        settings.apiProvider = e.target.value;
        const preset = PROVIDER_PRESETS[e.target.value] || PROVIDER_PRESETS.custom;
        if (e.target.value !== 'custom') {
            const ep = document.getElementById('dmv-api-endpoint');
            if (ep) { ep.value = preset.endpoint; settings.apiEndpoint = preset.endpoint; }
        }
        const hint = document.getElementById('dmv-model-hint');
        if (hint) hint.textContent = preset.hint;
        saveSettings();
    });
    const hint = document.getElementById('dmv-model-hint');
    if (hint) hint.textContent = (PROVIDER_PRESETS[settings.apiProvider] || PROVIDER_PRESETS.custom).hint;

    bind('dmv-api-save', 'click', () => {
        settings.apiKey = val('dmv-api-key');
        settings.apiEndpoint = val('dmv-api-endpoint');
        settings.apiModel = val('dmv-api-model');
        saveSettings();
        showApiStatus('Saved!', 'ok');
    });
    bind('dmv-api-test', 'click', async () => {
        settings.apiKey = val('dmv-api-key');
        settings.apiEndpoint = val('dmv-api-endpoint');
        settings.apiModel = val('dmv-api-model');
        saveSettings();
        showApiStatus('Testing...', 'info');
        const r = await testExternalAPI();
        showApiStatus(r.ok ? 'Connection OK!' : `Failed: ${r.error}`, r.ok ? 'ok' : 'error');
    });
}

function showApiStatus(msg, type) {
    const el = document.getElementById('dmv-api-status');
    if (!el) return;
    el.textContent = msg;
    el.style.color = type === 'ok' ? '#2ecc71' : type === 'error' ? '#e74c3c' : '#888';
    if (type !== 'error') setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 3000);
}

// =============================================================================
// Main panel + FAB
// =============================================================================

function injectPanelUI() {
    const html = `
    <button id="dmv-fab" title="Dandeleon Multiverse"><span style="font-size:22px;">🌌</span></button>

    <div id="dmv-panel">
        <div class="dmv-header">
            <span>🌌 Dandeleon Multiverse</span>
            <span>
                <span id="dmv-processing" class="dmv-proc">working…</span>
                <span class="dmv-close fa-solid fa-xmark" id="dmv-panel-close"></span>
            </span>
        </div>

        <div class="dmv-body">
            <!-- Verse selector (multiverse) -->
            <div class="dmv-section">
                <label>Active Verse</label>
                <select id="dmv-verse-select"><option value="">— None —</option></select>
                <div class="dmv-btn-row">
                    <button class="dmv-btn dmv-btn-ok" id="dmv-new-verse">+ New Verse</button>
                    <button class="dmv-btn dmv-btn-danger" id="dmv-delete-verse">Delete</button>
                </div>
                <div class="dmv-new-form" id="dmv-new-verse-form">
                    <input type="text" id="dmv-new-verse-name" placeholder="Verse name (e.g. Hogwarts — Year 5)">
                    <div class="dmv-btn-row" style="margin-top:6px;">
                        <button class="dmv-btn dmv-btn-ok" id="dmv-create-verse">Create</button>
                        <button class="dmv-btn" id="dmv-cancel-verse">Cancel</button>
                    </div>
                </div>
            </div>

            <div id="dmv-active" style="display:none;">
                <!-- Run controls -->
                <div class="dmv-section dmv-run-row">
                    <button class="dmv-btn dmv-btn-primary" id="dmv-run-dm">▶ Advance World</button>
                    <button class="dmv-btn" id="dmv-recondense" title="Re-condense the long-term memory from canon">↻ Re-condense</button>
                </div>

                <!-- Latest prose (your side) -->
                <div class="dmv-section">
                    <label>Now (your narration)</label>
                    <div id="dmv-prose" class="dmv-prose">—</div>
                </div>

                <!-- Scene widgets -->
                <div class="dmv-section">
                    <label>Scene</label>
                    <div class="dmv-grid2">
                        <input type="text" id="dmv-sc-weather" placeholder="weather">
                        <input type="text" id="dmv-sc-time" placeholder="time">
                        <input type="text" id="dmv-sc-mood" placeholder="mood">
                        <input type="text" id="dmv-sc-location" placeholder="location">
                    </div>
                    <label class="dmv-sub">Present cast (one per line: Name — note)</label>
                    <textarea id="dmv-sc-characters" rows="2" placeholder="Abraxas Malfoy — smirking&#10;Greta Hellwig — unimpressed"></textarea>
                    <label class="dmv-sub">Threads / gossip (one per line)</label>
                    <textarea id="dmv-sc-threads" rows="2" placeholder="new professor incoming"></textarea>
                    <label class="dmv-sub">Compiled &lt;currently&gt; (injected at depth ${settings.sceneDepth})</label>
                    <textarea id="dmv-sc-currently" rows="4" placeholder="The DM writes this each turn — you can edit it."></textarea>
                </div>

                <!-- Map -->
                <div class="dmv-section">
                    <label>Map — known locations (one per line)</label>
                    <textarea id="dmv-locations" rows="3" placeholder="Great Hall&#10;Slytherin Common Room&#10;Astronomy Tower"></textarea>
                </div>

                <!-- Canon -->
                <div class="dmv-section">
                    <label>Canon — full history (stays out of Caleb's window)</label>
                    <textarea id="dmv-canon" rows="6" placeholder="Paste the full backstory / everything established. The DM holds this and feeds Caleb only a condensed version."></textarea>
                </div>

                <!-- Chronicle -->
                <div class="dmv-section">
                    <label>Chronicle — condensed memory (injected at depth ${settings.chronicleDepth})</label>
                    <textarea id="dmv-chronicle" rows="4" placeholder="Auto-condensed from canon. Second person — his memory."></textarea>
                </div>

                <!-- Future beats (spoiler gate) -->
                <div class="dmv-section">
                    <label>Future beats — dark until reached</label>
                    <div id="dmv-beats"></div>
                    <div class="dmv-btn-row" style="margin-top:6px;">
                        <input type="text" id="dmv-new-beat" placeholder="A beat that hasn't happened yet…" style="flex:1;">
                        <button class="dmv-btn dmv-btn-ok" id="dmv-add-beat">+ Add</button>
                    </div>
                </div>

                <!-- DM chat -->
                <div class="dmv-section">
                    <label>Talk to the World-Keeper</label>
                    <div id="dmv-dmchat" class="dmv-dmchat"></div>
                    <div class="dmv-btn-row">
                        <input type="text" id="dmv-dm-input" placeholder="Set up the world, hand it backstory, pre-author beats…" style="flex:1;">
                        <button class="dmv-btn dmv-btn-primary" id="dmv-dm-send">Send</button>
                    </div>
                </div>
            </div>

            <!-- Library -->
            <div class="dmv-section">
                <label>Verse Library</label>
                <div id="dmv-library"></div>
            </div>
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', html);
    bindPanelEvents();
    updateFabVisibility();
}

function bindPanelEvents() {
    bind('dmv-fab', 'click', () => togglePanel());
    bind('dmv-panel-close', 'click', () => togglePanel(false));

    bind('dmv-verse-select', 'change', onVerseSelected);
    bind('dmv-new-verse', 'click', () => document.getElementById('dmv-new-verse-form')?.classList.toggle('dmv-visible'));
    bind('dmv-cancel-verse', 'click', () => document.getElementById('dmv-new-verse-form')?.classList.remove('dmv-visible'));
    bind('dmv-create-verse', 'click', onCreateVerse);
    bind('dmv-delete-verse', 'click', onDeleteVerse);

    bind('dmv-run-dm', 'click', () => runDM());
    bind('dmv-recondense', 'click', () => recondenseNow());

    // Scene field edits
    bind('dmv-sc-weather', 'input', debounce(saveSceneFields, 500));
    bind('dmv-sc-time', 'input', debounce(saveSceneFields, 500));
    bind('dmv-sc-mood', 'input', debounce(saveSceneFields, 500));
    bind('dmv-sc-location', 'input', debounce(saveSceneFields, 500));
    bind('dmv-sc-characters', 'input', debounce(saveSceneFields, 500));
    bind('dmv-sc-threads', 'input', debounce(saveSceneFields, 500));
    bind('dmv-sc-currently', 'input', debounce(() => { const v = getActiveVerse(); if (v) { v.scene.currently = val('dmv-sc-currently'); saveSettings(); injectVerse(); } }, 500));

    bind('dmv-locations', 'input', debounce(() => {
        const v = getActiveVerse(); if (!v) return;
        v.world.locations = val('dmv-locations').split('\n').map(s => s.trim()).filter(Boolean).map(name => ({ name, note: '' }));
        saveSettings();
    }, 500));

    bind('dmv-canon', 'input', debounce(() => { const v = getActiveVerse(); if (v) { v.canon = val('dmv-canon'); saveSettings(); } }, 600));
    bind('dmv-chronicle', 'input', debounce(() => { const v = getActiveVerse(); if (v) { v.chronicle = val('dmv-chronicle'); saveSettings(); injectVerse(); } }, 600));

    bind('dmv-add-beat', 'click', onAddBeat);
    bind('dmv-new-beat', 'keydown', e => { if (e.key === 'Enter') onAddBeat(); });

    bind('dmv-dm-send', 'click', sendDMMessage);
    bind('dmv-dm-input', 'keydown', e => { if (e.key === 'Enter') sendDMMessage(); });
}

function sendDMMessage() {
    const input = document.getElementById('dmv-dm-input');
    if (!input || !input.value.trim()) return;
    const msg = input.value;
    input.value = '';
    chatWithDM(msg);
}

function saveSceneFields() {
    const v = getActiveVerse();
    if (!v) return;
    v.scene.weather = val('dmv-sc-weather');
    v.scene.time = val('dmv-sc-time');
    v.scene.mood = val('dmv-sc-mood');
    v.scene.location = val('dmv-sc-location');
    v.scene.characters = val('dmv-sc-characters').split('\n').map(s => s.trim()).filter(Boolean).map(line => {
        const [name, note] = line.split(/\s*[—-]\s*/);
        return { name: (name || '').trim(), note: (note || '').trim() };
    }).filter(c => c.name);
    v.scene.threads = val('dmv-sc-threads').split('\n').map(s => s.trim()).filter(Boolean);
    saveSettings();
}

// =============================================================================
// Verse CRUD
// =============================================================================

function onVerseSelected(e) {
    const chatData = getChatData();
    chatData.activeVerseId = e.target.value || null;
    saveChatData(chatData);
    injectVerse();
    updateUI();
}

function onCreateVerse() {
    const nameInput = document.getElementById('dmv-new-verse-name');
    const name = nameInput?.value?.trim();
    if (!name) return;
    let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    while (settings.verseLibrary[id]) id += '_';
    settings.verseLibrary[id] = defaultVerse(id, name);
    saveSettings();

    const chatData = getChatData();
    chatData.activeVerseId = id;
    saveChatData(chatData);

    if (nameInput) nameInput.value = '';
    document.getElementById('dmv-new-verse-form')?.classList.remove('dmv-visible');
    updateUI();
}

function onDeleteVerse() {
    const v = getActiveVerse();
    if (!v) return;
    if (!confirm(`Delete verse "${v.name}"? Its canon and chronicle are gone for good.`)) return;
    delete settings.verseLibrary[v.id];
    saveSettings();
    const chatData = getChatData();
    chatData.activeVerseId = null;
    saveChatData(chatData);
    clearInjection();
    updateUI();
}

function onAddBeat() {
    const input = document.getElementById('dmv-new-beat');
    const text = input?.value?.trim();
    if (!text) return;
    const v = getActiveVerse();
    if (!v) return;
    v.futureBeats.push({ id: `b${Date.now()}`, text, revealed: false });
    saveSettings();
    if (input) input.value = '';
    renderBeats();
}

// =============================================================================
// UI refresh
// =============================================================================

function updateUI() {
    const chatData = getChatData();
    const activeId = chatData.activeVerseId;

    const select = document.getElementById('dmv-verse-select');
    if (select) {
        select.innerHTML = '<option value="">— None —</option>' +
            Object.values(settings.verseLibrary).map(v =>
                `<option value="${v.id}" ${v.id === activeId ? 'selected' : ''}>🌐 ${escapeHtml(v.name)}</option>`).join('');
    }

    const verse = getActiveVerse();
    setVisible('dmv-active', !!verse);

    if (verse) {
        setVal('dmv-sc-weather', verse.scene.weather);
        setVal('dmv-sc-time', verse.scene.time);
        setVal('dmv-sc-mood', verse.scene.mood);
        setVal('dmv-sc-location', verse.scene.location);
        setVal('dmv-sc-characters', verse.scene.characters.map(c => c.note ? `${c.name} — ${c.note}` : c.name).join('\n'));
        setVal('dmv-sc-threads', verse.scene.threads.join('\n'));
        setVal('dmv-sc-currently', verse.scene.currently);
        setVal('dmv-locations', verse.world.locations.map(l => l.name).join('\n'));
        setVal('dmv-canon', verse.canon);
        setVal('dmv-chronicle', verse.chronicle);
        updateProseDisplay();
        renderBeats();
        renderDMChat();
    }

    updateLibrary();
}

function updateSceneDisplay() {
    const v = getActiveVerse();
    if (!v) return;
    setVal('dmv-sc-weather', v.scene.weather);
    setVal('dmv-sc-time', v.scene.time);
    setVal('dmv-sc-mood', v.scene.mood);
    setVal('dmv-sc-location', v.scene.location);
    setVal('dmv-sc-characters', v.scene.characters.map(c => c.note ? `${c.name} — ${c.note}` : c.name).join('\n'));
    setVal('dmv-sc-threads', v.scene.threads.join('\n'));
    setVal('dmv-sc-currently', v.scene.currently);
}

function updateProseDisplay() {
    const v = getActiveVerse();
    const el = document.getElementById('dmv-prose');
    if (el) el.textContent = v?.prose || '—';
}

function updateChronicleDisplay() {
    const v = getActiveVerse();
    setVal('dmv-chronicle', v?.chronicle || '');
}

function renderBeats() {
    const container = document.getElementById('dmv-beats');
    const v = getActiveVerse();
    if (!container || !v) return;
    if (v.futureBeats.length === 0) {
        container.innerHTML = '<div class="dmv-empty">No future beats. Pre-author the arc — they stay dark until reached.</div>';
        return;
    }
    container.innerHTML = v.futureBeats.map(b => `
        <div class="dmv-beat ${b.revealed ? 'revealed' : ''}" data-id="${b.id}">
            <span class="dmv-beat-dot">${b.revealed ? '◉' : '○'}</span>
            <span class="dmv-beat-text">${escapeHtml(b.text)}</span>
            <span class="dmv-beat-del fa-solid fa-xmark" data-id="${b.id}" title="Delete"></span>
        </div>`).join('');
    container.querySelectorAll('.dmv-beat-del').forEach(el => {
        el.addEventListener('click', () => {
            v.futureBeats = v.futureBeats.filter(b => b.id !== el.dataset.id);
            saveSettings();
            renderBeats();
        });
    });
}

function renderDMChat() {
    const container = document.getElementById('dmv-dmchat');
    const v = getActiveVerse();
    if (!container || !v) return;
    if (v.dmChat.length === 0) {
        container.innerHTML = '<div class="dmv-empty">Tell the world-keeper what world you want and hand it the backstory.</div>';
        return;
    }
    container.innerHTML = v.dmChat.slice(-20).map(m =>
        `<div class="dmv-msg dmv-msg-${m.role}"><b>${m.role === 'user' ? 'You' : 'DM'}:</b> ${escapeHtml(m.content)}</div>`).join('');
    container.scrollTop = container.scrollHeight;
}

function updateLibrary() {
    const container = document.getElementById('dmv-library');
    if (!container) return;
    const chatData = getChatData();
    const entries = Object.values(settings.verseLibrary);
    if (entries.length === 0) {
        container.innerHTML = '<div class="dmv-empty">No verses yet. Click "+ New Verse" to start one.</div>';
        return;
    }
    container.innerHTML = entries.map(v => {
        const active = v.id === chatData.activeVerseId;
        const beats = v.futureBeats.filter(b => !b.revealed).length;
        return `<div class="dmv-lib-item ${active ? 'active' : ''}" data-id="${v.id}">
            <span class="dmv-lib-name">🌐 ${escapeHtml(v.name)}</span>
            <span class="dmv-lib-meta">${v.scene.location || 'no scene'}${beats ? ` · ${beats} dark` : ''}</span>
        </div>`;
    }).join('');
    container.querySelectorAll('.dmv-lib-item').forEach(item => {
        item.addEventListener('click', () => {
            const select = document.getElementById('dmv-verse-select');
            if (select) { select.value = item.dataset.id; select.dispatchEvent(new Event('change')); }
        });
    });
}

// =============================================================================
// Panel toggle + helpers
// =============================================================================

function togglePanel(force) {
    const panel = document.getElementById('dmv-panel');
    if (!panel) return;
    if (force === true) panel.classList.add('dmv-open');
    else if (force === false) panel.classList.remove('dmv-open');
    else panel.classList.toggle('dmv-open');
}

function updateFabVisibility() {
    const fab = document.getElementById('dmv-fab');
    if (!fab) return;
    if (settings.enabled && settings.showFab) fab.classList.add('dmv-fab-visible');
    else fab.classList.remove('dmv-fab-visible');
}

function updateProcessingIndicator(show) {
    const el = document.getElementById('dmv-processing');
    if (el) el.style.display = show ? 'inline' : 'none';
}

function bind(id, evt, fn) {
    document.getElementById(id)?.addEventListener(evt, fn);
}
function val(id) {
    return document.getElementById(id)?.value || '';
}
function setVal(id, v) {
    const el = document.getElementById(id);
    if (el && el !== document.activeElement) el.value = v || '';
}
function setVisible(id, vis) {
    const el = document.getElementById(id);
    if (el) el.style.display = vis ? '' : 'none';
}
function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function debounce(fn, delay) {
    let t;
    return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), delay); };
}

// =============================================================================
// Auto-init
// =============================================================================

try {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(() => { try { init(); } catch (e) { console.error('[Multiverse] Init failed:', e); } }, 1500));
    } else {
        setTimeout(() => { try { init(); } catch (e) { console.error('[Multiverse] Init failed:', e); } }, 1500);
    }
} catch (e) {
    console.error('[Multiverse] Setup failed:', e);
}

export default { init };
