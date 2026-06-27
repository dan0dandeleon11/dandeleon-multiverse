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
 * Built on the caleb-media-companion engine. By dan.
 */

import { eventSource, event_types, extension_prompt_types, setExtensionPrompt } from '../../../../script.js';
import { getContext } from '../../../extensions.js';

const EXT_ID = 'dandeleon-multiverse';
const SCENE_PROMPT_ID = 'dandeleon_multiverse_scene';
const SUMMARY_PROMPT_ID = 'dandeleon_multiverse_summary';
const TIMELINE_PROMPT_ID = 'dandeleon_multiverse_timeline';
const PREMISE_PROMPT_ID = 'dandeleon_multiverse_premise';
const OFFSCREEN_PROMPT_ID = 'dandeleon_multiverse_offscreen';
const CAST_PROMPT_ID = 'dandeleon_multiverse_cast';
const STORAGE_KEY = 'dandeleon_multiverse_settings';
const SETTINGS_MODULE = 'dandeleon_multiverse';
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
    prompts: { dm: '', worldkeeper: '', summary: '' },
    verseLibrary: {}
};

function defaultVerse(id, name) {
    return {
        id,
        name,
        // Universe premise (standing setup, editable)
        premise: '',
        premiseDepth: 6,
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
        scene: { weather: '', time: '', mood: '', location: '', threads: [], currently: '' },
        sceneDepth: 3,
        cast: [],
        prose: '',
        // Autonomous background characters
        autonomousChars: false,
        charCadence: 3,
        turnsSinceChars: 0,
        // World
        world: { locations: [] },
        options: { locations: [], people: [] },
        dmChat: []
    };
}

let settings = { ...DEFAULT_SETTINGS };
let isRunning = false;
let fallbackChatData = null;
let lastApiError = '';
let uidCounter = 0;
let initialized = false;
function uid(p) { return p + Date.now().toString(36) + (uidCounter++); }
function numOr(id, def) { const n = parseInt(val(id), 10); return Number.isFinite(n) ? n : def; }
function notify(msg) {
    if (!msg) return;
    const m = String(msg).slice(0, 200);
    if (typeof toastr !== 'undefined' && toastr.error) toastr.error(m, 'Multiverse');
    showApiStatus(m, 'error');
}
function capChat(v) { if (v.dmChat.length > 60) v.dmChat = v.dmChat.slice(-60); }

// =============================================================================
// Init
// =============================================================================

export async function init() {
    if (initialized) return;
    initialized = true;
    console.log('[Multiverse] Initializing...');
    loadSettings();
    injectSettingsUI();
    injectPanelUI();
    injectWeatherLayer();
    updateUI();

    eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    injectVerse();
    applyWeatherFx();
    console.log('[Multiverse] Ready!');
}

// =============================================================================
// Persistence
// =============================================================================

function loadSettings() {
    let loaded = null;
    // Primary: SillyTavern's own settings store (persists to server settings.json)
    try {
        const ctx = getContext();
        const es = ctx && (ctx.extensionSettings || ctx.extension_settings);
        if (es && es[SETTINGS_MODULE]) loaded = es[SETTINGS_MODULE];
    } catch (e) { /* fall through */ }
    // Fallback / migration: browser localStorage
    if (!loaded) {
        try { const s = localStorage.getItem(STORAGE_KEY); if (s) loaded = JSON.parse(s); } catch (e) { /* */ }
    }
    if (loaded) {
        settings = { ...DEFAULT_SETTINGS, ...loaded };
        if (!settings.verseLibrary) settings.verseLibrary = {};
        if (!settings.prompts) settings.prompts = { dm: '', worldkeeper: '', summary: '' };
    }
}

function saveSettings() {
    // Primary: SillyTavern settings store (reliable across reloads, even on mobile webviews)
    try {
        const ctx = getContext();
        const es = ctx && (ctx.extensionSettings || ctx.extension_settings);
        if (es) {
            es[SETTINGS_MODULE] = settings;
            if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
        }
    } catch (e) { console.warn('[Multiverse] save (extension_settings) failed:', e); }
    // Backup mirror
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) { /* backup only */ }
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
    try {
        const ctx = getContext();
        if (ctx.chat_metadata) ctx.chat_metadata[CHAT_META_KEY] = data;
        // Flush chat_metadata so the active-verse binding survives a reload
        if (typeof ctx.saveMetadataDebounced === 'function') ctx.saveMetadataDebounced();
        else if (typeof ctx.saveMetadata === 'function') ctx.saveMetadata();
    } catch (e) { console.warn('[Multiverse] save chat failed:', e); }
}

