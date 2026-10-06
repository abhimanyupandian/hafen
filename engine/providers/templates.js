// The kinds of provider a new one can start from (contracts/ui.md, New provider), and the file each
// starts as: a preset with its model and address, or an HTTP / WebSocket endpoint to fill in. Every
// file is valid as it is (tests/engine/providers.test.js checks them against the schema).

const yamlString = (v) => (/^[\w./:@-]+$/.test(v) ? v : JSON.stringify(v));

// id: what the list shows and the template's key; name: the file's default name
export const PROVIDER_KINDS = [
  { id: "ollama", label: "Ollama", name: "ollama", preset: true, model: "gemma4", base: "http://localhost:11434",
    about: "A model served by Ollama (POST /api/chat, streamed). No key for a local server." },
  { id: "openai-chat", label: "OpenAI chat completions", name: "openai", preset: true, base: "https://api.openai.com/v1", key: "OPENAI_API_KEY",
    about: "OpenAI's Chat Completions API, streamed, or any server compatible with it (vLLM, llama.cpp, OpenRouter, LM Studio)." },
  { id: "openai-responses", label: "OpenAI responses", name: "openai-responses", preset: true, base: "https://api.openai.com/v1", key: "OPENAI_API_KEY",
    about: "OpenAI's Responses API, streamed, with thinking summaries." },
  { id: "anthropic-messages", label: "Anthropic messages", name: "anthropic", preset: true, model: "claude-opus-5-5", base: "https://api.anthropic.com/v1", key: "ANTHROPIC_API_KEY",
    about: "Anthropic's Messages API, streamed, with thinking." },
  { id: "gemini", label: "Gemini", name: "gemini", preset: true, base: "https://generativelanguage.googleapis.com/v1beta", key: "GEMINI_API_KEY",
    about: "Google's Gemini API (streamGenerateContent), with thinking." },
  { id: "http", label: "HTTP endpoint · one JSON reply", name: "endpoint",
    about: "Your own endpoint, answering with one JSON body: say where the reply is with JSONPath." },
  { id: "http-sse", label: "HTTP endpoint · streamed (SSE)", name: "endpoint-sse",
    about: "Your own endpoint, streaming server-sent events: rules map each event to text, thinking or tool calls." },
  { id: "http-ndjson", label: "HTTP endpoint · streamed (JSON lines)", name: "endpoint-ndjson",
    about: "Your own endpoint, streaming one JSON value per line: rules map each line." },
  { id: "websocket", label: "WebSocket", name: "websocket",
    about: "An endpoint that chats over a WebSocket." },
];

export const kindOf = (id) => PROVIDER_KINDS.find((k) => k.id === id);

// A new provider file's text: { model, base } fill in a preset; { url } an endpoint
export function providerTemplate(id, { model, base, url } = {}) {
  const k = kindOf(id);
  if (!k) throw new Error(`"${id}" isn't a kind of provider`);
  const head = `# ${k.label}: ${k.about}\n`;
  if (k.preset) {
    const lines = [`kind: ${k.id}`, `model: ${yamlString(model || k.model || "the-model-id")}`];
    lines.push(base && base !== k.base ? `base_url: ${yamlString(base)}` : `# base_url: ${k.base}`);
    if (k.key) lines.push(`# api_key: \${env:${k.key}}   # the default; set its value in Settings → Secrets`);
    else lines.push("# api_key: ${env:OLLAMA_API_KEY}   # only for ollama.com or a server behind a key");
    lines.push(k.id === "ollama" ? "# params: { think: true, options: { temperature: 0 } }" : "# params: { temperature: 0 }");
    return `${head}${lines.join("\n")}\n`;
  }
  const at = yamlString(url || (k.id === "websocket" ? "wss://chat.example.com/ws" : "{{base_url}}/chat"));
  switch (k.id) {
    case "http":
      return `${head}kind: http
url: ${at}
headers:
  Authorization: "Bearer \${env:API_KEY}"
body:
  message: "{{user}}"
  history: "{{history}}"     # the earlier turns: [{ query, response }]
response:
  text: $.reply
`;
    case "http-sse":
    case "http-ndjson":
      return `${head}kind: http
url: ${at}
headers:
  Authorization: "Bearer \${env:API_KEY}"
body:
  message: "{{user}}"
  history: "{{history}}"     # the earlier turns: [{ query, response }]
stream: ${k.id === "http-sse" ? "sse" : "ndjson"}
events:
  - when: { $.type: thinking }
    thinking: $.delta
  - when: { $.type: text }
    text: $.delta
  - when: { $.type: tool_call }
    tool_call: { id: $.id, name: $.name, args: $.args }
  - when: { $.type: error }
    error: $.message
`;
    case "websocket":
    default:
      return `${head}kind: websocket
url: ${at}
send: { type: message, text: "{{user}}" }
events:
  - when: { $.type: delta }
    text: $.text
  - when: { $.type: end }
    done: true
end: { idle_ms: 5000 }
`;
  }
}
