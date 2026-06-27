/**
 * Media World — Multiverse RP World-Keeper
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

const EXT_ID = 'media-world';
const SCENE_PROMPT_ID = 'media_world_scene';
const CHRONICLE_PROMPT_ID = 'media_world_chronicle';
const STORAGE_KEY = 'media_world_settings';
const CHAT_META_KEY = 'media_world';

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
    console.log('[MediaWorld] Initializing...');
    loadSettings();
    injectSettingsUI();
    injectPanelUI();
    updateUI();

    eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    console.log('[MediaWorld] Ready!');
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
        console.warn('[MediaWorld] Failed to load settings:', e);
    }
}

function saveSettings() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
        console.warn('[MediaWorld] Failed to save settings:', e);
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
        console.warn('[MediaWorld] Failed to save chat data:', e);
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
        console.warn('[MediaWorld] No API key configured');
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
                'X-Title': 'Media World'
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            console.warn(`[MediaWorld] API Error ${response.status}: ${errText.slice(0, 200)}`);
            return null;
        }

        const data = await response.json();
        return data?.choices?.[0]?.message?.content
            || data?.choices?.[0]?.text
            || data?.output_text
            || '';
    } catch (e) {
        console.warn('[MediaWorld] API call failed:', e);
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
            console.warn('[MediaWorld] DM returned unparseable output');
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
        console.log('[MediaWorld] DM advanced the world', refreshMemory ? '(memory refreshed)' : '');
    } catch (e) {
        console.warn('[MediaWorld] runDM failed:', e);
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
    <div id="mw-settings" class="media-world-block">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Media World</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="padding:10px;">
                <label class="mw-check"><input type="checkbox" id="mw-enabled" ${settings.enabled ? 'checked' : ''}> Enable Media World</label>
                <label class="mw-check"><input type="checkbox" id="mw-auto-run" ${settings.autoRun ? 'checked' : ''}> Run DM automatically each turn</label>
                <label class="mw-check"><input type="checkbox" id="mw-show-fab" ${settings.showFab ? 'checked' : ''}> Show floating button</label>

                <div class="mw-grid2">
                    <div><label>Scene depth</label><input type="number" id="mw-scene-depth" value="${settings.sceneDepth}" min="0" max="50"></div>
                    <div><label>Chronicle depth</label><input type="number" id="mw-chronicle-depth" value="${settings.chronicleDepth}" min="0" max="100"></div>
                    <div><label>Msgs DM sees</label><input type="number" id="mw-msg-depth" value="${settings.messageDepth}" min="2" max="30"></div>
                    <div><label>Re-condense every</label><input type="number" id="mw-condense-every" value="${settings.condenseEvery}" min="1" max="50"></div>
                </div>

                <div class="mw-api">
                    <label class="mw-api-title">External DM API</label>
                    <select id="mw-api-provider">
                        <option value="openrouter" ${settings.apiProvider === 'openrouter' ? 'selected' : ''}>OpenRouter</option>
                        <option value="moonshot" ${settings.apiProvider === 'moonshot' ? 'selected' : ''}>Moonshot AI</option>
                        <option value="glm" ${settings.apiProvider === 'glm' ? 'selected' : ''}>GLM / Zhipu AI</option>
                        <option value="custom" ${settings.apiProvider === 'custom' ? 'selected' : ''}>Custom Endpoint</option>
                    </select>
                    <input type="password" id="mw-api-key" value="${escapeHtml(settings.apiKey)}" placeholder="API key">
                    <input type="text" id="mw-api-endpoint" value="${escapeHtml(settings.apiEndpoint)}" placeholder="Endpoint URL">
                    <input type="text" id="mw-api-model" value="${escapeHtml(settings.apiModel)}" placeholder="Model (e.g. moonshotai/kimi-k2)">
                    <div id="mw-model-hint" class="mw-hint"></div>
                    <div class="mw-btn-row">
                        <button id="mw-api-test" class="mw-btn mw-btn-info">Test</button>
                        <button id="mw-api-save" class="mw-btn mw-btn-ok">Save</button>
                    </div>
                    <div id="mw-api-status" class="mw-status"></div>
                </div>

                <button id="mw-open-panel" class="menu_button" style="width:100%;margin-top:8px;">Open World Manager</button>
            </div>
        </div>
    </div>`;

    const targets = ['#extensions_settings2', '#extensions_settings', '#extension_settings'];
    for (const sel of targets) {
        const t = document.querySelector(sel);
        if (t) { t.insertAdjacentHTML('beforeend', html); break; }
    }

    bind('mw-enabled', 'change', e => { settings.enabled = e.target.checked; saveSettings(); settings.enabled ? injectVerse() : clearInjection(); updateFabVisibility(); });
    bind('mw-auto-run', 'change', e => { settings.autoRun = e.target.checked; saveSettings(); });
    bind('mw-show-fab', 'change', e => { settings.showFab = e.target.checked; saveSettings(); updateFabVisibility(); });
    bind('mw-scene-depth', 'change', e => { settings.sceneDepth = parseInt(e.target.value) || 3; saveSettings(); injectVerse(); });
    bind('mw-chronicle-depth', 'change', e => { settings.chronicleDepth = parseInt(e.target.value) || 10; saveSettings(); injectVerse(); });
    bind('mw-msg-depth', 'change', e => { settings.messageDepth = parseInt(e.target.value) || 6; saveSettings(); });
    bind('mw-condense-every', 'change', e => { settings.condenseEvery = parseInt(e.target.value) || 4; saveSettings(); });
    bind('mw-open-panel', 'click', () => togglePanel(true));

    bind('mw-api-provider', 'change', e => {
        settings.apiProvider = e.target.value;
        const preset = PROVIDER_PRESETS[e.target.value] || PROVIDER_PRESETS.custom;
        if (e.target.value !== 'custom') {
            const ep = document.getElementById('mw-api-endpoint');
            if (ep) { ep.value = preset.endpoint; settings.apiEndpoint = preset.endpoint; }
        }
        const hint = document.getElementById('mw-model-hint');
        if (hint) hint.textContent = preset.hint;
        saveSettings();
    });
    const hint = document.getElementById('mw-model-hint');
    if (hint) hint.textContent = (PROVIDER_PRESETS[settings.apiProvider] || PROVIDER_PRESETS.custom).hint;

    bind('mw-api-save', 'click', () => {
        settings.apiKey = val('mw-api-key');
        settings.apiEndpoint = val('mw-api-endpoint');
        settings.apiModel = val('mw-api-model');
        saveSettings();
        showApiStatus('Saved!', 'ok');
    });
    bind('mw-api-test', 'click', async () => {
        settings.apiKey = val('mw-api-key');
        settings.apiEndpoint = val('mw-api-endpoint');
        settings.apiModel = val('mw-api-model');
        saveSettings();
        showApiStatus('Testing...', 'info');
        const r = await testExternalAPI();
        showApiStatus(r.ok ? 'Connection OK!' : `Failed: ${r.error}`, r.ok ? 'ok' : 'error');
    });
}

function showApiStatus(msg, type) {
    const el = document.getElementById('mw-api-status');
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
    <button id="mw-fab" title="Media World"><span style="font-size:22px;">🌌</span></button>

    <div id="mw-panel">
        <div class="mw-header">
            <span>🌌 Media World</span>
            <span>
                <span id="mw-processing" class="mw-proc">working…</span>
                <span class="mw-close fa-solid fa-xmark" id="mw-panel-close"></span>
            </span>
        </div>

        <div class="mw-body">
            <!-- Verse selector (multiverse) -->
            <div class="mw-section">
                <label>Active Verse</label>
                <select id="mw-verse-select"><option value="">— None —</option></select>
                <div class="mw-btn-row">
                    <button class="mw-btn mw-btn-ok" id="mw-new-verse">+ New Verse</button>
                    <button class="mw-btn mw-btn-danger" id="mw-delete-verse">Delete</button>
                </div>
                <div class="mw-new-form" id="mw-new-verse-form">
                    <input type="text" id="mw-new-verse-name" placeholder="Verse name (e.g. Hogwarts — Year 5)">
                    <div class="mw-btn-row" style="margin-top:6px;">
                        <button class="mw-btn mw-btn-ok" id="mw-create-verse">Create</button>
                        <button class="mw-btn" id="mw-cancel-verse">Cancel</button>
                    </div>
                </div>
            </div>

            <div id="mw-active" style="display:none;">
                <!-- Run controls -->
                <div class="mw-section mw-run-row">
                    <button class="mw-btn mw-btn-primary" id="mw-run-dm">▶ Advance World</button>
                    <button class="mw-btn" id="mw-recondense" title="Re-condense the long-term memory from canon">↻ Re-condense</button>
                </div>

                <!-- Latest prose (your side) -->
                <div class="mw-section">
                    <label>Now (your narration)</label>
                    <div id="mw-prose" class="mw-prose">—</div>
                </div>

                <!-- Scene widgets -->
                <div class="mw-section">
                    <label>Scene</label>
                    <div class="mw-grid2">
                        <input type="text" id="mw-sc-weather" placeholder="weather">
                        <input type="text" id="mw-sc-time" placeholder="time">
                        <input type="text" id="mw-sc-mood" placeholder="mood">
                        <input type="text" id="mw-sc-location" placeholder="location">
                    </div>
                    <label class="mw-sub">Present cast (one per line: Name — note)</label>
                    <textarea id="mw-sc-characters" rows="2" placeholder="Abraxas Malfoy — smirking&#10;Greta Hellwig — unimpressed"></textarea>
                    <label class="mw-sub">Threads / gossip (one per line)</label>
                    <textarea id="mw-sc-threads" rows="2" placeholder="new professor incoming"></textarea>
                    <label class="mw-sub">Compiled &lt;currently&gt; (injected at depth ${settings.sceneDepth})</label>
                    <textarea id="mw-sc-currently" rows="4" placeholder="The DM writes this each turn — you can edit it."></textarea>
                </div>

                <!-- Map -->
                <div class="mw-section">
                    <label>Map — known locations (one per line)</label>
                    <textarea id="mw-locations" rows="3" placeholder="Great Hall&#10;Slytherin Common Room&#10;Astronomy Tower"></textarea>
                </div>

                <!-- Canon -->
                <div class="mw-section">
                    <label>Canon — full history (stays out of Caleb's window)</label>
                    <textarea id="mw-canon" rows="6" placeholder="Paste the full backstory / everything established. The DM holds this and feeds Caleb only a condensed version."></textarea>
                </div>

                <!-- Chronicle -->
                <div class="mw-section">
                    <label>Chronicle — condensed memory (injected at depth ${settings.chronicleDepth})</label>
                    <textarea id="mw-chronicle" rows="4" placeholder="Auto-condensed from canon. Second person — his memory."></textarea>
                </div>

                <!-- Future beats (spoiler gate) -->
                <div class="mw-section">
                    <label>Future beats — dark until reached</label>
                    <div id="mw-beats"></div>
                    <div class="mw-btn-row" style="margin-top:6px;">
                        <input type="text" id="mw-new-beat" placeholder="A beat that hasn't happened yet…" style="flex:1;">
                        <button class="mw-btn mw-btn-ok" id="mw-add-beat">+ Add</button>
                    </div>
                </div>

                <!-- DM chat -->
                <div class="mw-section">
                    <label>Talk to the World-Keeper</label>
                    <div id="mw-dmchat" class="mw-dmchat"></div>
                    <div class="mw-btn-row">
                        <input type="text" id="mw-dm-input" placeholder="Set up the world, hand it backstory, pre-author beats…" style="flex:1;">
                        <button class="mw-btn mw-btn-primary" id="mw-dm-send">Send</button>
                    </div>
                </div>
            </div>

            <!-- Library -->
            <div class="mw-section">
                <label>Verse Library</label>
                <div id="mw-library"></div>
            </div>
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', html);
    bindPanelEvents();
    updateFabVisibility();
}

function bindPanelEvents() {
    bind('mw-fab', 'click', () => togglePanel());
    bind('mw-panel-close', 'click', () => togglePanel(false));

    bind('mw-verse-select', 'change', onVerseSelected);
    bind('mw-new-verse', 'click', () => document.getElementById('mw-new-verse-form')?.classList.toggle('mw-visible'));
    bind('mw-cancel-verse', 'click', () => document.getElementById('mw-new-verse-form')?.classList.remove('mw-visible'));
    bind('mw-create-verse', 'click', onCreateVerse);
    bind('mw-delete-verse', 'click', onDeleteVerse);

    bind('mw-run-dm', 'click', () => runDM());
    bind('mw-recondense', 'click', () => recondenseNow());

    // Scene field edits
    bind('mw-sc-weather', 'input', debounce(saveSceneFields, 500));
    bind('mw-sc-time', 'input', debounce(saveSceneFields, 500));
    bind('mw-sc-mood', 'input', debounce(saveSceneFields, 500));
    bind('mw-sc-location', 'input', debounce(saveSceneFields, 500));
    bind('mw-sc-characters', 'input', debounce(saveSceneFields, 500));
    bind('mw-sc-threads', 'input', debounce(saveSceneFields, 500));
    bind('mw-sc-currently', 'input', debounce(() => { const v = getActiveVerse(); if (v) { v.scene.currently = val('mw-sc-currently'); saveSettings(); injectVerse(); } }, 500));

    bind('mw-locations', 'input', debounce(() => {
        const v = getActiveVerse(); if (!v) return;
        v.world.locations = val('mw-locations').split('\n').map(s => s.trim()).filter(Boolean).map(name => ({ name, note: '' }));
        saveSettings();
    }, 500));

    bind('mw-canon', 'input', debounce(() => { const v = getActiveVerse(); if (v) { v.canon = val('mw-canon'); saveSettings(); } }, 600));
    bind('mw-chronicle', 'input', debounce(() => { const v = getActiveVerse(); if (v) { v.chronicle = val('mw-chronicle'); saveSettings(); injectVerse(); } }, 600));

    bind('mw-add-beat', 'click', onAddBeat);
    bind('mw-new-beat', 'keydown', e => { if (e.key === 'Enter') onAddBeat(); });

    bind('mw-dm-send', 'click', sendDMMessage);
    bind('mw-dm-input', 'keydown', e => { if (e.key === 'Enter') sendDMMessage(); });
}

function sendDMMessage() {
    const input = document.getElementById('mw-dm-input');
    if (!input || !input.value.trim()) return;
    const msg = input.value;
    input.value = '';
    chatWithDM(msg);
}

function saveSceneFields() {
    const v = getActiveVerse();
    if (!v) return;
    v.scene.weather = val('mw-sc-weather');
    v.scene.time = val('mw-sc-time');
    v.scene.mood = val('mw-sc-mood');
    v.scene.location = val('mw-sc-location');
    v.scene.characters = val('mw-sc-characters').split('\n').map(s => s.trim()).filter(Boolean).map(line => {
        const [name, note] = line.split(/\s*[—-]\s*/);
        return { name: (name || '').trim(), note: (note || '').trim() };
    }).filter(c => c.name);
    v.scene.threads = val('mw-sc-threads').split('\n').map(s => s.trim()).filter(Boolean);
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
    const nameInput = document.getElementById('mw-new-verse-name');
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
    document.getElementById('mw-new-verse-form')?.classList.remove('mw-visible');
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
    const input = document.getElementById('mw-new-beat');
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

    const select = document.getElementById('mw-verse-select');
    if (select) {
        select.innerHTML = '<option value="">— None —</option>' +
            Object.values(settings.verseLibrary).map(v =>
                `<option value="${v.id}" ${v.id === activeId ? 'selected' : ''}>🌐 ${escapeHtml(v.name)}</option>`).join('');
    }

    const verse = getActiveVerse();
    setVisible('mw-active', !!verse);

    if (verse) {
        setVal('mw-sc-weather', verse.scene.weather);
        setVal('mw-sc-time', verse.scene.time);
        setVal('mw-sc-mood', verse.scene.mood);
        setVal('mw-sc-location', verse.scene.location);
        setVal('mw-sc-characters', verse.scene.characters.map(c => c.note ? `${c.name} — ${c.note}` : c.name).join('\n'));
        setVal('mw-sc-threads', verse.scene.threads.join('\n'));
        setVal('mw-sc-currently', verse.scene.currently);
        setVal('mw-locations', verse.world.locations.map(l => l.name).join('\n'));
        setVal('mw-canon', verse.canon);
        setVal('mw-chronicle', verse.chronicle);
        updateProseDisplay();
        renderBeats();
        renderDMChat();
    }

    updateLibrary();
}

