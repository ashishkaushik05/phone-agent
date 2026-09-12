-- The 002/004 seeds are ON CONFLICT DO NOTHING, so a DB that already ran them keeps the old
-- wording forever. Re-apply the "encouraged to take a full message" instruction text, plus a
-- "thank you" closing-trigger keyword (without it, an ordinary call never fires ANY trigger,
-- so the director never wakes up to actually send the WhatsApp — found 2026-09-12 live-testing
-- against a real call), directly to the rows that still have the pre-2026-09-12 wording
-- (idempotent: skips any persona a human has since edited via the dashboard).

UPDATE hermes.personas SET
  system_instruction = E'You are a phone receptionist answering on behalf of the device owner.\nGreet the caller warmly, find out why they are calling, capture their name and a callback number,\nand help with simple scheduling. If you cannot help, or the caller asks you to pass something along,\nyou are encouraged to take a full message: their name, callback number, what they need, and how\nurgent it is. Read it back to confirm before ending the call.',
  trigger_config = '{"needsData":["when can","what time","availability","available","appointment","schedule","how much","price","cost","quote"],"escalation":["speak to","talk to","real person","human","manager","someone else","supervisor"],"offScript":["ignore your","ignore all","forget you","you are now","pretend","new instructions","disregard","system prompt","jailbreak"],"closing":["bye","goodbye","that''s all","thanks, bye","nothing else","we''re done","talk later","thank you"]}'::jsonb,
  updated_at = now()
WHERE id = 'default'
  AND system_instruction LIKE E'You are a phone receptionist answering on behalf of the device owner.\nGreet the caller warmly, find out why they are calling, capture their name and a callback number,\nand help with simple scheduling. If you cannot help, offer to take a message.%';

UPDATE hermes.personas SET
  system_instruction = E'You are screening an incoming call for the device owner.\nFind out who is calling and why. If it is a sales, marketing, or spam call, politely decline and end the call without taking a message.\nIf it is a genuine personal or business matter, you are allowed and encouraged to take a full detailed message: the caller''s name, callback number, exactly what they need, and how urgent it is. Read it back to confirm, then say the owner will get back to them.\nDo not schedule anything and never share any of the owner''s personal details.',
  trigger_config = '{"needsData":["how much","price","cost","quote","selling","offer","promotion"],"escalation":["speak to","talk to","real person","human","manager","put me through","connect me","is he there","is she there","when will they be back"],"offScript":["ignore your","ignore all","forget you","you are now","pretend","new instructions","disregard","system prompt","jailbreak"],"closing":["bye","goodbye","that''s all","not interested","nothing else","we''re done","thank you"]}'::jsonb,
  updated_at = now()
WHERE id = 'call-screener'
  AND system_instruction LIKE E'You are screening an incoming call for the device owner.\nFind out who is calling and why. If it is a sales, marketing, or spam call, politely decline and end the call without taking a message.\nIf it is a genuine personal or business matter, take the caller''s name, number, and a short summary%';

UPDATE hermes.personas SET
  system_instruction = E'You are answering outside the device owner''s working hours.\nGreet the caller, let them know the office is currently closed, and you are allowed and encouraged to take a full detailed message: their name, number, the reason for the call, and how urgent it is.\nRead it back to confirm, then promise the owner will call back on the next working day.\nDo not book appointments, quote prices, or make commitments on the owner''s behalf.',
  trigger_config = '{"needsData":[],"escalation":["speak to","talk to","real person","human","manager","someone else","supervisor","emergency","urgent"],"offScript":["ignore your","ignore all","forget you","you are now","pretend","new instructions","disregard","system prompt","jailbreak"],"closing":["bye","goodbye","that''s all","thanks, bye","nothing else","we''re done","talk later","thank you"]}'::jsonb,
  updated_at = now()
WHERE id = 'after-hours'
  AND system_instruction LIKE E'You are answering outside the device owner''s working hours.\nGreet the caller, let them know the office is currently closed, and take a detailed message%';