function normalizeVerse(v) {
    if (!v) return v;
    if (!v.scene || typeof v.scene !== 'object') v.scene = { weather: '', time: '', mood: '', location: '', threads: [], currently: '' };
    if (!Array.isArray(v.scene.threads)) v.scene.threads = [];
    if (!v.world || typeof v.world !== 'object') v.world = { locations: [] };
    if (!Array.isArray(v.world.locations)) v.world.locations = [];
    if (!v.options || typeof v.options !== 'object') v.options = { locations: [], people: [] };
    if (!Array.isArray(v.dmChat)) v.dmChat = [];
    if (typeof v.premise !== 'string') v.premise = '';
    if (typeof v.timeline !== 'string') v.timeline = '';
    if (typeof v.summary !== 'string') v.summary = '';
    if (!Number.isFinite(v.sceneDepth)) v.sceneDepth = 3;
    if (!Number.isFinite(v.summaryDepth)) v.summaryDepth = 10;
    if (!Number.isFinite(v.timelineDepth)) v.timelineDepth = 20;
    if (!Number.isFinite(v.premiseDepth)) v.premiseDepth = 6;
    if (!Number.isFinite(v.timelineCadence)) v.timelineCadence = 5;
    if (!Number.isFinite(v.charCadence)) v.charCadence = 3;
    if (!Number.isFinite(v.summaryUpToPast)) v.summaryUpToPast = 3;
    if (!Array.isArray(v.cast)) {
        const old = (v.scene && Array.isArray(v.scene.characters)) ? v.scene.characters : [];
        v.cast = old.map((c) => ({ id: uid('c'), name: c.name, description: c.note || '', auto: c.auto || '', present: true }));
    }
    if (v.scene && 'characters' in v.scene) delete v.scene.characters;
    return v;
}

function getActiveVerse() {
    const cd = getChatData();
    const v = cd.activeVerseId ? (settings.verseLibrary[cd.activeVerseId] || null) : null;
    return v ? normalizeVerse(v) : null;
}

function findCast(v, id) { return (v.cast || []).find(c => c.id === id); }

// =============================================================================
// External API
// =============================================================================

