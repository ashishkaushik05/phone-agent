import { describe, it, expect } from "vitest";
import { freshDb } from "../test/db.ts";
import { PersonasRepo } from "./personas.ts";
import { ContactsRepo, normalizeE164, resolvePersona } from "./contacts.ts";

describe("normalizeE164", () => {
  it("keeps + and digits, assumes +91 for bare 10-digit numbers (default deployment country: India)", () => {
    expect(normalizeE164("98765 43210")).toBe("+919876543210");
    expect(normalizeE164("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("leaves an alphanumeric sender id (carrier short code) unchanged instead of collapsing to a bare +", () => {
    expect(normalizeE164("JD-JioHtsr")).toBe("JD-JioHtsr");
    expect(normalizeE164("VM-JIOCARE")).toBe("VM-JIOCARE");
  });
});

describe("ContactsRepo + resolvePersona", () => {
  it("unknown number resolves to the default persona as a stranger", async () => {
    const db = await freshDb();
    const r = await resolvePersona("+15550009999", new ContactsRepo(db), new PersonasRepo(db));
    expect(r.contact).toBeNull();
    expect(r.trustTier).toBe("stranger");
    expect(r.persona.isDefault).toBe(true);
  });

  it("known contact with a persona resolves to that persona and its trust tier", async () => {
    const db = await freshDb();
    const personas = new PersonasRepo(db);
    const contacts = new ContactsRepo(db);
    await personas.upsert({
      id: "vip", name: "VIP", systemInstruction: "Greet them by name, they are a top client.",
      triggerConfig: { needsData: [], escalation: [], offScript: [], closing: [] },
    });
    await contacts.upsert({ phoneE164: "+15551112222", name: "Dana", personaId: "vip", trustTier: "known" });

    const r = await resolvePersona("+1 (555) 111-2222", contacts, personas);
    expect(r.contact?.name).toBe("Dana");
    expect(r.trustTier).toBe("known");
    expect(r.persona.id).toBe("vip");
  });

  it("upsert preserves trustTier when updating other fields without specifying trustTier", async () => {
    const db = await freshDb();
    const contacts = new ContactsRepo(db);

    // Create a contact with admin trust tier
    await contacts.upsert({ phoneE164: "+15551112222", name: "Dana", trustTier: "admin" });

    // Update the contact with only name, no trustTier specified
    await contacts.upsert({ phoneE164: "+15551112222", name: "Dana Updated" });

    // Verify the contact was updated but trustTier remains admin
    const updated = await contacts.getByPhone("+15551112222");
    expect(updated?.name).toBe("Dana Updated");
    expect(updated?.trustTier).toBe("admin");
  });
});
