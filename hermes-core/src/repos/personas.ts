import type { Db } from "../db.ts";
import type { TriggerConfig } from "../protocol.ts";
import { DEFAULT_TRIGGER_CONFIG, withHardRules } from "../persona-rules.ts";

export interface Persona {
  id: string;
  name: string;
  systemInstruction: string;
  triggerConfig: TriggerConfig;
  isDefault: boolean;
}

interface Row {
  id: string;
  name: string;
  system_instruction: string;
  trigger_config: TriggerConfig;
  is_default: boolean;
}

const toPersona = (r: Row): Persona => ({
  id: r.id,
  name: r.name,
  systemInstruction: withHardRules(r.system_instruction),
  triggerConfig: r.trigger_config,
  isDefault: r.is_default,
});

export class PersonasRepo {
  constructor(private db: Db) {}

  async list(): Promise<Persona[]> {
    const r = await this.db.query<Row>(`SELECT * FROM hermes.personas ORDER BY is_default DESC, name`);
    return r.rows.map(toPersona);
  }

  async get(id: string): Promise<Persona | null> {
    const r = await this.db.query<Row>(`SELECT * FROM hermes.personas WHERE id = $1`, [id]);
    return r.rows[0] ? toPersona(r.rows[0]) : null;
  }

  async getDefault(): Promise<Persona> {
    const r = await this.db.query<Row>(`SELECT * FROM hermes.personas WHERE is_default = true LIMIT 1`);
    if (!r.rows[0]) throw new Error("no default persona seeded");
    return toPersona(r.rows[0]);
  }

  async upsert(p: Omit<Persona, "isDefault"> & { isDefault?: boolean }): Promise<Persona> {
    const instruction = withHardRules(p.systemInstruction);
    const r = await this.db.query<Row>(
      `INSERT INTO hermes.personas (id, name, system_instruction, trigger_config, is_default, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, now())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         system_instruction = EXCLUDED.system_instruction,
         trigger_config = EXCLUDED.trigger_config,
         is_default = EXCLUDED.is_default,
         updated_at = now()
       RETURNING *`,
      [p.id, p.name, instruction, JSON.stringify(p.triggerConfig), p.isDefault ?? false],
    );
    return toPersona(r.rows[0]!);
  }

  async remove(id: string): Promise<void> {
    await this.db.query(`DELETE FROM hermes.personas WHERE id = $1 AND is_default = false`, [id]);
  }
}

export function personaFromScript(script: string): Persona {
  return {
    id: `adhoc-${Date.now()}`,
    name: "Ad-hoc outbound script",
    systemInstruction: withHardRules(script),
    triggerConfig: DEFAULT_TRIGGER_CONFIG,
    isDefault: false,
  };
}
