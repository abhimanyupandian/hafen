"""The same agent over A2A (Agent2Agent), for A2A clients. Hafen talks to server.py instead.

Run it with: .venv/bin/python a2a_server.py   (its agent card: http://127.0.0.1:8101/.well-known/agent-card.json)
"""

import uvicorn
from google.adk.a2a.utils.agent_to_a2a import to_a2a

from orders_agent.agent import root_agent

PORT = 8101
app = to_a2a(root_agent, host="127.0.0.1", port=PORT)

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT)
