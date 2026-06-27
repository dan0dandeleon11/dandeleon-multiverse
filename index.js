/**
 * Dandeleon Multiverse — Multiverse RP World-Keeper
 *
 * An external DM manages each verse. The full canon lives OUTSIDE Caleb's
 * window; three condensed tiers are injected at editable depths:
 *   - <currently>      shallow (depth ~3)  — the live scene
 *   - <canon_summary>  mid     (depth ~10) — prose background, regenerable
 *   - <canon_timeline> deep    (depth ~20) — beat list, up to the {bookmark}
 * Entries after the {bookmark} stay dark (spoiler gate).
 *
 * Built on the caleb-media-companion engine. By Lei.
 */

import { eventSource, event_types, extension_prompt_types, setExtensionPrompt } from '../../../../script.js';
import { getContext } from '../../../extensions.js';

const EXT_ID = 'dandeleon-multiverse';
const SCENE_PROMPT_ID = 'dandeleon_multiverse_scene';
const SUMMARY_PROMPT_ID = 'dandeleon_multiverse_summary';
const TIMELINE_PROMPT_ID = 'dandeleon_multiverse_timeline';
const STORAGE_KEY = 'dandeleon_multiverse_settings';
const CHAT_META_KEY = 'dandeleon_multiverse';

// =============================================================================
// Defaults
// =============================================================================

const PROVIDER_PRESETS = {
    openrouter: { endpoint: 'https://openrouter.ai/api/v1/chat/completions', hint: 'e.g. moonshotai/kimi-k2' },
    moonshot:   { endpoint: 'https://api.moonshot.ai/v1/chat/completions', hint: 'moonshot-v1-8k / -32k' },
    glm:        { endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', hint: 'glm-4-flash (free!), glm-4-air' },
    custom:     { endpoint: '', hint: 'Any OpenAI-compatible endpoint' }
};

const DEFAULT_SETTINGS = {
    enabled: true,
    autoRun: true,
    showFab: true,
    weatherFx: true,
    messageDepth: 6,
    apiProvider: 'openrouter',
    apiEndpoint: 'https://openrouter.ai/api/v1/chat/completions',
    apiKey: '',
    apiModel: 'moonshotai/kimi-k2',
    verseLibrary: {}
};

function defaultVerse(id, name) {
    return {
        id,
        name,
        // CANON TIMELINE (deep)
        timeline: '',
        timelineDepth: 20,
        timelineCadence: 5,
        turnsSinceTimeline: 0,
        // SUMMARIZED CANON (mid)
        summary: '',
        summaryDepth: 10,
        summaryUpToPast: 3,
        // Live scene (shallow)
        scene: { weather: '', time: '', mood: '', location: '', characters: [], threads: [], currently: '' },
        sceneDepth: 3,
        prose: '',
        // World
        world: { locations: [] },
        options: { locations: [], people: [] },
        dmChat: []
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
    injectWeatherLayer();
    updateUI();

    eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    console.log('[Multiverse] Ready!');
}

// =============================================================================
// Persistence
// =============================================================================

function loadSettings() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            settings = { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
            if (!settings.verseLibrary) settings.verseLibrary = {};
        }
    } catch (e) { console.warn('[Multiverse] load failed:', e); }
}

function saveSettings() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); }
    catch (e) { console.warn('[Multiverse] save failed:', e); }
}

function getChatData() {
    try {
        const ctx = getContext();
        if (ctx.chat_metadata) {
            if (!ctx.chat_metadata[CHAT_META_KEY]) ctx.chat_metadata[CHAT_META_KEY] = fallbackChatData || { activeVerseId: null };
            fallbackChatData = ctx.chat_metadata[CHAT_META_KEY];
            return ctx.chat_metadata[CHAT_META_KEY];
        }
    } catch (e) { /* fall through */ }
    if (!fallbackChatData) fallbackChatData = { activeVerseId: null };
    return fallbackChatData;
}

function saveChatData(data) {
    fallbackChatData = data;
    try { const ctx = getContext(); if (ctx.chat_metadata) ctx.chat_metadata[CHAT_META_KEY] = data; }
    catch (e) { console.warn('[Multiverse] save chat failed:', e); }
}

function getActiveVerse() {
    const cd = getChatData();
    return cd.activeVerseId ? (settings.verseLibrary[cd.activeVerseId] || null) : null;
}

// =============================================================================
// External API
// =============================================================================