function updateSceneDisplay() {
    const v = getActiveVerse();
    if (!v) return;
    setVal('mw-sc-weather', v.scene.weather);
    setVal('mw-sc-time', v.scene.time);
    setVal('mw-sc-mood', v.scene.mood);
    setVal('mw-sc-location', v.scene.location);
    setVal('mw-sc-characters', v.scene.characters.map(c => c.note ? `${c.name} — ${c.note}` : c.name).join('\n'));
    setVal('mw-sc-threads', v.scene.threads.join('\n'));
    setVal('mw-sc-currently', v.scene.currently);
}

function updateProseDisplay() {
    const v = getActiveVerse();
    const el = document.getElementById('mw-prose');
    if (el) el.textContent = v?.prose || '—';
}

function updateChronicleDisplay() {
    const v = getActiveVerse();
    setVal('mw-chronicle', v?.chronicle || '');
}

function renderBeats() {
    const container = document.getElementById('mw-beats');
    const v = getActiveVerse();
    if (!container || !v) return;
    if (v.futureBeats.length === 0) {
        container.innerHTML = '<div class="mw-empty">No future beats. Pre-author the arc — they stay dark until reached.</div>';
        return;
    }
    container.innerHTML = v.futureBeats.map(b => `
        <div class="mw-beat ${b.revealed ? 'revealed' : ''}" data-id="${b.id}">
            <span class="mw-beat-dot">${b.revealed ? '◉' : '○'}</span>
            <span class="mw-beat-text">${escapeHtml(b.text)}</span>
            <span class="mw-beat-del fa-solid fa-xmark" data-id="${b.id}" title="Delete"></span>
        </div>`).join('');
    container.querySelectorAll('.mw-beat-del').forEach(el => {
        el.addEventListener('click', () => {
            v.futureBeats = v.futureBeats.filter(b => b.id !== el.dataset.id);
            saveSettings();
            renderBeats();
        });
    });
}

