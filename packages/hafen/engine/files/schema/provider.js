// The provider file's JSON Schema, from spec/001-hafen/contracts/provider.schema.json (tests/engine/foundations.test.js
// fails if they differ). A module rather than a .json file, so every runtime imports it the same way.

export default {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Hafen provider",
  "description": "How to talk to one chat endpoint (spec/001-hafen/contracts/provider.md). Hafen's own checks go further than the schema: a key it doesn't know is a problem (keys of your own start with x-; a provider with fixtures gives them its other keys), and is kept in the file.",
  "type": "object",
  "required": [
    "kind"
  ],
  "properties": {
    "kind": {
      "type": "string",
      "pattern": "^(http|openai-chat|openai-responses|anthropic-messages|gemini|ollama|plugin:[A-Za-z0-9@/._^~-]+)$"
    },
    "fixtures": {
      "type": "object",
      "description": "Fixture plugins to run around this provider's requests, each list in its order: beforeAll (once per run, before its first request), before (before each test), after (after each test), afterAll (once, when the run ends). What beforeAll's and before's give are secrets for the run (or the test): {{secret.NAME}}, in a file or in a plugin's request. A name may take a version range: acme-login@^1",
      "additionalProperties": false,
      "properties": {
        "beforeAll": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^[^@\\s]+(@\\S+)?$"
          }
        },
        "before": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^[^@\\s]+(@\\S+)?$"
          }
        },
        "after": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^[^@\\s]+(@\\S+)?$"
          }
        },
        "afterAll": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^[^@\\s]+(@\\S+)?$"
          }
        }
      }
    },
    "url": {
      "type": "string"
    },
    "version": {
      "type": [
        "string",
        "number"
      ],
      "description": "The API's version: anthropic-version for anthropic-messages"
    },
    "method": {
      "enum": [
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE"
      ]
    },
    "query": {
      "type": "object",
      "additionalProperties": {
        "type": "string"
      }
    },
    "headers": {
      "type": "object",
      "additionalProperties": {
        "type": "string"
      }
    },
    "body": {},
    "secret_headers": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "timeout_ms": {
      "type": "integer",
      "minimum": 1
    },
    "retries": {
      "type": "integer",
      "minimum": 0
    },
    "history": {
      "enum": [
        "messages",
        "session",
        "none"
      ]
    },
    "messages_format": {
      "enum": [
        "openai",
        "anthropic",
        "gemini",
        "text"
      ]
    },
    "session": {
      "type": "object",
      "properties": {
        "extract": {
          "$ref": "#/$defs/path"
        },
        "send": {
          "enum": [
            "body",
            "header",
            "cookie"
          ]
        },
        "name": {
          "type": "string"
        }
      }
    },
    "stream": {
      "enum": [
        "none",
        "sse",
        "ndjson"
      ]
    },
    "done_marker": {
      "type": "string"
    },
    "response": {
      "type": "object",
      "properties": {
        "text": {
          "$ref": "#/$defs/path"
        },
        "thinking": {
          "$ref": "#/$defs/path"
        },
        "thinking_visibility": {
          "$ref": "#/$defs/visibility"
        },
        "tool_calls": {
          "$ref": "#/$defs/toolCallMap"
        },
        "usage": {
          "$ref": "#/$defs/usageMap"
        },
        "session": {
          "$ref": "#/$defs/path"
        },
        "finish": {
          "$ref": "#/$defs/path"
        },
        "error": {
          "$ref": "#/$defs/path"
        }
      }
    },
    "events": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/eventRule"
      }
    },
    "think_tags": {
      "type": "array",
      "prefixItems": [
        {
          "type": "string"
        },
        {
          "type": "string"
        }
      ],
      "minItems": 2,
      "maxItems": 2
    },
    "thinking": {
      "type": "object",
      "properties": {
        "request": {
          "type": "object"
        },
        "visibility": {
          "$ref": "#/$defs/visibility"
        }
      }
    },
    "base_url": {
      "type": "string"
    },
    "model": {
      "type": "string"
    },
    "api_key": {
      "type": "string"
    },
    "params": {
      "type": "object"
    },
    "price": {
      "type": "object",
      "required": [
        "input",
        "output"
      ],
      "properties": {
        "input": {
          "type": "number",
          "minimum": 0
        },
        "output": {
          "type": "number",
          "minimum": 0
        },
        "cached_input": {
          "type": "number",
          "minimum": 0
        }
      }
    }
  },
  "allOf": [
    {
      "if": {
        "properties": {
          "kind": {
            "enum": [
              "http"
            ]
          }
        }
      },
      "then": {
        "required": [
          "url"
        ]
      }
    }
  ],
  "$defs": {
    "path": {
      "type": "string",
      "pattern": "^\\$"
    },
    "visibility": {
      "enum": [
        "full",
        "summary",
        "progress",
        "omitted",
        "redacted"
      ]
    },
    "toolCallMap": {
      "type": "object",
      "required": [
        "name"
      ],
      "properties": {
        "path": {
          "$ref": "#/$defs/path"
        },
        "name": {
          "$ref": "#/$defs/path"
        },
        "args": {
          "$ref": "#/$defs/path"
        },
        "id": {
          "$ref": "#/$defs/path"
        },
        "result": {
          "$ref": "#/$defs/path"
        }
      }
    },
    "usageMap": {
      "type": "object",
      "properties": {
        "input": {
          "$ref": "#/$defs/path"
        },
        "output": {
          "$ref": "#/$defs/path"
        },
        "thinking": {
          "$ref": "#/$defs/path"
        },
        "cached": {
          "$ref": "#/$defs/path"
        }
      }
    },
    "eventRule": {
      "type": "object",
      "properties": {
        "when": {
          "type": "object",
          "properties": {
            "event": {
              "type": "string"
            }
          },
          "patternProperties": {
            "^\\$": {}
          }
        },
        "text": {
          "$ref": "#/$defs/path"
        },
        "thinking": {
          "$ref": "#/$defs/path"
        },
        "thinking_visibility": {
          "$ref": "#/$defs/visibility"
        },
        "tool_call": {
          "$ref": "#/$defs/toolCallMap"
        },
        "tool_result": {
          "$ref": "#/$defs/toolCallMap"
        },
        "usage": {
          "$ref": "#/$defs/usageMap"
        },
        "session": {
          "$ref": "#/$defs/path"
        },
        "finish": {
          "$ref": "#/$defs/path"
        },
        "error": {
          "$ref": "#/$defs/path"
        },
        "done": {
          "const": true
        }
      }
    }
  }
};