async function callExternalAPI(messages, opts = {}) {
    if (!settings.apiKey) { console.warn('[Multiverse] no API key'); return null; }
    const body = { model: settings.apiModel, messages, max_tokens: opts.maxTokens || 1200, temperature: opts.temperature ?? 0.7, stream: false };
    try {
        const r = await fetch(settings.apiEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}`, 'HTTP-Referer': 'https://github.com/SillyTavern/SillyTavern', 'X-Title': 'Dandeleon Multiverse' },
            body: JSON.stringify(body)
        });
        if (!r.ok) { console.warn(`[Multiverse] API ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`); return null; }
        const d = await r.json();
        return d?.choices?.[0]?.message?.content || d?.choices?.[0]?.text || d?.output_text || '';
    } catch (e) { console.warn('[Multiverse] API failed:', e); return null; }
}

async function testExternalAPI() {
    try {
        const r = await callExternalAPI([{ role: 'user', content: 'Reply with exactly: ok' }], { maxTokens: 10, temperature: 0 });
        return (r && r.toLowerCase().includes('ok')) ? { ok: true } : { ok: false, error: r || 'Empty response' };
    } catch (e) { return { ok: false, error: e.message }; }
}

function extractJSON(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { /* slice */ }
    const s = text.indexOf('{'), e = text.lastIndexOf('}');
    if (s !== -1 && e > s) { try { return JSON.parse(text.slice(s, e + 1)); } catch (x) { /* */ } }
    return null;
}

// =============================================================================
// Time / weather helpers (yoinked from RPG Companion weatherEffects.js)
// =============================================================================

function parseHourFromTime(timeStr) {
    if (!timeStr) return null;
    const t = timeStr.toLowerCase().trim();
    if (t.includes('dawn') || t.includes('sunrise')) return 6;
    if (t.includes('early morning')) return 7;
    if (t.includes('morning')) return 9;
    if (t.includes('midday') || t.includes('noon')) return 12;
    if (t.includes('late afternoon')) return 16;
    if (t.includes('afternoon')) return 14;
    if (t.includes('evening') || t.includes('dusk') || t.includes('sunset')) return 19;
    if (t.includes('twilight')) return 20;
    if (t.includes('midnight')) return 0;
    if (t.includes('late night')) return 2;
    if (t.includes('night')) return 22;
    const ampm = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
    if (ampm) { let h = parseInt(ampm[1], 10); const pm = ampm[3].toLowerCase() === 'pm'; if (pm && h !== 12) h += 12; if (!pm && h === 12) h = 0; return h; }
    const mil = t.match(/(\d{1,2}):(\d{2})/);
    if (mil) return parseInt(mil[1], 10);
    return null;
}

function getTimeOfDay(hour) {
    if (hour === null) return 'day';
    if (hour >= 20 || hour < 5) return 'night';
    if (hour >= 5 && hour < 7) return 'dawn';
    if (hour >= 18 && hour < 20) return 'dusk';
    return 'day';
}

function weatherKind(weather) {
    const w = (weather || '').toLowerCase();
    if (/(storm|thunder|lightning)/.test(w)) return 'storm';
    if (/(snow|blizzard|sleet)/.test(w)) return 'snow';
    if (/(rain|drizzle|shower|pour)/.test(w)) return 'rain';
    if (/(fog|mist|haze|smog)/.test(w)) return 'fog';
    return 'clear';
}

function injectWeatherLayer() {
    if (document.getElementById('dmv-weather-fx')) return;
    document.body.insertAdjacentHTML('beforeend', '<div id="dmv-weather-fx"></div>');
}

function applyWeatherFx() {
    const el = document.getElementById('dmv-weather-fx');
    if (!el) return;
    const v = getActiveVerse();
    if (!settings.weatherFx || !settings.enabled || !v) { el.className = ''; return; }
    const kind = weatherKind(v.scene.weather);
    const tod = getTimeOfDay(parseHourFromTime(v.scene.time));
    el.className = `dmv-fx-${kind} dmv-tod-${tod}`;
}

function weatherIcon(weather, tod) {
    const k = weatherKind(weather);
    if (k === 'storm') return '⛈️';
    if (k === 'snow') return '❄️';
    if (k === 'rain') return '🌧️';
    if (k === 'fog') return '🌫️';
    return tod === 'night' ? '🌙' : (tod === 'dawn' || tod === 'dusk') ? '🌅' : '☀️';
}

// =============================================================================
// DM head — per-turn scene + (on cadence) timeline
// =============================================================================

const DM_SYSTEM = `You are the GAME MASTER and world engine for an ongoing roleplay in a specific universe. You manage everything AROUND the user's scene partner — weather, location, other characters present, events, gossip, atmosphere, the rerolls of fate. You NEVER write the scene partner's dialogue/actions (a separate model does) and you NEVER write for the user.

CRITICAL DISCIPLINE: only change a scene field (weather/time/location/mood/characters) if the latest roleplay EXPLICITLY establishes the change. Otherwise repeat the previous value verbatim. Never advance time, move location, or add/remove present characters unless the text clearly does. Do not invent state the text doesn't support.

Output STRICT JSON ONLY:
{
  "prose": "Cinematic narration of the present moment for the human to read (2-5 sentences).",
  "currently": "COMPACT scene block for the partner's context. Shape:\\nweather|mood|time tags\\naudience: <count> (<named characters present>)\\ngossip: <active thread>\\n\\n<0-4 lines of live banter from OTHER present characters, Name: line>",
  "scene": { "weather":"", "time":"", "mood":"", "location":"", "characters":[{"name":"","note":""}], "threads":[""] },
  "timeline": "ONLY when UPDATE_TIMELINE is yes, else empty string. Return the FULL updated canon timeline text. PRESERVE the user's existing lines and ESPECIALLY everything after the {curly-brace bookmark} (their planned future) — never delete or spoil it. Add 1-3 short lines for what has actually happened since the bookmark, then move the {curly braces} onto the new current line. One line per beat: '- <when> - <what>'."
}`;

function getRecentMessages(depth) {
    try {
        const ctx = getContext();
        const chat = ctx?.chat;
        if (!chat || !chat.length) return [];
        const out = [];
        for (let i = chat.length - 1; i >= 0 && out.length < depth; i--) {
            const m = chat[i];
            if (m && m.mes) out.unshift(`${m.is_user ? 'User' : 'Partner'}: ${m.mes}`);
        }
        return out;
    } catch (e) { return []; }
}

function buildDMUserPrompt(v, recent, updateTimeline) {
    const cast = v.scene.characters.map(c => `${c.name}${c.note ? ` (${c.note})` : ''}`).join(', ') || '(none set)';
    return `VERSE: ${v.name}

CANON TIMELINE (the {curly braces} mark the current moment; lines after are planned future):
${v.timeline || '(empty)'}

SUMMARIZED CANON (background):
${v.summary || '(empty)'}

CURRENT SCENE:
- weather: ${v.scene.weather || '?'}
- time: ${v.scene.time || '?'}
- mood: ${v.scene.mood || '?'}
- location: ${v.scene.location || '?'}
- present: ${cast}
- threads: ${v.scene.threads.join('; ') || '(none)'}

RECENT ROLEPLAY:
${recent.join('\n') || '(start of scene)'}

UPDATE_TIMELINE: ${updateTimeline ? 'yes' : 'no'}

Advance the world one beat in response to the latest action. Return the JSON.`;
}

async function runDM() {
    const v = getActiveVerse();
    if (!v || isRunning) return;
    const recent = getRecentMessages(settings.messageDepth);
    if (!recent.length) return;

    const updateTimeline = (v.turnsSinceTimeline || 0) >= v.timelineCadence;

    isRunning = true;
    setProcessing(true);
    try {
        const raw = await callExternalAPI(
            [{ role: 'system', content: DM_SYSTEM }, { role: 'user', content: buildDMUserPrompt(v, recent, updateTimeline) }],
            { maxTokens: 1500, temperature: 0.8 }
        );
        const res = extractJSON(raw);
        if (!res) { console.warn('[Multiverse] DM unparseable'); return; }

        if (res.scene && typeof res.scene === 'object') {
            const s = res.scene;
            v.scene.weather = s.weather ?? v.scene.weather;
            v.scene.time = s.time ?? v.scene.time;
            v.scene.mood = s.mood ?? v.scene.mood;
            v.scene.location = s.location ?? v.scene.location;
            if (Array.isArray(s.characters)) v.scene.characters = s.characters.filter(c => c && c.name);
            if (Array.isArray(s.threads)) v.scene.threads = s.threads.filter(Boolean);
        }
        if (typeof res.currently === 'string' && res.currently.trim()) v.scene.currently = res.currently.trim();

        if (updateTimeline && typeof res.timeline === 'string' && res.timeline.trim()) {
            v.timeline = res.timeline.trim();
            v.turnsSinceTimeline = 0;
        } else {
            v.turnsSinceTimeline = (v.turnsSinceTimeline || 0) + 1;
        }

        if (typeof res.prose === 'string' && res.prose.trim()) v.prose = res.prose.trim();

        saveSettings();
        injectVerse();
        applyWeatherFx();
        updateSceneDisplay();
        updateProseDisplay();
        if (updateTimeline) setVal('dmv-timeline', v.timeline);
        console.log('[Multiverse] DM advanced', updateTimeline ? '(timeline updated)' : '');
    } catch (e) { console.warn('[Multiverse] runDM failed:', e); }
    finally { isRunning = false; setProcessing(false); }
}

// =============================================================================
// Summary regeneration (button)
// =============================================================================

async function regenerateSummary() {
    const v = getActiveVerse();
    if (!v) return;
    const lines = (v.timeline || '').split('\n').map(s => s.trim()).filter(Boolean);
    const cutoff = Math.max(0, lines.length - (v.summaryUpToPast || 3));
    const toSummarize = lines.slice(0, cutoff).join('\n');
    setProcessing(true);
    try {
        const raw = await callExternalAPI([
            { role: 'system', content: 'You compress a roleplay history into concise background prose for the scene partner. Write in SECOND PERSON ("You..."). A tight paragraph or two. Only established/past facts. Output the prose only.' },
            { role: 'user', content: `VERSE: ${v.name}\n\nEVENTS TO SUMMARIZE (older beats; the most recent ${v.summaryUpToPast} are intentionally excluded):\n${toSummarize || '(nothing yet)'}\n\nWrite the condensed second-person background.` }
        ], { maxTokens: 700, temperature: 0.4 });
        if (raw && raw.trim()) {
            v.summary = raw.trim();
            saveSettings();
            injectVerse();
            setVal('dmv-summary', v.summary);
        }
    } finally { setProcessing(false); }
}

// =============================================================================
// Suggest options (locations / people) for you AND Caleb
// =============================================================================

async function suggestOptions(kind) {
    const v = getActiveVerse();
    if (!v) return;
    setProcessing(true);
    try {
        const known = kind === 'locations'
            ? v.world.locations.map(l => l.name).join(', ')
            : v.scene.characters.map(c => c.name).join(', ');
        const raw = await callExternalAPI([
            { role: 'system', content: `You propose fresh ${kind} for a roleplay world. Return ONLY a JSON array of exactly 3 objects: [{"name":"","note":"one short evocative line"}]. No prose.` },
            { role: 'user', content: `VERSE: ${v.name}\nLocation/scene: ${v.scene.location || '?'}\nAlready known: ${known || '(none)'}\n\nPropose 3 new ${kind} that fit this world.` }
        ], { maxTokens: 400, temperature: 0.9 });
        let arr = extractJSON(raw);
        if (!Array.isArray(arr)) { const m = (raw || '').match(/\[[\s\S]*\]/); if (m) { try { arr = JSON.parse(m[0]); } catch (e) { /* */ } } }
        if (Array.isArray(arr)) {
            v.options[kind] = arr.filter(o => o && o.name).slice(0, 3);
            saveSettings();
            renderOptions();
        }
    } finally { setProcessing(false); }
}

function acceptOption(kind, index) {
    const v = getActiveVerse();
    if (!v) return;
    const opt = v.options[kind]?.[index];
    if (!opt) return;
    if (kind === 'locations') v.world.locations.push({ name: opt.name, note: opt.note || '' });
    else v.scene.characters.push({ name: opt.name, note: opt.note || '' });
    v.options[kind].splice(index, 1);
    saveSettings();
    updateSceneDisplay();
    setVal('dmv-locations', v.world.locations.map(l => l.name).join('\n'));
    renderOptions();
}

// =============================================================================
// Injection — three tiers at editable depths
// =============================================================================

function timelineUpToBookmark(text) {
    if (!text) return '';
    const lines = text.split('\n');
    let bookmark = -1;
    for (let i = 0; i < lines.length; i++) if (/\{.*\}/.test(lines[i])) { bookmark = i; break; }
    const slice = bookmark === -1 ? lines : lines.slice(0, bookmark + 1);
    return slice.map(l => l.replace(/[{}]/g, '')).join('\n').trim();
}

function clearInjection() {
    setExtensionPrompt(SCENE_PROMPT_ID, '', extension_prompt_types.IN_CHAT, 3);
    setExtensionPrompt(SUMMARY_PROMPT_ID, '', extension_prompt_types.IN_CHAT, 10);
    setExtensionPrompt(TIMELINE_PROMPT_ID, '', extension_prompt_types.IN_CHAT, 20);
}

function injectVerse() {
    if (!settings.enabled) { clearInjection(); return; }
    const v = getActiveVerse();
    if (!v) { clearInjection(); return; }

    const scene = v.scene.currently?.trim() ? `<currently>\n${v.scene.currently.trim()}\n</currently>` : '';
    const summary = v.summary?.trim() ? `<canon_summary>\n${v.summary.trim()}\n</canon_summary>` : '';
    const tl = timelineUpToBookmark(v.timeline);
    const timeline = tl ? `<canon_timeline>\n${tl}\n</canon_timeline>` : '';

    setExtensionPrompt(SCENE_PROMPT_ID, scene, extension_prompt_types.IN_CHAT, v.sceneDepth || 3);
    setExtensionPrompt(SUMMARY_PROMPT_ID, summary, extension_prompt_types.IN_CHAT, v.summaryDepth || 10);
    setExtensionPrompt(TIMELINE_PROMPT_ID, timeline, extension_prompt_types.IN_CHAT, v.timelineDepth || 20);
}

// =============================================================================
// World-keeper chat
// =============================================================================

async function chatWithDM(message) {
    const v = getActiveVerse();
    if (!v || !message.trim()) return;
    v.dmChat.push({ role: 'user', content: message.trim() });
    saveSettings();
    renderDMChat();
    const sys = `You are the WORLD-KEEPER for the universe "${v.name}". Help the user build and manage it: canon, cast, locations/map, tone, future beats. Concise and collaborative.

CANON TIMELINE:\n${v.timeline || '(empty)'}\n\nSCENE: ${v.scene.location || '?'} — ${v.scene.weather || '?'}; present: ${v.scene.characters.map(c => c.name).join(', ') || 'no one'}.`;
    const history = v.dmChat.slice(-12).map(m => ({ role: m.role, content: m.content }));
    setProcessing(true);
    try {
        const reply = await callExternalAPI([{ role: 'system', content: sys }, ...history], { maxTokens: 800, temperature: 0.7 });
        if (reply && reply.trim()) { v.dmChat.push({ role: 'assistant', content: reply.trim() }); saveSettings(); renderDMChat(); }
    } finally { setProcessing(false); }
}

// =============================================================================
// Events
// =============================================================================

async function onMessageSent() {
    if (!settings.enabled) return;
    if (!getActiveVerse()) return;
    if (settings.autoRun && !isRunning) await runDM();
    else injectVerse();
}

function onGenerationStarted(type, data, dryRun) {
    if (dryRun || !settings.enabled) return;
    if (data?.quietImage || data?.quiet_image || data?.isImageGeneration) return;
    if (data?.quiet_prompt || type === 'quiet') return;
    injectVerse();
}

function onChatChanged() {
    updateUI();
    if (settings.enabled) { injectVerse(); applyWeatherFx(); }
}

// =============================================================================
// Settings UI (Extensions tab)
// =============================================================================

function injectSettingsUI() {
    const html = `
    <div id="dmv-settings" class="dandeleon-multiverse-block">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header"><b>Dandeleon Multiverse</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
            <div class="inline-drawer-content" style="padding:10px;">
                <label class="dmv-check"><input type="checkbox" id="dmv-enabled" ${settings.enabled ? 'checked' : ''}> Enable</label>
                <label class="dmv-check"><input type="checkbox" id="dmv-auto-run" ${settings.autoRun ? 'checked' : ''}> Run DM automatically each turn</label>
                <label class="dmv-check"><input type="checkbox" id="dmv-show-fab" ${settings.showFab ? 'checked' : ''}> Show floating button</label>
                <label class="dmv-check"><input type="checkbox" id="dmv-weather-fx-toggle" ${settings.weatherFx ? 'checked' : ''}> Weather visual effects</label>
                <button id="dmv-open-panel" class="menu_button" style="width:100%;margin-top:8px;">Open World Manager</button>
            </div>
        </div>
    </div>`;
    for (const sel of ['#extensions_settings2', '#extensions_settings', '#extension_settings']) {
        const t = document.querySelector(sel);
        if (t) { t.insertAdjacentHTML('beforeend', html); break; }
    }
    bind('dmv-enabled', 'change', e => { settings.enabled = e.target.checked; saveSettings(); settings.enabled ? injectVerse() : clearInjection(); applyWeatherFx(); updateFabVisibility(); });
    bind('dmv-auto-run', 'change', e => { settings.autoRun = e.target.checked; saveSettings(); });
    bind('dmv-show-fab', 'change', e => { settings.showFab = e.target.checked; saveSettings(); updateFabVisibility(); });
    bind('dmv-weather-fx-toggle', 'change', e => { settings.weatherFx = e.target.checked; saveSettings(); applyWeatherFx(); });
    bind('dmv-open-panel', 'click', () => togglePanel(true));
}

// =============================================================================
// Main panel
// =============================================================================

function injectPanelUI() {
    const html = `
    <button id="dmv-fab" title="Dandeleon Multiverse"><span style="font-size:22px;">🌌</span></button>

    <div id="dmv-panel">
        <div class="dmv-header">
            <span>🌌 Dandeleon Multiverse</span>
            <span><span id="dmv-processing" class="dmv-proc">working…</span><span class="dmv-close fa-solid fa-xmark" id="dmv-panel-close"></span></span>
        </div>

        <div class="dmv-body">
            <!-- Top controls -->
            <div class="dmv-section">
                <select id="dmv-verse-select" class="dmv-verse-picker"><option value="">— Pick a universe —</option></select>
                <div class="dmv-btn-row">
                    <button class="dmv-btn dmv-btn-ok" id="dmv-new-verse">+ New universe</button>
                    <button class="dmv-btn" id="dmv-change-llm">⚙ Change LLM</button>
                </div>
                <div class="dmv-new-form" id="dmv-new-verse-form">
                    <input type="text" id="dmv-new-verse-name" placeholder="Universe name (e.g. Hogwarts AU)">
                    <div class="dmv-btn-row" style="margin-top:6px;"><button class="dmv-btn dmv-btn-ok" id="dmv-create-verse">Create</button><button class="dmv-btn" id="dmv-cancel-verse">Cancel</button></div>
                </div>
                <div class="dmv-llm-form" id="dmv-llm-form">
                    <select id="dmv-api-provider">
                        <option value="openrouter">OpenRouter</option><option value="moonshot">Moonshot AI</option><option value="glm">GLM / Zhipu</option><option value="custom">Custom</option>
                    </select>
                    <input type="password" id="dmv-api-key" placeholder="API key">
                    <input type="text" id="dmv-api-endpoint" placeholder="Endpoint URL">
                    <input type="text" id="dmv-api-model" placeholder="Model">
                    <div class="dmv-hint" id="dmv-model-hint"></div>
                    <div class="dmv-btn-row"><button class="dmv-btn dmv-btn-info" id="dmv-api-test">Test</button><button class="dmv-btn dmv-btn-ok" id="dmv-api-save">Save</button></div>
                    <div class="dmv-status" id="dmv-api-status"></div>
                </div>
            </div>

            <div id="dmv-active" style="display:none;">
                <!-- Live scene -->
                <div class="dmv-section">
                    <div id="dmv-scene-chips" class="dmv-chips"></div>
                    <div class="dmv-btn-row"><button class="dmv-btn dmv-btn-primary" id="dmv-run-dm">▶ Advance World</button></div>
                    <div id="dmv-prose" class="dmv-prose">—</div>
                </div>

                <!-- Suggest options for you AND Caleb -->
                <div class="dmv-section">
                    <label>Suggest new…</label>
                    <div class="dmv-btn-row"><button class="dmv-btn" id="dmv-suggest-loc">✨ Locations</button><button class="dmv-btn" id="dmv-suggest-ppl">✨ People</button></div>
                    <div id="dmv-options"></div>
                </div>

                <!-- CANON TIMELINE -->
                <div class="dmv-section dmv-box">
                    <div class="dmv-box-title">CANON TIMELINE</div>
                    <div class="dmv-inline-ctrls">
                        <span>depth read <input type="number" id="dmv-tl-depth" class="dmv-num" min="0" max="100"></span>
                        <span>auto-inject every <input type="number" id="dmv-tl-cadence" class="dmv-num" min="1" max="50"> turns</span>
                    </div>
                    <div class="dmv-note">Wrap a line in { } to bookmark the current moment. Lines after it stay dark. The DM auto-updates this on the cadence above.</div>
                    <textarea id="dmv-timeline" rows="8" placeholder="- first year, month 1 - they meet&#10;- first year, month 2 - …&#10;{- first year, month 5 - she does this}&#10;- second year"></textarea>
                </div>

                <!-- SUMMARIZED CANON -->
                <div class="dmv-section dmv-box">
                    <div class="dmv-box-title">SUMMARIZED CANON <span class="dmv-box-sub">(editable)</span></div>
                    <div class="dmv-inline-ctrls">
                        <span>up until past <input type="number" id="dmv-sum-past" class="dmv-num" min="0" max="50"> events</span>
                        <span>depth <input type="number" id="dmv-sum-depth" class="dmv-num" min="0" max="100"></span>
                        <button class="dmv-btn dmv-btn-icon" id="dmv-regen-summary" title="Regenerate with the external LLM">🔄</button>
                    </div>
                    <textarea id="dmv-summary" rows="5" placeholder="Condensed background — your side editable, 🔄 regenerates from the timeline."></textarea>
                </div>

                <!-- Map -->
                <div class="dmv-section">
                    <label>Map — known locations (one per line)</label>
                    <textarea id="dmv-locations" rows="3" placeholder="Great Hall&#10;Slytherin Common Room"></textarea>
                </div>

                <!-- World-keeper chat -->
                <div class="dmv-section">
                    <label>Talk to the World-Keeper</label>
                    <div id="dmv-dmchat" class="dmv-dmchat"></div>
                    <div class="dmv-btn-row"><input type="text" id="dmv-dm-input" placeholder="Set up the world, hand it backstory…" style="flex:1;"><button class="dmv-btn dmv-btn-primary" id="dmv-dm-send">Send</button></div>
                </div>
            </div>

            <div class="dmv-section">
                <label>Universe Library</label>
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
    bind('dmv-change-llm', 'click', () => { document.getElementById('dmv-llm-form')?.classList.toggle('dmv-visible'); syncLLMForm(); });

    bind('dmv-run-dm', 'click', () => runDM());
    bind('dmv-regen-summary', 'click', () => regenerateSummary());
    bind('dmv-suggest-loc', 'click', () => suggestOptions('locations'));
    bind('dmv-suggest-ppl', 'click', () => suggestOptions('people'));

    bind('dmv-timeline', 'input', debounce(() => { const v = getActiveVerse(); if (v) { v.timeline = val('dmv-timeline'); saveSettings(); injectVerse(); } }, 600));
    bind('dmv-summary', 'input', debounce(() => { const v = getActiveVerse(); if (v) { v.summary = val('dmv-summary'); saveSettings(); injectVerse(); } }, 600));
    bind('dmv-locations', 'input', debounce(() => { const v = getActiveVerse(); if (!v) return; v.world.locations = val('dmv-locations').split('\n').map(s => s.trim()).filter(Boolean).map(name => ({ name, note: '' })); saveSettings(); }, 600));

    bind('dmv-tl-depth', 'change', () => { const v = getActiveVerse(); if (v) { v.timelineDepth = parseInt(val('dmv-tl-depth')) || 20; saveSettings(); injectVerse(); } });
    bind('dmv-tl-cadence', 'change', () => { const v = getActiveVerse(); if (v) { v.timelineCadence = parseInt(val('dmv-tl-cadence')) || 5; saveSettings(); } });
    bind('dmv-sum-past', 'change', () => { const v = getActiveVerse(); if (v) { v.summaryUpToPast = parseInt(val('dmv-sum-past')) || 3; saveSettings(); } });
    bind('dmv-sum-depth', 'change', () => { const v = getActiveVerse(); if (v) { v.summaryDepth = parseInt(val('dmv-sum-depth')) || 10; saveSettings(); injectVerse(); } });

    bind('dmv-dm-send', 'click', sendDM);
    bind('dmv-dm-input', 'keydown', e => { if (e.key === 'Enter') sendDM(); });

    bind('dmv-api-provider', 'change', e => {
        settings.apiProvider = e.target.value;
        const p = PROVIDER_PRESETS[e.target.value] || PROVIDER_PRESETS.custom;
        if (e.target.value !== 'custom') { setVal('dmv-api-endpoint', p.endpoint); settings.apiEndpoint = p.endpoint; }
        const h = document.getElementById('dmv-model-hint'); if (h) h.textContent = p.hint;
        saveSettings();
    });
    bind('dmv-api-save', 'click', () => { settings.apiKey = val('dmv-api-key'); settings.apiEndpoint = val('dmv-api-endpoint'); settings.apiModel = val('dmv-api-model'); saveSettings(); showApiStatus('Saved!', 'ok'); });
    bind('dmv-api-test', 'click', async () => { settings.apiKey = val('dmv-api-key'); settings.apiEndpoint = val('dmv-api-endpoint'); settings.apiModel = val('dmv-api-model'); saveSettings(); showApiStatus('Testing…', 'info'); const r = await testExternalAPI(); showApiStatus(r.ok ? 'OK!' : `Failed: ${r.error}`, r.ok ? 'ok' : 'error'); });
}

function syncLLMForm() {
    setVal('dmv-api-key', settings.apiKey);
    setVal('dmv-api-endpoint', settings.apiEndpoint);
    setVal('dmv-api-model', settings.apiModel);
    const sel = document.getElementById('dmv-api-provider'); if (sel) sel.value = settings.apiProvider;
    const h = document.getElementById('dmv-model-hint'); if (h) h.textContent = (PROVIDER_PRESETS[settings.apiProvider] || PROVIDER_PRESETS.custom).hint;
}

function showApiStatus(msg, type) {
    const el = document.getElementById('dmv-api-status'); if (!el) return;
    el.textContent = msg; el.style.color = type === 'ok' ? '#2ecc71' : type === 'error' ? '#e74c3c' : '#888';
    if (type !== 'error') setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 3000);
}

