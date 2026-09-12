CREATE TABLE hermes.personas (
  id                 text PRIMARY KEY,
  name               text NOT NULL,
  system_instruction text NOT NULL,
  trigger_config     jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_default         boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hermes.contacts (
  id           text PRIMARY KEY,
  phone_e164   text NOT NULL UNIQUE,
  name         text,
  persona_id   text REFERENCES hermes.personas(id) ON DELETE SET NULL,
  trust_tier   text NOT NULL DEFAULT 'stranger' CHECK (trust_tier IN ('admin', 'known', 'stranger')),
  crm_ref      text,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hermes.calls (
  id              text PRIMARY KEY,
  direction       text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_number     text,
  to_number       text,
  persona_id      text REFERENCES hermes.personas(id) ON DELETE SET NULL,
  contact_id      text REFERENCES hermes.contacts(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'dialing', 'active', 'ended')),
  started_at      timestamptz NOT NULL DEFAULT now(),
  connected_at    timestamptz,
  ended_at        timestamptz,
  end_reason      text,
  outcome_summary text,
  recording_url   text
);

CREATE TABLE hermes.transcript_events (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  call_id  text NOT NULL REFERENCES hermes.calls(id) ON DELETE CASCADE,
  seq      integer NOT NULL,
  role     text NOT NULL CHECK (role IN ('caller', 'agent', 'director', 'system')),
  text     text NOT NULL,
  ts       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, seq)
);

CREATE TABLE hermes.director_actions (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  call_id  text NOT NULL REFERENCES hermes.calls(id) ON DELETE CASCADE,
  ts       timestamptz NOT NULL DEFAULT now(),
  category text NOT NULL,
  matched  text,
  kind     text NOT NULL CHECK (kind IN ('inject', 'hangup', 'flag', 'note', 'tool')),
  payload  jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE hermes.sms_messages (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  direction   text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  peer_e164   text NOT NULL,
  body        text NOT NULL,
  status      text NOT NULL DEFAULT 'sent',
  call_id     text REFERENCES hermes.calls(id) ON DELETE SET NULL,
  ts          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hermes.outreach_tasks (
  id                text PRIMARY KEY,
  status            text NOT NULL DEFAULT 'pending',
  kind              text NOT NULL,
  target_contact_id text REFERENCES hermes.contacts(id) ON DELETE SET NULL,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  result            jsonb,
  scheduled_for     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hermes.notifications (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  call_id   text REFERENCES hermes.calls(id) ON DELETE SET NULL,
  channel   text NOT NULL DEFAULT 'log',
  text      text NOT NULL,
  sent_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON hermes.calls (status);
CREATE INDEX ON hermes.calls (started_at DESC);
CREATE INDEX ON hermes.transcript_events (call_id, seq);
