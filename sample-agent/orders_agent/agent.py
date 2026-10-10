"""A shopping agent for a small coffee shop, built with Google ADK on a local model (Ollama's Qwen3-4B
Instruct 2507).

It adds items to a cart, lists the cart, removes items from it, places an order for what's in it, and
lists the orders with their status. The cart and the orders live in the ADK session's state, so each new
conversation starts with neither, and order numbers start at 1001.
"""

import os

from google.adk.agents import LlmAgent
from google.adk.models.lite_llm import LiteLlm
from google.adk.tools import ToolContext

# The model, by its LiteLLM name. The default answers without thinking first: a turn takes seconds.
# ollama_chat/qwen3:4b (Qwen3-4B Thinking) thinks before every answer: much slower on a laptop.
MODEL = os.environ.get("ORDERS_AGENT_MODEL", "ollama_chat/qwen3:4b-instruct-2507-q4_K_M")
FIRST_ORDER_ID = 1001

# What the shop sells, and each item's price (USD)
CATALOG = {
    "Ethiopian coffee beans": 14.00,
    "Colombian coffee beans": 12.50,
    "pour-over kettle": 39.00,
    "ceramic dripper": 22.00,
    "paper filters": 6.00,
    "coffee grinder": 89.00,
}


def _product(name: str) -> str | None:
    """The catalog's name for an item, matched loosely ("the kettle", "Ethiopian beans"), or None."""
    wanted = name.lower().strip()
    for product in CATALOG:
        if wanted == product.lower():
            return product
    words = [w for w in wanted.replace("-", " ").split() if w not in {"a", "an", "the", "bag", "bags", "of", "some"}]
    matches = [p for p in CATALOG if words and all(w.rstrip("s") in p.lower().replace("-", " ") for w in words)]
    return matches[0] if len(matches) == 1 else None


def _cart(tool_context: ToolContext) -> list[dict]:
    return [dict(line) for line in tool_context.state.get("cart", [])]


def _cart_view(cart: list[dict]) -> dict:
    lines = [{**line, "subtotal": round(line["price"] * line["quantity"], 2)} for line in cart]
    return {"items": lines, "total": round(sum(line["subtotal"] for line in lines), 2)}


def add_to_cart(item: str, quantity: int, tool_context: ToolContext) -> dict:
    """Adds an item to the customer's cart.

    Args:
        item: What to add, for example "Ethiopian coffee beans" or "pour-over kettle".
        quantity: How many: 1 or more.

    Returns:
        What was added, or an error (an item the shop doesn't sell lists what it does). Not the
        cart's prices or total: list_cart has those.
    """
    if quantity < 1:
        return {"error": "the quantity must be 1 or more"}
    product = _product(item)
    if not product:
        return {"error": f"the shop doesn't sell {item!r}", "products": list(CATALOG)}
    cart = _cart(tool_context)
    for line in cart:
        if line["item"] == product:
            line["quantity"] += quantity
            break
    else:
        cart.append({"item": product, "quantity": quantity, "price": CATALOG[product]})
    tool_context.state["cart"] = cart
    return {"added": {"item": product, "quantity": quantity}}


def list_cart(tool_context: ToolContext) -> dict:
    """Lists what's in the customer's cart, with prices and the total.

    Returns:
        The cart's items (item, quantity, price, subtotal) and its total.
    """
    return _cart_view(_cart(tool_context))


def remove_from_cart(item: str, tool_context: ToolContext) -> dict:
    """Removes an item from the customer's cart.

    Args:
        item: The item to remove, for example "pour-over kettle".

    Returns:
        What was removed, or an error if it isn't in the cart.
    """
    product = _product(item)
    cart = _cart(tool_context)
    kept = [line for line in cart if line["item"] != product]
    if not product or len(kept) == len(cart):
        return {"error": f"{item!r} isn't in the cart", "in_cart": [line["item"] for line in cart]}
    tool_context.state["cart"] = kept
    return {"removed": product}


def place_order(tool_context: ToolContext) -> dict:
    """Places an order for everything in the customer's cart, and empties the cart.

    Returns:
        The order placed (order_id, total, status), or an error if the cart is empty.
    """
    cart = _cart(tool_context)
    if not cart:
        return {"error": "the cart is empty"}
    orders = [dict(order) for order in tool_context.state.get("orders", [])]
    view = _cart_view(cart)
    order = {"order_id": FIRST_ORDER_ID + len(orders), "items": view["items"], "total": view["total"], "status": "processing"}
    orders.append(order)
    tool_context.state["orders"] = orders
    tool_context.state["cart"] = []
    return {"order_id": order["order_id"], "total": order["total"], "status": order["status"]}


def list_orders(tool_context: ToolContext) -> dict:
    """Lists the customer's orders, oldest first, with their status.

    Returns:
        The orders: each one's order_id, items, total and status.
    """
    return {"orders": tool_context.state.get("orders", [])}


root_agent = LlmAgent(
    name="orders_agent",
    model=LiteLlm(model=MODEL),
    description="A coffee shop's shopping assistant: a cart, orders and their status.",
    instruction=(
        "You are a friendly, polite shopping assistant for a small online coffee shop. When the customer "
        "greets you, greet them back warmly and offer to help; don't call a tool. "
        "Use your tools for everything else: add_to_cart to add an item (quantity 1 unless the customer "
        "says otherwise), list_cart to show the cart, remove_from_cart to take an item out, place_order to "
        "order everything in the cart, and list_orders to show the orders and their status. "
        "You can't see the cart or the orders yourself, and the other tools don't return prices, totals "
        "or what's in the cart: whenever the customer asks what's in the cart, call list_cart, and "
        "whenever they ask about their orders or their status, call list_orders, every time. "
        "When you show the cart, show it as a markdown table with the columns Item, Quantity, Price and "
        "Subtotal, then the total. When you show the orders, show them as a markdown table with the "
        "columns Order, Items, Total and Status. Show prices in dollars, as the tools give them. "
        "Never make up items, prices, orders or statuses: only report what the tools return. Never say "
        "something was added, removed or ordered unless the tool returned it in this turn. "
        "Keep replies short and warm: confirm what you did, and offer to help with anything else. "
        "Write plain text and markdown only: never use emoji."
    ),
    tools=[add_to_cart, list_cart, remove_from_cart, place_order, list_orders],
)
