-- SMS delivery tracking: a nullable failure reason + a per-thread index.
-- status stays free-text (queued | sent | delivered | failed | received).
ALTER TABLE hermes.sms_messages ADD COLUMN error text;
CREATE INDEX sms_messages_peer_ts ON hermes.sms_messages (peer_e164, ts);