function sendDM() {
    const input = document.getElementById('dmv-dm-input');
    if (!input || !input.value.trim()) return;
    const m = input.value; input.value = ''; chatWithDM(m);
}

// =============================================================================
// Verse CRUD
// =============================================================================

function onVerseSelected(e) {
    const cd = getChatData();
    cd.activeVerseId = e.target.value || null;
    saveChatData(cd);
    injectVerse();
    applyWeatherFx();
    updateUI();
}

function onCreateVerse() {
    const input = document.getElementById('dmv-new-verse-name');
    const name = input?.value?.trim();
    if (!name) return;
    let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    while (settings.verseLibrary[id]) id += '_';
    settings.verseLibrary[id] = defaultVerse(id, name);
    saveSettings();
    const cd = getChatData(); cd.activeVerseId = id; saveChatData(cd);
    if (input) input.value = '';
    document.getElementById('dmv-new-verse-form')?.classList.remove('dmv-visible');
    updateUI();
}

function onDeleteVerse(id) {
    const v = settings.verseLibrary[id];
    if (!v || !confirm(`Delete universe "${v.name}"? Its timeline and canon are gone for good.`)) return;
    delete settings.verseLibrary[id];
    saveSettings();
    const cd = getChatData();
    if (cd.activeVerseId === id) { cd.activeVerseId = null; saveChatData(cd); clearInjection(); }
    updateUI();
}

