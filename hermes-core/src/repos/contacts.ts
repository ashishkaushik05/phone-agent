import type { Db } from "../db.ts";
import type { Persona } from "./personas.ts";
import type { PersonasRepo } from "./personas.ts";

export interface Contact {
  id: string;
  phoneE164: string;
  name: string | null;
  personaId: string | null;
  trustTier: "admin" | "known" | "stranger";
  crmRef: string | null;
  notes: string | null;
}

interface Row {
  id: string;
  phone_e164: string;
  name: string | null;
  persona_id: string | null;
  trust_tier: Contact["trustTier"];
  crm_ref: string | null;
  notes: string | null;
}

const toContact = (r: Row): Contact => ({
  id: r.id,
  phoneE164: r.phone_e164,
  name: r.name,
  personaId: r.persona_id,
  trustTier: r.trust_tier,
  crmRef: r.crm_ref,
  notes: r.notes,
});

export function normalizeE164(raw: string): string {
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  // Carrier/business alphanumeric sender ids (e.g. "JD-JioHtsr") have no digits
  // at all — leave them as-is rather than collapsing every one to a bare "+".
  if (!digits) return trimmed;
  if (hasPlus) return `+${digits}`;
  // Default deployment country is India — a bare 10-digit number is a local
  // mobile number, not a NANP one.
  if (digits.length === 10) return `+91${digits}`;
  return `+${digits}`;
}

export class ContactsRepo {
  constructor(private db: Db) {}

  async getByPhone(e164: string): Promise<Contact | null> {
    const r = await this.db.query<Row>(`SELECT * FROM hermes.contacts WHERE phone_e164 = $1`, [normalizeE164(e164)]);
    return r.rows[0] ? toContact(r.rows[0]) : null;
  }

  async get(id: string): Promise<Contact | null> {
    const r = await this.db.query<Row>(`SELECT * FROM hermes.contacts WHERE id = $1`, [id]);
    return r.rows[0] ? toContact(r.rows[0]) : null;
  }

  async list(): Promise<Contact[]> {
    const r = await this.db.query<Row>(`SELECT * FROM hermes.contacts ORDER BY name NULLS LAST, phone_e164`);
    return r.rows.map(toContact);
  }

  async upsert(c: Partial<Contact> & { phoneE164: string }): Promise<Contact> {
    const id = c.id ?? `ct-${normalizeE164(c.phoneE164).replace(/\D/g, "")}`;

    // Build UPDATE SET clause conditionally: only update trust_tier if explicitly provided
    let updateSetParts = [
      "name = COALESCE(EXCLUDED.name, hermes.contacts.name)",
      "persona_id = COALESCE(EXCLUDED.persona_id, hermes.contacts.persona_id)",
      "crm_ref = COALESCE(EXCLUDED.crm_ref, hermes.contacts.crm_ref)",
      "notes = COALESCE(EXCLUDED.notes, hermes.contacts.notes)",
      "updated_at = now()",
    ];

    if (c.trustTier !== undefined) {
      updateSetParts.splice(2, 0, "trust_tier = EXCLUDED.trust_tier");
    }

    const r = await this.db.query<Row>(
      `INSERT INTO hermes.contacts (id, phone_e164, name, persona_id, trust_tier, crm_ref, notes, updated_at)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'stranger'), $6, $7, now())
       ON CONFLICT (phone_e164) DO UPDATE SET
         ${updateSetParts.join(", ")}
       RETURNING *`,
      [id, normalizeE164(c.phoneE164), c.name ?? null, c.personaId ?? null, c.trustTier ?? null, c.crmRef ?? null, c.notes ?? null],
    );
    return toContact(r.rows[0]!);
  }

  async remove(id: string): Promise<void> {
    await this.db.query(`DELETE FROM hermes.contacts WHERE id = $1`, [id]);
  }
}

export async function resolvePersona(
  from: string,
  contacts: ContactsRepo,
  personas: PersonasRepo,
): Promise<{ persona: Persona; contact: Contact | null; trustTier: Contact["trustTier"] }> {
  const contact = await contacts.getByPhone(from);
  if (!contact) return { persona: await personas.getDefault(), contact: null, trustTier: "stranger" };
  const persona = (contact.personaId && (await personas.get(contact.personaId))) || (await personas.getDefault());
  return { persona, contact, trustTier: contact.trustTier };
}
