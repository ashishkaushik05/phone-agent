import { describe, it, expect } from "vitest";
import { freshDb } from "../test/db.ts";
import { PersonasRepo, personaFromScript } from "./personas.ts";
import { HARD_RULES } from "../persona-rules.ts";

describe("PersonasRepo", () => {
  it("seeds and returns a default persona carrying the hard rules", async () => {
    const repo = new PersonasRepo(await freshDb());
    const def = await repo.getDefault();
    expect(def.isDefault).toBe(true);
    expect(def.systemInstruction).toContain(HARD_RULES);
    expect(def.triggerConfig.offScript.length).toBeGreaterThan(0);
  });

  it("every seeded persona is told to speak slowly", async () => {
    const repo = new PersonasRepo(await freshDb());
    const all = await repo.list();
    expect(all.length).toBeGreaterThan(1);
    for (const p of all) expect(p.systemInstruction).toMatch(/slowly/i);
  });

  it("upsert stores and re-reads a persona, appending hard rules once", async () => {
    const repo = new PersonasRepo(await freshDb());
    const saved = await repo.upsert({
      id: "plumber",
      name: "Plumber reception",
      systemInstruction: "You are a plumbing receptionist.",
      triggerConfig: { needsData: ["quote"], escalation: [], offScript: [], closing: [] },
    });
    expect(saved.systemInstruction).toContain("plumbing receptionist");
    expect(saved.systemInstruction).toContain(HARD_RULES);

    const again = await repo.get("plumber");
    expect(again?.systemInstruction).toBe(saved.systemInstruction);
    // idempotent — re-upsert must not double the hard rules
    const twice = await repo.upsert({ ...saved });
    const hardRulesCount = (twice.systemInstruction.match(/HARD RULES/g) || []).length;
    expect(hardRulesCount).toBe(1);
  });

  it("personaFromScript wraps a raw script in hard rules without persisting", async () => {
    const p = personaFromScript("You are calling to confirm an appointment.");
    expect(p.systemInstruction).toContain("confirm an appointment");
    expect(p.systemInstruction).toContain(HARD_RULES);
    expect(p.isDefault).toBe(false);
  });
});