// =============================================================================
// UI refresh
// =============================================================================

function updateUI() {
    const cd = getChatData();
    const activeId = cd.activeVerseId;

    const sel = document.getElementById('dmv-verse-select');
    if (sel) sel.innerHTML = '<option value="">— Pick a universe —</option>' +
        Object.values(settings.verseLibrary).map(v => `<option value="${v.id}" ${v.id === activeId ? 'selected' : ''}>${escapeHtml(v.name)}</option>`).join('');

    const v = getActiveVerse();
    setVisible('dmv-active', !!v);

    if (v) {
        setVal('dmv-timeline', v.timeline);
        setVal('dmv-summary', v.summary);
        setVal('dmv-locations', v.world.locations.map(l => l.name).join('\n'));
        setVal('dmv-tl-depth', v.timelineDepth);
        setVal('dmv-tl-cadence', v.timelineCadence);
        setVal('dmv-sum-past', v.summaryUpToPast);
        setVal('dmv-sum-depth', v.summaryDepth);
        updateSceneDisplay();
        updateProseDisplay();
        renderOptions();
        renderDMChat();
    }
    updateLibrary();
}

function updateSceneDisplay() {
    const v = getActiveVerse();
    const el = document.getElementById('dmv-scene-chips');
    if (!el || !v) return;
    const tod = getTimeOfDay(parseHourFromTime(v.scene.time));
    const chips = [];
    if (v.scene.weather) chips.push(`<span class="dmv-chip">${weatherIcon(v.scene.weather, tod)} ${escapeHtml(v.scene.weather)}</span>`);
    if (v.scene.time) chips.push(`<span class="dmv-chip">🕐 ${escapeHtml(v.scene.time)}</span>`);
    if (v.scene.mood) chips.push(`<span class="dmv-chip">🎭 ${escapeHtml(v.scene.mood)}</span>`);
    if (v.scene.location) chips.push(`<span class="dmv-chip">📍 ${escapeHtml(v.scene.location)}</span>`);
    for (const c of v.scene.characters) chips.push(`<span class="dmv-chip dmv-chip-person" title="${escapeHtml(c.note || '')}">👤 ${escapeHtml(c.name)}</span>`);
    el.innerHTML = chips.join('') || '<span class="dmv-empty">No scene yet — Advance World or talk to the World-Keeper.</span>';
}

