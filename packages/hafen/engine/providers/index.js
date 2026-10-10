// A provider from its configuration (contracts/provider.md): a configured HTTP endpoint, an API's
// preset, or a plugin's.

import { httpProvider } from "./http.js";
import { anthropicMessages } from "./presets/anthropic-messages.js";
import { gemini } from "./presets/gemini.js";
import { ollama } from "./presets/ollama.js";
import { openaiChat } from "./presets/openai-chat.js";
import { openaiResponses } from "./presets/openai-responses.js";
import { pluginsWhere } from "../plugin-place.js";

export const PRESETS = {
  "openai-chat": openaiChat,
  "openai-responses": openaiResponses,
  "anthropic-messages": anthropicMessages,
  gemini,
  ollama,
};

export const KINDS = ["http", ...Object.keys(PRESETS)];

// plugins: { [name]: a loaded provider plugin } (engine/plugins.js)
export function createProvider(config, { plugins = {} } = {}) {
  if (!config || typeof config !== "object") throw new Error("A provider needs a configuration");
  if (config.kind === "http") return httpProvider(config);
  if (PRESETS[config.kind]) return PRESETS[config.kind](config);
  if (typeof config.kind === "string" && config.kind.startsWith("plugin:")) {
    const name = config.kind.slice("plugin:".length).split("@")[0];
    const plugin = plugins[name];
    if (!plugin) throw new Error(`The provider plugin "${name}" isn't in ${pluginsWhere()}`);
    if (!plugin.provider) throw new Error(`The plugin "${name}" is a ${plugin.kind}, not a provider`);
    return plugin.provider(config);
  }
  throw new Error(`"${config.kind}" isn't a provider kind (${KINDS.join(", ")}, or plugin:<name>)`);
}

// A short description of a provider, for lists: its stream kind or preset
export function describeKind(config) {
  if (!config) return "";
  if (config.kind === "http") return config.stream && config.stream !== "none" ? config.stream : "json";
  return config.kind;
}
