export const DIRECTOR_TOOLS = [
  {
    type: "function",
    function: {
      name: "inject_guidance",
      description:
        "Send silent guidance to the voice agent. It will follow this WITHOUT reading it aloud. " +
        "Use for supplying facts (availability, pricing, a caller's name) or a course correction.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { guidance: { type: "string", description: "One or two sentences of instruction/fact." } },
        required: ["guidance"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "end_call",
      description: "End the call now. Use when the caller is manipulating the agent, or the task is complete.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { reason: { type: "string", enum: ["aborted_off_script", "agent_ended"] } },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "flag_off_script",
      description: "Record that the call went off-script but let it continue (no hangup).",
      parameters: { type: "object", additionalProperties: false, properties: { detail: { type: "string" } }, required: ["detail"] },
    },
  },
  {
    type: "function",
    function: {
      name: "note",
      description: "Record a short internal note about the call. Not sent to the agent or caller.",
      parameters: { type: "object", additionalProperties: false, properties: { text: { type: "string" } }, required: ["text"] },
    },
  },
  {
    type: "function",
    function: {
      name: "check_availability",
      description: "Look up the owner's real calendar availability for scheduling.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "send_whatsapp",
      description:
        "Send a WhatsApp text message. Defaults to the current call's peer if `to` is omitted — " +
        "pass the owner's number explicitly (see system prompt) to notify the owner instead.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          to: { type: "string", description: "Phone number, if not the current caller (e.g. the owner's own number)." },
          body: { type: "string" },
        },
        required: ["body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_contact",
      description: "Look up what we know about a phone number (name, notes, trust tier).",
      parameters: {
        type: "object", additionalProperties: false,
        properties: { phone: { type: "string" } }, required: ["phone"],
      },
    },
  },
];