function updateProseDisplay() {
    const v = getActiveVerse();
    const el = document.getElementById('dmv-prose');
    if (el) el.textContent = v?.prose || '—';
}

function renderOptions() {
    const el = document.getElementById('dmv-options');
    const v = getActiveVerse();
    if (!el || !v) return;
    const blocks = [];
    for (const kind of ['locations', 'people']) {
        const opts = v.options[kind] || [];
        if (!opts.length) continue;
        blocks.push(`<div class="dmv-opt-group"><div class="dmv-opt-head">${kind === 'locations' ? '📍 Locations' : '👤 People'}</div>` +
            opts.map((o, i) => `<div class="dmv-opt" data-kind="${kind}" data-i="${i}"><span><b>${escapeHtml(o.name)}</b> — ${escapeHtml(o.note || '')}</span><span class="dmv-opt-add">+ add</span></div>`).join('') + '</div>');
    }
    el.innerHTML = blocks.join('');
    el.querySelectorAll('.dmv-opt').forEach(node => node.addEventListener('click', () => acceptOption(node.dataset.kind, parseInt(node.dataset.i))));
}

function renderDMChat() {
    const el = document.getElementById('dmv-dmchat');
    const v = getActiveVerse();
    if (!el || !v) return;
    if (!v.dmChat.length) { el.innerHTML = '<div class="dmv-empty">Tell the world-keeper what world you want and hand it the backstory.</div>'; return; }
    el.innerHTML = v.dmChat.slice(-20).map(m => `<div class="dmv-msg dmv-msg-${m.role}"><b>${m.role === 'user' ? 'You' : 'DM'}:</b> ${escapeHtml(m.content)}</div>`).join('');
    el.scrollTop = el.scrollHeight;
}

