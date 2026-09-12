# Outbound calls from the dashboard + preset personas

Implementation notes for the change that added (a) a dashboard form to place an
outbound call on a chosen persona/script and (b) four preset personas.

## What shipped

1. **`POST /calls` accepts `persona_id`.** An outbound call can now run on any saved
   persona, not just the `default` one or an ad-hoc script.
2. **Persona + script combine.** Passing both uses the persona as the base and folds
   the script in as a per-call goal, re-wrapped so the `HARD RULES` block stays last.
3. **Dashboard "＋ New call" form** on the Calls tab: number + persona dropdown +
   optional script.
4. **Four preset personas** seeded by migration: `appointment-booker`,
   `info-gatherer` (outbound), `call-screener`, `after-hours` (inbound).

Inbound persona resolution (caller trust tier → persona) is unchanged.

## Persona resolution in `createOutbound`

`CallEngine.createOutbound(to, { script?, personaId? }, deviceId, send)`:

| input | persona used | `calls.persona_id` stored |
|---|---|---|
| `personaId` | `personas.get(personaId)` — throws if missing | the id |
| `personaId` + `script` | that persona, instruction = `withHardRules(stripHardRules(base) + "\n\nGoal for this specific call:\n" + script)` | the id |
| `script` only | `personaFromScript(script)` (ad-hoc, `id: adhoc-<ts>`, not in DB) | `null` |
| neither | `personas.getDefault()` | `default` |

The row's `persona_id` FK is `ON DELETE SET NULL`, so storing a real persona id is
safe; the ad-hoc case stores `null` because there is no matching row.

`stripHardRules` (new, in `persona-rules.ts`) is the inverse of `withHardRules` —
it slices off an appended `HARD_RULES` block so the combine step doesn't bury it
mid-prompt. Both key off the `HARD RULES (never break` marker rather than the exact
block text, so the rules can be reworded later without double-appending or stranding
a stale copy on a persona whose instruction was saved under an older version;
`withHardRules` now always strips-then-re-appends the current block.

### Shared call-agent rules (`HARD_RULES`)

Every persona instruction (inbound, outbound, ad-hoc, dashboard-created) gets the
shared `HARD_RULES` block appended at read time — identity lock, no caller
instructions, `<<DIRECTOR>>`-only steering, short spoken replies, and **"speak
slowly and calmly — noticeably slower than a normal pace"**. Change the pacing or
any rule by editing `HARD_RULES` in `persona-rules.ts` and restarting `hermes-core`;
no migration (the block is not stored, it's re-applied on every read), no APK
rebuild (Gemini Live has no speaking-rate config — pace is prompt-driven).

## HTTP

`POST /calls` body: `{ to, persona_id?, script?, device_id? }`.

- `to` missing → `400`
- `persona_id` given but not found → `404` (checked in `http.ts` before the engine call)
- device can't be resolved (`0` or `2+` connected, no `device_id`) → `409`
- ok → `202 { call_id, status: "queued" }`

## Dashboard (`src/dashboard/app.js`)

- State: `showNewCall`, `newCall { to, personaId, script }`, `newCallErr`.
- `toggleNewCall()` opens/closes the form; on open it preselects the default persona.
- `newCallFormHtml()` renders the `.add-form`; `wireNewCallForm()` binds inputs.
- `placeCall()` → `POST /calls` with `persona_id`/`script` omitted when blank; on
  `202` it selects the returned `call_id` and refreshes. `401` → token gate;
  `409`/`404`/other → inline error in the form.

No new dashboard build step; still vanilla JS served static.

## Preset personas (`migrations/004_seed_personas.sql`)

All `is_default = false`. Trigger keyword sets start from `DEFAULT_TRIGGER_CONFIG`
and are tuned per role (e.g. `after-hours` drops the scheduling `needsData` words;
`call-screener` widens `escalation`; the outbound two get task-completion `closing`
phrases). Editable and deletable from the Personas tab like any other persona.

## Files touched

| file | change |
|---|---|
| `src/persona-rules.ts` | `+ stripHardRules()`, marker-based wrap/strip, `+ "speak slowly"` pacing rule in `HARD_RULES` |
| `src/call-engine.ts` | `createOutbound` signature → options object; persona resolution |
| `src/http.ts` | `POST /calls` reads `persona_id`, pre-checks existence → `404` |
| `src/dashboard/app.js` | New-call form + `placeCall()` |
| `migrations/004_seed_personas.sql` | new — 4 presets |

## Tests

| file | cases added |
|---|---|
| `src/persona-rules.test.ts` | new — `stripHardRules` strip / no-op / round-trip / stale-block; `withHardRules` refreshes an outdated block; carries the "speak slowly" rule |
| `src/repos/personas.test.ts` | every seeded persona instruction is told to speak slowly |
| `src/migrate.test.ts` | 004 seeds exactly the 5 expected persona ids, 4 non-default |
| `src/call-engine.test.ts` | `createOutbound` with `personaId`; with `personaId` + `script` (both present, HARD RULES last); unknown `personaId` throws; existing test updated to the options-object signature |
| `src/http.test.ts` | `POST /calls` with `persona_id` uses that persona; unknown `persona_id` → `404` |

`npm test` (all files) and `npm run typecheck` are green.

## Not covered by automated tests

The dashboard form is verified by rendering `newCallFormHtml()` under a stub DOM and
by the server-side `POST /calls` tests it calls — the repo has no browser/DOM test
harness for `app.js`. Eyeball it at `http://localhost:8787/` → Calls → ＋ New call.
Placing a call there dials a **real** number on the connected phone.