async function callExternalAPI(messages, opts = {}) {
    lastApiError = '';
    if (!settings.apiKey) { lastApiError = 'No API key — open ⚙ Change LLM, paste your key, hit Save.'; console.warn('[Multiverse]', lastApiError); return null; }
    if (!settings.apiEndpoint) { lastApiError = 'No endpoint set.'; console.warn('[Multiverse]', lastApiError); return null; }
    const body = { model: settings.apiModel, messages, max_tokens: opts.maxTokens || 1200, temperature: opts.temperature ?? 0.7, stream: false };
    try {
        const r = await fetch(settings.apiEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}`, 'HTTP-Referer': 'https://github.com/SillyTavern/SillyTavern', 'X-Title': 'Dandeleon Multiverse' },
            body: JSON.stringify(body)
        });
        if (!r.ok) {
            const t = (await r.text().catch(() => '')).slice(0, 300);
            lastApiError = `HTTP ${r.status}${t ? ': ' + t : ''}`;
            console.warn('[Multiverse]', lastApiError);
            return null;
        }
        const d = await r.json();
        const text = d?.choices?.[0]?.message?.content || d?.choices?.[0]?.text || d?.output_text || '';
        if (!text) { lastApiError = 'Provider replied but with no text — check the model name.'; console.warn('[Multiverse]', lastApiError, d); }
        return text;
    } catch (e) {
        lastApiError = `Network/CORS error: ${e.message} — the provider may block direct browser calls.`;
        console.warn('[Multiverse]', lastApiError);
        return null;
    }
}

async function testExternalAPI() {
    try {
        const r = await callExternalAPI([{ role: 'user', content: 'Reply with exactly: ok' }], { maxTokens: 10, temperature: 0 });
        if (r && r.toLowerCase().includes('ok')) return { ok: true };
        return { ok: false, error: lastApiError || (r === '' ? 'Empty reply from provider' : `Unexpected reply: ${r}`) };
    } catch (e) { return { ok: false, error: e.message }; }
}

function extractJSON(text) {
    if (!text) return null;
    let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    try { return JSON.parse(t); } catch (e) { /* slice */ }
    const s = t.indexOf('{'), e = t.lastIndexOf('}');
    if (s !== -1 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch (x) { /* */ } }
    const as = t.indexOf('['), ae = t.lastIndexOf(']');
    if (as !== -1 && ae > as) { try { return JSON.parse(t.slice(as, ae + 1)); } catch (x) { /* */ } }
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

const WK_SYSTEM_DEFAULT = `You are the WORLD-KEEPER for this roleplay universe. Help the user build and manage it: canon, cast, locations/map, tone, secret future beats. Be concise, concrete, and collaborative. When the user hands you canon or asks you to plan, integrate it and reflect it back cleanly.`;

const SUMMARY_SYSTEM_DEFAULT = `You compress a roleplay history into concise background prose for the scene partner. Write in SECOND PERSON ("You..."). A tight paragraph or two. Only established/past facts. Output the prose only.`;

function getPrompt(key) {
    const o = settings.prompts && settings.prompts[key];
    if (o && o.trim()) return o.trim();
    return key === 'dm' ? DM_SYSTEM : key === 'worldkeeper' ? WK_SYSTEM_DEFAULT : SUMMARY_SYSTEM_DEFAULT;
}

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
    const cast = v.cast.filter(c => c.present).map(c => `${c.name}${c.description ? ` (${c.description})` : ''}`).join(', ') || '(none set)';
    return `VERSE: ${v.name}

UNIVERSE PREMISE:
${v.premise || '(none)'}

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

    const startId = v.id;
    const updateTimeline = (v.turnsSinceTimeline || 0) >= v.timelineCadence;

    isRunning = true;
    setProcessing(true);
    try {
        const raw = await callExternalAPI(
            [{ role: 'system', content: getPrompt('dm') }, { role: 'user', content: buildDMUserPrompt(v, recent, updateTimeline) }],
            { maxTokens: 1500, temperature: 0.8 }
        );
        if (!raw) { notify(lastApiError || 'DM call failed.'); return; }
        const res = extractJSON(raw);
        if (!res) { notify('DM reply was not valid JSON.'); return; }
        if (getActiveVerse()?.id !== startId) return;

        if (res.scene && typeof res.scene === 'object') {
            const s = res.scene;
            v.scene.weather = s.weather ?? v.scene.weather;
            v.scene.time = s.time ?? v.scene.time;
            v.scene.mood = s.mood ?? v.scene.mood;
            v.scene.location = s.location ?? v.scene.location;
            if (Array.isArray(s.characters) && s.characters.length) {
                const here = new Set(s.characters.filter(c => c && c.name).map(c => c.name.toLowerCase()));
                // toggle presence without deleting roster entries or touching descriptions
                for (const c of v.cast) c.present = here.has(c.name.toLowerCase());
                // fold in any newly-introduced characters
                for (const c of s.characters) {
                    if (!c || !c.name) continue;
                    if (!v.cast.find(x => x.name.toLowerCase() === c.name.toLowerCase())) {
                        v.cast.push({ id: uid('c'), name: c.name, description: c.note || '', auto: '', present: true });
                    }
                }
            }
            if (Array.isArray(s.threads)) v.scene.threads = s.threads.filter(Boolean);
        }
        if (typeof res.currently === 'string' && res.currently.trim()) v.scene.currently = res.currently.trim();

        if (updateTimeline && typeof res.timeline === 'string' && res.timeline.trim()) {
            if (timelineWriteOk(v.timeline, res.timeline)) v.timeline = res.timeline.trim();
            else console.warn('[Multiverse] DM dropped the {bookmark}; keeping previous timeline');
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
    if (!v || isRunning) return;
    const startId = v.id;
    const lines = (v.timeline || '').split('\n').map(s => s.trim()).filter(Boolean);
    const cutoff = Math.max(0, lines.length - (v.summaryUpToPast || 3));
    const toSummarize = lines.slice(0, cutoff).join('\n');
    isRunning = true;
    setProcessing(true);
    try {
        const raw = await callExternalAPI([
            { role: 'system', content: getPrompt('summary') },
            { role: 'user', content: `VERSE: ${v.name}\nPREMISE: ${v.premise || '(none)'}\n\nEVENTS TO SUMMARIZE (older beats; the most recent ${v.summaryUpToPast} are intentionally excluded):\n${toSummarize || '(nothing yet)'}\n\nWrite the condensed second-person background.` }
        ], { maxTokens: 700, temperature: 0.4 });
        if (raw && raw.trim()) {
            if (getActiveVerse()?.id !== startId) return;
            v.summary = raw.trim();
            saveSettings();
            injectVerse();
            setVal('dmv-summary', v.summary);
        } else { notify(lastApiError || 'Summary generation failed.'); }
    } finally { isRunning = false; setProcessing(false); }
}

// =============================================================================
// Suggest options (locations / people) for you AND Caleb
// =============================================================================

async function suggestOptions(kind) {
    const v = getActiveVerse();
    if (!v || isRunning) return;
    const startId = v.id;
    isRunning = true;
    setProcessing(true);
    try {
        const known = kind === 'locations'
            ? v.world.locations.map(l => l.name).join(', ')
            : v.cast.map(c => c.name).join(', ');
        const raw = await callExternalAPI([
            { role: 'system', content: `You propose fresh ${kind} for a roleplay world. Return ONLY a JSON array of exactly 3 objects: [{"name":"","note":"one short evocative line"}]. No prose.` },
            { role: 'user', content: `VERSE: ${v.name}\nLocation/scene: ${v.scene.location || '?'}\nAlready known: ${known || '(none)'}\n\nPropose 3 new ${kind} that fit this world.` }
        ], { maxTokens: 400, temperature: 0.9 });
        let arr = extractJSON(raw);
        if (!Array.isArray(arr)) { const m = (raw || '').match(/\[[\s\S]*\]/); if (m) { try { arr = JSON.parse(m[0]); } catch (e) { /* */ } } }
        if (Array.isArray(arr)) {
            if (getActiveVerse()?.id !== startId) return;
            v.options[kind] = arr.filter(o => o && o.name).slice(0, 3);
            saveSettings();
            renderOptions();
        } else { notify(lastApiError || 'Suggestion failed.'); }
    } finally { isRunning = false; setProcessing(false); }
}

function acceptOption(kind, index) {
    const v = getActiveVerse();
    if (!v) return;
    const opt = v.options[kind]?.[index];
    if (!opt) return;
    if (kind === 'locations') v.world.locations.push({ name: opt.name, note: opt.note || '' });
    else v.cast.push({ id: uid('c'), name: opt.name, description: opt.note || '', auto: '', present: false });
    v.options[kind].splice(index, 1);
    saveSettings();
    injectVerse();
    updateSceneDisplay();
    setVal('dmv-locations', v.world.locations.map(l => l.name).join('\n'));
    renderOptions();
    renderCast();
}

// =============================================================================
// Injection — three tiers at editable depths
// =============================================================================

function timelineUpToBookmark(text) {
    if (!text) return '';
    const lines = text.split('\n');
    let bookmark = -1;
    for (let i = 0; i < lines.length; i++) if (/\{[^{}]*\}/.test(lines[i])) { bookmark = i; break; }
    const slice = bookmark === -1 ? lines : lines.slice(0, bookmark + 1);
    return slice.map((l, i) => i === bookmark ? l.replace(/[{}]/g, '') : l).join('\n').trim();
}

// Reject a timeline write only if it would silently drop an existing {bookmark} (spoiler-gate guard)
function timelineWriteOk(oldText, newText) {
    const had = /\{[^{}]*\}/.test(oldText || '');
    const has = /\{[^{}]*\}/.test(newText || '');
    return !(had && !has);
}

function clearInjection() {
    setExtensionPrompt(SCENE_PROMPT_ID, '', extension_prompt_types.IN_CHAT, 3);
    setExtensionPrompt(SUMMARY_PROMPT_ID, '', extension_prompt_types.IN_CHAT, 10);
    setExtensionPrompt(TIMELINE_PROMPT_ID, '', extension_prompt_types.IN_CHAT, 20);
    setExtensionPrompt(PREMISE_PROMPT_ID, '', extension_prompt_types.IN_CHAT, 6);
    setExtensionPrompt(OFFSCREEN_PROMPT_ID, '', extension_prompt_types.IN_CHAT, 3);
    setExtensionPrompt(CAST_PROMPT_ID, '', extension_prompt_types.IN_CHAT, 3);
}

function injectVerse() {
    if (!settings.enabled) { clearInjection(); return; }
    const v = getActiveVerse();
    if (!v) { clearInjection(); return; }

    const scene = v.scene.currently?.trim() ? `<currently>\n${v.scene.currently.trim()}\n</currently>` : '';
    const summary = v.summary?.trim() ? `<canon_summary>\n${v.summary.trim()}\n</canon_summary>` : '';
    const tl = timelineUpToBookmark(v.timeline);
    const timeline = tl ? `<canon_timeline>\n${tl}\n</canon_timeline>` : '';
    const premise = v.premise?.trim() ? `<universe>\n${v.premise.trim()}\n</universe>` : '';
    const present = v.cast.filter(c => c.present);
    const described = present.filter(c => c.description && c.description.trim());
    const castBlock = described.length ? `<cast>\n${described.map(c => `${c.name}: ${c.description.trim()}`).join('\n')}\n</cast>` : '';
    const off = v.cast.filter(c => c.auto && c.auto.trim());
    const offscreen = off.length ? `<offscreen>\n${off.map(c => `${c.name}: ${c.auto.trim()}`).join('\n')}\n</offscreen>` : '';

    setExtensionPrompt(SCENE_PROMPT_ID, scene, extension_prompt_types.IN_CHAT, v.sceneDepth ?? 3);
    setExtensionPrompt(SUMMARY_PROMPT_ID, summary, extension_prompt_types.IN_CHAT, v.summaryDepth ?? 10);
    setExtensionPrompt(TIMELINE_PROMPT_ID, timeline, extension_prompt_types.IN_CHAT, v.timelineDepth ?? 20);
    setExtensionPrompt(PREMISE_PROMPT_ID, premise, extension_prompt_types.IN_CHAT, v.premiseDepth ?? 6);
    setExtensionPrompt(CAST_PROMPT_ID, castBlock, extension_prompt_types.IN_CHAT, v.sceneDepth ?? 3);
    setExtensionPrompt(OFFSCREEN_PROMPT_ID, offscreen, extension_prompt_types.IN_CHAT, v.sceneDepth ?? 3);
}

// =============================================================================
// World-keeper chat
// =============================================================================

const EDIT_PROTOCOL = `You can EDIT this universe directly. When the user asks you to change something (premise, timeline, summary, scene, characters, locations), reply normally, then append ONE fenced block at the very end:
<edit>
{ "premise": "full new premise (optional)",
  "timeline": "full new timeline text, keep the {bookmark} line (optional)",
  "summary": "full new summary (optional)",
  "scene": { "weather":"", "time":"", "mood":"", "location":"" } (optional — only fields you change),
  "addCast": [{"name":"","description":""}] (optional),
  "updateCast": [{"name":"","description":""}] (optional, matched by name),
  "removeCast": ["name"] (optional),
  "addLocations": ["name"] (optional) }
</edit>
Include the <edit> block ONLY when the user actually wants a change, and only the keys you're changing. For questions or brainstorming, omit it entirely.`;

function extractEditBlock(text) {
    const m = text.match(/<edit>([\s\S]*?)<\/edit>/i);
    if (!m) return null;
    const patch = extractJSON(m[1]);
    if (!patch) return null;
    return { patch, cleanText: text.replace(m[0], '').trim() };
}

function applyWorldkeeperEdit(v, patch) {
    const changed = [];
    if (typeof patch.premise === 'string') { v.premise = patch.premise.trim(); changed.push('premise'); }
    if (typeof patch.timeline === 'string') {
        if (timelineWriteOk(v.timeline, patch.timeline)) { v.timeline = patch.timeline.trim(); changed.push('timeline'); }
        else changed.push('timeline (skipped — would drop the {bookmark})');
    }
    if (typeof patch.summary === 'string') { v.summary = patch.summary.trim(); changed.push('summary'); }
    if (patch.scene && typeof patch.scene === 'object') {
        for (const k of ['weather', 'time', 'mood', 'location']) if (typeof patch.scene[k] === 'string') v.scene[k] = patch.scene[k];
        if (Array.isArray(patch.scene.threads)) v.scene.threads = patch.scene.threads.filter(Boolean);
        changed.push('scene');
    }
    if (Array.isArray(patch.addCast)) {
        let n = 0;
        for (const c of patch.addCast) {
            if (c && c.name && !v.cast.find(x => x.name.toLowerCase() === c.name.toLowerCase())) {
                v.cast.push({ id: uid('c'), name: c.name, description: c.description || '', auto: '', present: false });
                n++;
            }
        }
        if (n) changed.push(`+${n} character${n > 1 ? 's' : ''}`);
    }
    if (Array.isArray(patch.updateCast)) {
        let n = 0;
        for (const c of patch.updateCast) {
            if (!c || !c.name) continue;
            const e = v.cast.find(x => x.name.toLowerCase() === c.name.toLowerCase());
            if (e && typeof c.description === 'string') { e.description = c.description; n++; }
        }
        if (n) changed.push('character edits');
    }
    if (Array.isArray(patch.removeCast)) {
        const rm = new Set(patch.removeCast.map(s => String(s).toLowerCase()));
        const before = v.cast.length;
        v.cast = v.cast.filter(c => !rm.has(c.name.toLowerCase()));
        if (v.cast.length < before) changed.push('character removed');
    }
    if (Array.isArray(patch.addLocations)) {
        let n = 0;
        for (const nm of patch.addLocations) {
            if (nm && !v.world.locations.find(l => l.name.toLowerCase() === String(nm).toLowerCase())) { v.world.locations.push({ name: String(nm), note: '' }); n++; }
        }
        if (n) changed.push('locations');
    }
    return changed;
}

async function chatWithDM(message) {
    const v = getActiveVerse();
    if (!v || !message.trim()) return;
    if (isRunning) { notify('Busy — give it a sec, then try again.'); return; }
    const startId = v.id;
    v.dmChat.push({ role: 'user', content: message.trim() });
    capChat(v);
    saveSettings();
    renderDMChat();
    const recent = getRecentMessages(settings.messageDepth);
    const sys = `${getPrompt('worldkeeper')}

UNIVERSE: "${v.name}"
PREMISE: ${v.premise || '(none)'}
CANON TIMELINE:\n${v.timeline || '(empty)'}\n\nSCENE: ${v.scene.location || '?'} — ${v.scene.weather || '?'}; present: ${v.cast.filter(c => c.present).map(c => c.name).join(', ') || 'no one'}.

CURRENT ROLEPLAY (live conversation between the user and their scene partner — this is what's happening right now):
${recent.join('\n') || '(nothing yet)'}`;
    const history = v.dmChat.slice(-12).map(m => ({ role: m.role, content: m.content }));
    isRunning = true;
    setProcessing(true);
    try {
        const reply = await callExternalAPI([{ role: 'system', content: sys + '\n\n' + EDIT_PROTOCOL }, ...history], { maxTokens: 1200, temperature: 0.7 });
        if (!reply || !reply.trim()) { notify(lastApiError || 'World-keeper call failed.'); return; }
        if (getActiveVerse()?.id !== startId) return;
        let display = reply.trim();
        let changed = [];
        const eb = extractEditBlock(display);
        if (eb) {
            display = eb.cleanText || '(updated the world)';
            changed = applyWorldkeeperEdit(v, eb.patch);
            if (changed.length) display += `\n\n✏️ applied: ${changed.join(', ')}`;
        }
        v.dmChat.push({ role: 'assistant', content: display });
        capChat(v);
        saveSettings();
        if (changed.length) { injectVerse(); applyWeatherFx(); updateUI(); }
        else { renderDMChat(); }
    } finally { isRunning = false; setProcessing(false); }
}

// =============================================================================
// Autonomous background characters (separate API call)
// =============================================================================

async function simulateBackground() {
    const v = getActiveVerse();
    if (!v || !v.autonomousChars || isRunning) return;
    const startId = v.id;
    const recent = getRecentMessages(settings.messageDepth).join(' ').toLowerCase();
    // Only re-roll characters NOT mentioned in the RP — mentioned ones are the GM's job.
    const targets = v.cast.filter(c => c.name && !recent.includes(c.name.toLowerCase()));
    if (!targets.length) { v.turnsSinceChars = 0; return; }
    isRunning = true;
    setProcessing(true);
    try {
        const raw = await callExternalAPI([
            { role: 'system', content: `You simulate what BACKGROUND characters are autonomously doing right now, off-screen, consistent with the world and premise. Return ONLY a JSON array: [{"name":"","auto":"one short line of what they're doing/saying"}]. No prose.` },
            { role: 'user', content: `VERSE: ${v.name}\nPREMISE: ${v.premise || '(none)'}\nSCENE: ${v.scene.location || '?'}, ${v.scene.weather || '?'}\nBACKGROUND CHARACTERS: ${targets.map(c => c.name).join(', ')}\n\nWhat is each of them doing right now?` }
        ], { maxTokens: 400, temperature: 0.8 });
        let arr = extractJSON(raw);
        if (!Array.isArray(arr)) { const m = (raw || '').match(/\[[\s\S]*\]/); if (m) { try { arr = JSON.parse(m[0]); } catch (e) { /* */ } } }
        if (Array.isArray(arr)) {
            for (const o of arr) {
                if (!o || !o.name) continue;
                const c = v.cast.find(x => x.name.toLowerCase() === String(o.name).toLowerCase());
                if (c) c.auto = o.auto || c.auto;
            }
            if (getActiveVerse()?.id !== startId) return;
            v.turnsSinceChars = 0;
            saveSettings(); injectVerse(); updateSceneDisplay();
        }
    } finally { isRunning = false; setProcessing(false); }
}

// =============================================================================
// Events
// =============================================================================

async function onMessageSent() {
    if (!settings.enabled) return;
    const v = getActiveVerse();
    if (!v) return;
    if (settings.autoRun && !isRunning) await runDM();
    else injectVerse();
    if (v.autonomousChars) {
        v.turnsSinceChars = (v.turnsSinceChars || 0) + 1;
        if (v.turnsSinceChars >= (v.charCadence || 3)) await simulateBackground();
    }
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
                <!-- Universe premise -->
                <div class="dmv-section dmv-box">
                    <div class="dmv-box-title">UNIVERSE PREMISE</div>
                    <div class="dmv-inline-ctrls"><span>depth <input type="number" id="dmv-premise-depth" class="dmv-num" min="0" max="100"></span></div>
                    <div class="dmv-note">Establish the verse — setting, who the player and Caleb are, the secrets they keep. Standing context injected to Caleb.</div>
                    <textarea id="dmv-premise" rows="3" placeholder="50's London, the Blitz. Both the player and Caleb are starving orphans.&#10;— or —&#10;YYH reincarnation AU: player reborn as Keiko, Caleb is Kurama; neither reveals they're reincarnated."></textarea>
                </div>

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

                <!-- Cast roster -->
                <div class="dmv-section">
                    <label>Cast</label>
                    <div id="dmv-cast"></div>
                    <button class="dmv-btn dmv-btn-ok" id="dmv-add-char">+ Add character</button>
                </div>

                <!-- Autonomous background characters -->
                <div class="dmv-section">
                    <label class="dmv-check"><input type="checkbox" id="dmv-autonomous"> Autonomous background characters</label>
                    <div class="dmv-inline-ctrls"><span>simulate every <input type="number" id="dmv-char-cadence" class="dmv-num" min="1" max="50"> turns</span><button class="dmv-btn dmv-btn-icon" id="dmv-sim-bg" title="Simulate now">🎲</button></div>
                    <div class="dmv-note">Off-screen characters keep a static action until they're mentioned in the RP — then the GM voices them live.</div>
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

                <!-- Edit prompts (advanced) -->
                <div class="dmv-section">
                    <label class="dmv-collapse" id="dmv-prompts-toggle">⚙ Edit prompts (advanced)</label>
                    <div id="dmv-prompts" class="dmv-prompts">
                        <div class="dmv-sub2">DM / world engine</div>
                        <textarea id="dmv-prompt-dm" rows="4" placeholder="(blank = built-in default)"></textarea>
                        <div class="dmv-sub2">World-keeper chat</div>
                        <textarea id="dmv-prompt-wk" rows="3" placeholder="(blank = built-in default)"></textarea>
                        <div class="dmv-sub2">Summary instruction</div>
                        <textarea id="dmv-prompt-sum" rows="2" placeholder="(blank = built-in default)"></textarea>
                    </div>
                </div>

                <!-- World-keeper chat -->
                <div class="dmv-section">
                    <div class="dmv-row-between"><label>Talk to the World-Keeper</label><span class="dmv-clear" id="dmv-dm-clear" title="Clear chat">🗑 clear</span></div>
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
    bind('dmv-sim-bg', 'click', () => simulateBackground());
    bind('dmv-add-char', 'click', addCharacter);

    bind('dmv-premise', 'input', debounce(() => { const v = getActiveVerse(); if (v) { v.premise = val('dmv-premise'); saveSettings(); injectVerse(); } }, 600));
    bind('dmv-premise-depth', 'change', () => { const v = getActiveVerse(); if (v) { v.premiseDepth = numOr('dmv-premise-depth', 6); saveSettings(); injectVerse(); } });
    bind('dmv-autonomous', 'change', e => { const v = getActiveVerse(); if (v) { v.autonomousChars = e.target.checked; saveSettings(); } });
    bind('dmv-char-cadence', 'change', () => { const v = getActiveVerse(); if (v) { v.charCadence = numOr('dmv-char-cadence', 3); saveSettings(); } });

    bind('dmv-prompts-toggle', 'click', () => document.getElementById('dmv-prompts')?.classList.toggle('dmv-visible'));
    bind('dmv-prompt-dm', 'input', debounce(() => { settings.prompts.dm = val('dmv-prompt-dm'); saveSettings(); }, 600));
    bind('dmv-prompt-wk', 'input', debounce(() => { settings.prompts.worldkeeper = val('dmv-prompt-wk'); saveSettings(); }, 600));
    bind('dmv-prompt-sum', 'input', debounce(() => { settings.prompts.summary = val('dmv-prompt-sum'); saveSettings(); }, 600));

    bind('dmv-timeline', 'input', debounce(() => { const v = getActiveVerse(); if (v) { v.timeline = val('dmv-timeline'); saveSettings(); injectVerse(); } }, 600));
    bind('dmv-summary', 'input', debounce(() => { const v = getActiveVerse(); if (v) { v.summary = val('dmv-summary'); saveSettings(); injectVerse(); } }, 600));
    bind('dmv-locations', 'input', debounce(() => { const v = getActiveVerse(); if (!v) return; v.world.locations = val('dmv-locations').split('\n').map(s => s.trim()).filter(Boolean).map(name => ({ name, note: '' })); saveSettings(); }, 600));

    bind('dmv-tl-depth', 'change', () => { const v = getActiveVerse(); if (v) { v.timelineDepth = numOr('dmv-tl-depth', 20); saveSettings(); injectVerse(); } });
    bind('dmv-tl-cadence', 'change', () => { const v = getActiveVerse(); if (v) { v.timelineCadence = numOr('dmv-tl-cadence', 5); saveSettings(); } });
    bind('dmv-sum-past', 'change', () => { const v = getActiveVerse(); if (v) { v.summaryUpToPast = numOr('dmv-sum-past', 3); saveSettings(); } });
    bind('dmv-sum-depth', 'change', () => { const v = getActiveVerse(); if (v) { v.summaryDepth = numOr('dmv-sum-depth', 10); saveSettings(); injectVerse(); } });

    bind('dmv-dm-send', 'click', sendDM);
    bind('dmv-dm-clear', 'click', clearDMChat);
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

function clearDMChat() {
    const v = getActiveVerse();
    if (!v) return;
    if (v.dmChat.length && !confirm('Clear the world-keeper chat? (Your canon, timeline, and cast are untouched.)')) return;
    v.dmChat = [];
    saveSettings();
    renderDMChat();
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
        setVal('dmv-premise', v.premise);
        setVal('dmv-premise-depth', v.premiseDepth);
        setVal('dmv-char-cadence', v.charCadence);
        const autoCb = document.getElementById('dmv-autonomous'); if (autoCb) autoCb.checked = !!v.autonomousChars;
        setVal('dmv-prompt-dm', settings.prompts?.dm || '');
        setVal('dmv-prompt-wk', settings.prompts?.worldkeeper || '');
        setVal('dmv-prompt-sum', settings.prompts?.summary || '');
        updateSceneDisplay();
        updateProseDisplay();
        renderOptions();
        renderCast();
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
    for (const c of v.cast.filter(x => x.present)) chips.push(`<span class="dmv-chip dmv-chip-person" title="${escapeHtml(c.description || '')}">👤 ${escapeHtml(c.name)}</span>`);
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

function addCharacter() {
    const v = getActiveVerse();
    if (!v) return;
    v.cast.push({ id: uid('c'), name: 'New character', description: '', auto: '', present: true });
    saveSettings();
    renderCast();
    injectVerse();
    updateSceneDisplay();
}

function renderCast() {
    const el = document.getElementById('dmv-cast');
    const v = getActiveVerse();
    if (!el || !v) return;
    if (!v.cast.length) { el.innerHTML = '<div class="dmv-empty">No characters yet. Add one, or let the DM / Suggest introduce them.</div>'; return; }
    el.innerHTML = v.cast.map(c => `
        <div class="dmv-castcard ${c.present ? 'present' : ''}" data-id="${c.id}">
            <div class="dmv-castrow">
                <input type="text" class="dmv-cast-name" data-id="${c.id}" value="${escapeHtml(c.name)}" placeholder="Name">
                <label class="dmv-cast-present" title="In the current scene"><input type="checkbox" class="dmv-cast-here" data-id="${c.id}" ${c.present ? 'checked' : ''}> here</label>
                <span class="dmv-cast-del fa-solid fa-xmark" data-id="${c.id}" title="Remove"></span>
            </div>
            <textarea class="dmv-cast-desc" data-id="${c.id}" rows="2" placeholder="Description…">${escapeHtml(c.description || '')}</textarea>
            ${c.auto ? `<div class="dmv-cast-auto">↳ ${escapeHtml(c.auto)}</div>` : ''}
        </div>`).join('');
    el.querySelectorAll('.dmv-cast-name').forEach(n => n.addEventListener('input', debounce(e => { const c = findCast(v, e.target.dataset.id); if (c) { c.name = e.target.value; saveSettings(); } }, 600)));
    el.querySelectorAll('.dmv-cast-desc').forEach(n => n.addEventListener('input', debounce(e => { const c = findCast(v, e.target.dataset.id); if (c) { c.description = e.target.value; saveSettings(); injectVerse(); } }, 600)));
    el.querySelectorAll('.dmv-cast-here').forEach(n => n.addEventListener('change', e => { const c = findCast(v, e.target.dataset.id); if (c) { c.present = e.target.checked; saveSettings(); injectVerse(); updateSceneDisplay(); } }));
    el.querySelectorAll('.dmv-cast-del').forEach(n => n.addEventListener('click', e => { v.cast = v.cast.filter(x => x.id !== e.target.dataset.id); saveSettings(); injectVerse(); updateSceneDisplay(); renderCast(); }));
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