function updateLibrary() {
    const el = document.getElementById('dmv-library');
    if (!el) return;
    const cd = getChatData();
    const entries = Object.values(settings.verseLibrary);
    if (!entries.length) { el.innerHTML = '<div class="dmv-empty">No universes yet. Click "+ New universe".</div>'; return; }
    el.innerHTML = entries.map(v => `
        <div class="dmv-lib-item ${v.id === cd.activeVerseId ? 'active' : ''}" data-id="${v.id}">
            <span class="dmv-lib-name">🌐 ${escapeHtml(v.name)}</span>
            <span class="dmv-lib-meta">${escapeHtml(v.scene.location || 'no scene')}</span>
            <span class="dmv-lib-del fa-solid fa-xmark" data-id="${v.id}" title="Delete"></span>
        </div>`).join('');
    el.querySelectorAll('.dmv-lib-item').forEach(item => item.addEventListener('click', e => {
        if (e.target.classList.contains('dmv-lib-del')) { onDeleteVerse(item.dataset.id); return; }
        const sel = document.getElementById('dmv-verse-select');
        if (sel) { sel.value = item.dataset.id; sel.dispatchEvent(new Event('change')); }
    }));
}

// =============================================================================
// Toggle + helpers
// =============================================================================

function togglePanel(force) {
    const p = document.getElementById('dmv-panel');
    if (!p) return;
    if (force === true) p.classList.add('dmv-open');
    else if (force === false) p.classList.remove('dmv-open');
    else p.classList.toggle('dmv-open');
    if (p.classList.contains('dmv-open')) syncLLMForm();
}

function updateFabVisibility() {
    const f = document.getElementById('dmv-fab');
    if (!f) return;
    if (settings.enabled && settings.showFab) f.classList.add('dmv-fab-visible');
    else f.classList.remove('dmv-fab-visible');
}

function setProcessing(show) { const el = document.getElementById('dmv-processing'); if (el) el.style.display = show ? 'inline' : 'none'; }
function bind(id, evt, fn) { document.getElementById(id)?.addEventListener(evt, fn); }
function val(id) { return document.getElementById(id)?.value || ''; }
function setVal(id, v) { const el = document.getElementById(id); if (el && el !== document.activeElement) el.value = v ?? ''; }
function setVisible(id, vis) { const el = document.getElementById(id); if (el) el.style.display = vis ? '' : 'none'; }
function escapeHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function debounce(fn, d) { let t; return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), d); }; }

// =============================================================================
// Auto-init
// =============================================================================

try {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(() => { try { init(); } catch (e) { console.error('[Multiverse] Init failed:', e); } }, 1500));
    } else {
        setTimeout(() => { try { init(); } catch (e) { console.error('[Multiverse] Init failed:', e); } }, 1500);
    }
} catch (e) { console.error('[Multiverse] Setup failed:', e); }

export default { init };
