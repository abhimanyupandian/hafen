# Sample agent: a coffee shop's shopping assistant

A small agent to try Hafen on: it keeps a cart (add, list, remove), places an order for what's in it,
and lists the orders with their status. It's built with
[Google ADK](https://google.github.io/adk-docs/) and runs on a local model, Qwen3-4B Instruct in Ollama,
so it needs no keys and no network.

- `orders_agent/agent.py`: the agent and its tools: `add_to_cart`, `list_cart`, `remove_from_cart`,
  `place_order` and `list_orders`, over a small catalog with prices. The cart and the orders live in
  the ADK session, so each conversation starts with neither; orders are numbered from 1001. Only
  `list_cart` and `list_orders` return prices, totals and status, so the agent has to call them to
  answer what's in the cart or how an order is doing.
- `server.py`: a chat endpoint, `POST /chat`, that streams each turn as server-sent events: thinking,
  tool calls and results, the reply, token usage. Its docstring lists the events.
- `a2a_server.py`: the same agent over [A2A](https://a2a-protocol.org), for A2A clients.
- `hafen/`: a Hafen provider for the chat endpoint, and a suite that tests a conversation.

## Run it

You need Python 3.10 or newer, and [Ollama](https://ollama.com) with the model:

```sh
ollama pull qwen3:4b-instruct-2507-q4_K_M

cd sample-agent
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

.venv/bin/uvicorn server:app --port 8100     # the chat endpoint, for Hafen
.venv/bin/python a2a_server.py               # optional: A2A, on port 8101
```

`ORDERS_AGENT_MODEL` picks another model, by its LiteLLM name. `ollama_chat/qwen3:4b` (Qwen3-4B
Thinking) shows its thinking in Hafen, but thinks before every answer: on a laptop a turn takes from 15
seconds to about two minutes, where the default takes a few seconds. The provider allows each turn
five minutes.

## Test it with Hafen

With the agent running, from the repository's folder:

```sh
npx hafen run sample-agent/hafen --env local --secret ~/.hafen-demo/jev.secret.env
```

The suite has eight turns: a greeting, add coffee, add a kettle, show the cart (a markdown table),
remove the kettle, show the cart again, place the order, show the orders and their status (a table).
Each turn checks that the right tool was called with the right arguments, and what the reply says.
[System One](../docs/checks.md#system-one) checks judge the greeting, that the order was confirmed, and
how polite the assistant was throughout; they need a System One key, the secret `JEV_API_KEY` (here in
a `--secret` file).

In the app, add the provider (`hafen/providers/orders-agent.yml`), choose a scope with
`agent_url` set to `http://127.0.0.1:8100`, and send it a message.
