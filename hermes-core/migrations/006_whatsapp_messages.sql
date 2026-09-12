-- WhatsApp channel (Phase 3, part 1).
-- Mirrors sms_messages field-for-field minus device_id: WhatsApp runs one
-- global Baileys connection inside hermes-core, not a per-device SIM.
-- status: queued | sent | delivered | read | failed.
CREATE TABLE hermes.whatsapp_messages (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  direction   text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  peer_e164   text NOT NULL,
  body        text NOT NULL,
  status      text NOT NULL DEFAULT 'queued',
  error       text,
  call_id     text REFERENCES hermes.calls(id) ON DELETE SET NULL,
  ts          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX whatsapp_messages_peer_ts ON hermes.whatsapp_messages (peer_e164, ts);
