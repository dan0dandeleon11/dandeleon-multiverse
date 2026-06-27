# 🌌 Dandeleon Multiverse

A **multiverse RP world-keeper** for [SillyTavern](https://github.com/SillyTavern/SillyTavern).

An external "DM" LLM manages each of your roleplay universes — holding the **full canon outside your character's context window** and injecting only condensed, spoiler-safe slices. The point: roleplays that used to die when the context window filled up can now run indefinitely, because the story lives in the verse, not in the model's head.

---

## Why

If you've ever had a long RP get worse — or just stop — because the model forgot the beginning, this is the fix. Instead of cramming everything into the prompt, a cheap external LLM keeps the whole history and feeds your character only:

- a compact **live scene** (who's here, weather, gossip),
- a condensed **summary** of the background,
- and the **canon timeline** up to the present moment — never past it.

Switch between as many universes as you want. Each is self-contained.

---

## Install

In SillyTavern: **Extensions → Install extension**, paste:

```
https://github.com/dan0dandeleon11/dandeleon-multiverse.git
```

It installs as `third-party/dandeleon-multiverse`. Works on desktop and mobile (Termux).

> Needs an external OpenAI-compatible LLM for the DM (OpenRouter, GLM/Zhipu, or any compatible endpoint). This keeps the world-keeping off your main roleplay model's tokens.

---

## First run

1. **Extensions tab → Dandeleon Multiverse** → enable.
2. Open the panel (🌌 floating button) → **⚙ Change LLM** → pick a provider, paste your API key, hit **Test**.
3. **+ New universe** → name it (e.g. *Hogwarts AU*).
4. **Universe Premise** → establish the verse: setting, who the player and your character are, any secrets they keep.
5. Paste your backstory into **Canon Timeline**; wrap the line you're *currently* at in `{ }`. Hit 🔄 on the summary.
6. (Optional) add **Cast** members, flip on **Autonomous characters**, talk to the **World-Keeper**.
7. **▶ Advance World** — or just roleplay; with auto-run on, the DM advances the world every turn.

---

## How it works — the injection tiers

Everything is injected at an **editable depth** (how many messages back from the latest), so you control salience:

| Block | Default depth | What it is |
|---|---|---|
| `<currently>` | 3 (shallow) | The live scene — weather, who's present, gossip, NPC banter |
| `<cast>` / `<offscreen>` | 3 | Present characters' descriptions; autonomous off-screen actions |
| `<universe>` | 6 | The standing premise — setting, roles, secrets |
| `<canon_summary>` | 10 (mid) | Prose condensation of the older background |
| `<canon_timeline>` | 20 (deep) | The beat list, **up to the `{bookmark}` only** |

The **`{bookmark}`** in the Canon Timeline marks "now." Everything after it is your planned future — it stays **dark** (never injected) until the story reaches it. The DM advances the bookmark as you play.

---

## Panel sections

- **Universe picker** — switch verses, create new, change the external LLM.
- **Scene** — live weather/time/mood/location/cast chips + the narration prose (your side). **▶ Advance World** runs the DM.
- **Suggest locations / people** — get 3 pickable options for new world elements.
- **Cast** — a persistent roster. Add characters, write descriptions (the DM never overwrites them), toggle who's "here," delete.
- **Autonomous characters** — a separate call simulates off-screen cast on a cadence; each stays static until mentioned in the RP, then the DM voices them live.
- **Canon Timeline** — the ordered beat list with the `{bookmark}`; editable depth + auto-update cadence.
- **Summarized Canon** — condensed background, editable, 🔄 regenerates it.
- **Talk to the World-Keeper** — chat with the DM (it sees your live RP). It can **edit the verse directly** — "add a rival named Abraxas," "make the premise childhood friends," "it's snowing now" — and applies the change, showing ✏️ what it touched.
- **Edit prompts (advanced)** — override the DM / world-keeper / summary system prompts (blank = built-in default).

---

## Notes

- **Spoiler-safe by design.** Only timeline beats up to the `{bookmark}` reach your character. After a big world-keeper edit, glance at the timeline to confirm the bookmark's where you want it.
- **Multiverse.** Verses are stored in browser localStorage; the active verse is remembered per chat.
- **External LLM only does world-keeping** — it never writes your character's dialogue. Your main model stays in charge of the actual roleplay.
- Weather effects (rain/snow/storm/fog + time-of-day tint) can be toggled in settings.

---

## Credits

Built by **Lei** ([@dan0dandeleon11](https://github.com/dan0dandeleon11)), on the engine of the `caleb-media-companion` extension. Scene-discipline and weather ideas adapted from the RPG Companion lineage.
