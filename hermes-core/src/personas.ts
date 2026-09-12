// Phase 1: personas live in Postgres. This shim keeps the old import path working
// for any code not yet migrated to PersonasRepo. Prefer importing from ./repos/personas.ts.
export { PersonasRepo, personaFromScript, type Persona } from "./repos/personas.ts";
export { HARD_RULES, withHardRules, DEFAULT_TRIGGER_CONFIG } from "./persona-rules.ts";