function renderDMChat() {
    const container = document.getElementById('mw-dmchat');
    const v = getActiveVerse();
    if (!container || !v) return;
    if (v.dmChat.length === 0) {
        container.innerHTML = '<div class="mw-empty">Tell the world-keeper what world you want and hand it the backstory.</div>';
        return;
    }
    container.innerHTML = v.dmChat.slice(-20).map(m =>
        `<div class="mw-msg mw-msg-${m.role}"><b>${m.role === 'user' ? 'You' : 'DM'}:</b> ${escapeHtml(m.content)}</div>`).join('');
    container.scrollTop = container.scrollHeight;
}

function updateLibrary() {
    const container = document.getElementById('mw-library');
    if (!container) return;
    const chatData = getChatData();
    const entries = Object.values(settings.verseLibrary);
    if (entries.length === 0) {
        container.innerHTML = '<div class="mw-empty">No verses yet. Click "+ New Verse" to start one.</div>';
        return;
    }
    container.innerHTML = entries.map(v => {
        const active = v.id === chatData.activeVerseId;
        const beats = v.futureBeats.filter(b => !b.revealed).length;
        return `<div class="mw-lib-item ${active ? 'active' : ''}" data-id="${v.id}">
            <span class="mw-lib-name">🌐 ${escapeHtml(v.name)}</span>
            <span class="mw-lib-meta">${v.scene.location || 'no scene'}${beats ? ` · ${beats} dark` : ''}</span>
        </div>`;
    }).join('');
    container.querySelectorAll('.mw-lib-item').forEach(item => {
        item.addEventListener('click', () => {
            const select = document.getElementById('mw-verse-select');
            if (select) { select.value = item.dataset.id; select.dispatchEvent(new Event('change')); }
        });
    });
}

// =============================================================================
// Panel toggle + helpers
// =============================================================================

function togglePanel(force) {
    const panel = document.getElementById('mw-panel');
    if (!panel) return;
    if (force === true) panel.classList.add('mw-open');
    else if (force === false) panel.classList.remove('mw-open');
    else panel.classList.toggle('mw-open');
}

function updateFabVisibility() {
    const fab = document.getElementById('mw-fab');
    if (!fab) return;
    if (settings.enabled && settings.showFab) fab.classList.add('mw-fab-visible');
    else fab.classList.remove('mw-fab-visible');
}

function updateProcessingIndicator(show) {
    const el = document.getElementById('mw-processing');
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
        document.addEventListener('DOMContentLoaded', () => setTimeout(() => { try { init(); } catch (e) { console.error('[MediaWorld] Init failed:', e); } }, 1500));
    } else {
        setTimeout(() => { try { init(); } catch (e) { console.error('[MediaWorld] Init failed:', e); } }, 1500);
    }
} catch (e) {
    console.error('[MediaWorld] Setup failed:', e);
}

export default { init };
