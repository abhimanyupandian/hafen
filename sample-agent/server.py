"""The order agent's chat endpoint: POST /chat streams one turn as server-sent events.

    request:  { "message": "…", "session": "<id from an earlier turn>" (optional) }
    events:   { "type": "session", "id" }                       first: the conversation's session
              { "type": "thinking", "text" }                    the model's thinking, as it streams
              { "type": "tool_call", "id", "name", "args" }     a tool the agent calls
              { "type": "tool_result", "id", "name", "result" } what the tool returned
              { "type": "text", "text" }                        the reply, as it streams
              { "type": "usage", "input", "output", "thinking" } tokens, for the whole turn
              { "type": "error", "message" }                    a turn that failed
              [DONE]

A message without a session (or with one this server doesn't know) starts a new conversation, with
no orders. Replies are plain text and markdown: the model is told not to use emoji, and the few it
adds anyway are taken out here. Run it with: .venv/bin/uvicorn server:app --port 8100
"""

import json
import logging
import re
import warnings

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from orders_agent.agent import root_agent

warnings.filterwarnings("ignore")
logging.getLogger("google_adk").setLevel(logging.ERROR)

# Emoji (and the joiners and variation selectors that build them), taken out of what's streamed
EMOJI = re.compile("[\U0001F000-\U0001FAFF☀-➿⬀-⯿️‍]")

APP_NAME = "orders_agent"
USER_ID = "demo"

sessions = InMemorySessionService()
runner = Runner(app_name=APP_NAME, agent=root_agent, session_service=sessions)
app = FastAPI(title="Order management agent")


@app.get("/health")
async def health():
    return {"ok": True, "agent": root_agent.name, "model": root_agent.model.model}


@app.get("/orders/{session_id}")
async def orders(session_id: str):
    session = await sessions.get_session(app_name=APP_NAME, user_id=USER_ID, session_id=session_id)
    return {"orders": session.state.get("orders", []) if session else []}


@app.post("/chat")
async def chat(request: Request):
    body = await request.json()
    message = str(body.get("message") or "")
    session_id = body.get("session") or None
    if not session_id or not await sessions.get_session(app_name=APP_NAME, user_id=USER_ID, session_id=session_id):
        session_id = (await sessions.create_session(app_name=APP_NAME, user_id=USER_ID)).id
    return StreamingResponse(turn(session_id, message), media_type="text/event-stream")


def sse(event) -> str:
    return f"data: {event if isinstance(event, str) else json.dumps(event)}\n\n"


async def turn(session_id: str, message: str):
    yield sse({"type": "session", "id": session_id})
    usage = {"input": 0, "output": 0, "thinking": 0}
    # Each model call streams its thinking and text in pieces (partial events), then repeats all of it
    # in one final event: what was streamed already isn't sent again
    streamed = {"thinking": False, "text": False}
    try:
        async for event in runner.run_async(
            user_id=USER_ID,
            session_id=session_id,
            new_message=types.Content(role="user", parts=[types.Part(text=message)]),
            run_config=RunConfig(streaming_mode=StreamingMode.SSE),
        ):
            for part in event.content.parts if event.content and event.content.parts else []:
                if part.function_call:
                    # (a partial one is an early, empty copy of the call in the final event)
                    if not event.partial:
                        call = part.function_call
                        yield sse({"type": "tool_call", "id": call.id, "name": call.name, "args": call.args or {}})
                elif part.function_response:
                    response = part.function_response
                    yield sse({"type": "tool_result", "id": response.id, "name": response.name, "result": response.response})
                elif part.text:
                    kind = "thinking" if part.thought else "text"
                    text = EMOJI.sub("", part.text)
                    if event.partial:
                        streamed[kind] = True
                        if text:
                            yield sse({"type": kind, "text": text})
                    elif not streamed[kind] and text:
                        yield sse({"type": kind, "text": text})
            if not event.partial:
                streamed = {"thinking": False, "text": False}
                if event.usage_metadata:
                    meta = event.usage_metadata
                    usage["input"] += meta.prompt_token_count or 0
                    usage["output"] += meta.candidates_token_count or 0
                    usage["thinking"] += meta.thoughts_token_count or 0
        yield sse({"type": "usage", **usage})
    except Exception as err:  # the turn fails, saying why, rather than ending with no reply
        yield sse({"type": "error", "message": f"{type(err).__name__}: {err}"})
    yield sse("[DONE]")
