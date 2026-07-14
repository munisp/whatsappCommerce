"""LangGraph-based AI Agent Orchestrator.

Implements the agentic workflow described in the sequence diagram:
  1. Receive inbound message
  2. Load conversation context from Redis
  3. Apply guardrails
  4. Classify intent via LLM
  5. Route to appropriate sub-agent (product, cart, order, payment, support)
  6. Execute tool calls
  7. Apply outbound guardrails
  8. Return reply + next action
"""
import asyncio
import structlog
from typing import Any, Optional, TypedDict, Annotated
from dataclasses import dataclass

log = structlog.get_logger()

# ─── Agent State ──────────────────────────────────────────────────────────────

@dataclass
class AgentInput:
    tenant_id: str
    conversation_id: str
    customer_id: str
    message: str
    flow_step: str = "greeting"


@dataclass
class AgentOutput:
    reply: str
    intent_type: str
    confidence: float
    next_action: str
    escalate: bool = False
    escalation_reason: Optional[str] = None
    entities: dict = None
    tool_calls: list = None
    flow_step: str = "greeting"

    def __post_init__(self):
        if self.entities is None:
            self.entities = {}
        if self.tool_calls is None:
            self.tool_calls = []


# ─── Intent Classification ────────────────────────────────────────────────────

INTENT_SYSTEM_PROMPT = """You are a WhatsApp commerce assistant. Classify the user's intent and extract entities.

Available intents:
- browse: User wants to browse/explore products
- search: User is searching for a specific product
- view_product: User wants details on a specific product
- add_to_cart: User wants to add an item to cart
- view_cart: User wants to see their cart
- checkout: User wants to checkout/pay
- order_status: User asking about an existing order
- support: User needs customer support
- handoff: User explicitly requests a human agent
- greeting: General greeting or unclear intent
- unknown: Cannot determine intent

Respond in JSON:
{
  "intent": "<intent_type>",
  "confidence": <0.0-1.0>,
  "entities": {
    "product_name": "<if mentioned>",
    "quantity": <if mentioned>,
    "order_id": "<if mentioned>",
    "sku": "<if mentioned>"
  },
  "reply": "<conversational response in the same language as the user>",
  "next_action": "<what the system should do next>"
}"""


class AIOrchestrator:
    """Main AI agent orchestrator using LangGraph-style state machine."""

    def __init__(self, config, commerce_tools, memory, guardrails):
        self.config = config
        self.commerce_tools = commerce_tools
        self.memory = memory
        self.guardrails = guardrails
        self._llm_client = None

    async def _get_llm_client(self):
        """Lazily initialize the LLM client."""
        if self._llm_client is not None:
            return self._llm_client
        provider = self.config.llm_provider
        if provider == "openai" and self.config.openai_api_key:
            from openai import AsyncOpenAI
            self._llm_client = AsyncOpenAI(api_key=self.config.openai_api_key)
        elif provider == "anthropic" and self.config.anthropic_api_key:
            from anthropic import AsyncAnthropic
            self._llm_client = AsyncAnthropic(api_key=self.config.anthropic_api_key)
        else:
            # Fallback: rule-based intent classification
            self._llm_client = None
        return self._llm_client

    async def process(self, inp: AgentInput) -> AgentOutput:
        """Main processing pipeline."""
        log.info("agent_processing", tenant_id=inp.tenant_id, conversation_id=inp.conversation_id)

        # Step 1: Apply inbound guardrails
        guard_result = self.guardrails.check_inbound(
            inp.message, inp.tenant_id, inp.conversation_id
        )
        if guard_result.blocked:
            return AgentOutput(
                reply="I'm sorry, I cannot process that request.",
                intent_type="blocked",
                confidence=1.0,
                next_action="none",
            )
        if guard_result.escalate:
            return AgentOutput(
                reply="I understand your frustration. Let me connect you with a human agent who can help you better.",
                intent_type="handoff",
                confidence=0.95,
                next_action="handoff",
                escalate=True,
                escalation_reason=guard_result.escalation_reason,
            )

        sanitized_message = guard_result.redacted_text

        # Step 2: Load conversation context
        ctx = await self.memory.get_context(inp.tenant_id, inp.conversation_id, inp.customer_id)

        # Step 3: Classify intent
        intent_result = await self._classify_intent(sanitized_message, ctx)

        # Step 4: Route to sub-agent based on intent
        reply, tool_calls = await self._route_to_subagent(intent_result, ctx, inp)

        # Step 5: Apply outbound guardrails
        out_guard = self.guardrails.check_outbound(reply, self.config.max_tokens_per_turn)
        final_reply = out_guard.redacted_text

        # Step 6: Persist messages to memory
        await self.memory.append_message(inp.tenant_id, inp.conversation_id, inp.customer_id, "user", sanitized_message)
        await self.memory.append_message(inp.tenant_id, inp.conversation_id, inp.customer_id, "assistant", final_reply)

        # Update context
        ctx.current_intent = intent_result.get("intent", "unknown")
        ctx.flow_step = intent_result.get("next_action", ctx.flow_step)
        await self.memory.save_context(ctx)

        return AgentOutput(
            reply=final_reply,
            intent_type=intent_result.get("intent", "unknown"),
            confidence=intent_result.get("confidence", 0.5),
            next_action=intent_result.get("next_action", "none"),
            escalate=intent_result.get("intent") == "handoff",
            entities=intent_result.get("entities", {}),
            tool_calls=tool_calls,
            flow_step=ctx.flow_step,
        )

    async def _classify_intent(self, message: str, ctx) -> dict[str, Any]:
        """Classify user intent using LLM or rule-based fallback."""
        client = await self._get_llm_client()

        if client is None or self.config.llm_provider == "openai":
            # Rule-based fallback
            return self._rule_based_intent(message)

        try:
            # Build conversation history for context
            history = []
            for msg in ctx.messages[-6:]:  # Last 3 turns
                history.append({"role": msg.role, "content": msg.content})

            messages = [
                {"role": "system", "content": INTENT_SYSTEM_PROMPT},
                *history,
                {"role": "user", "content": message},
            ]

            if self.config.llm_provider == "openai":
                resp = await client.chat.completions.create(
                    model=self.config.llm_model,
                    messages=messages,
                    response_format={"type": "json_object"},
                    max_tokens=500,
                    temperature=0.1,
                )
                import json
                return json.loads(resp.choices[0].message.content)
        except Exception as e:
            log.error("llm_intent_failed", error=str(e))
            return self._rule_based_intent(message)

        return self._rule_based_intent(message)

    def _rule_based_intent(self, message: str) -> dict[str, Any]:
        """Rule-based intent classification fallback."""
        msg = message.lower().strip()

        # Greeting
        if any(w in msg for w in ["hi", "hello", "hey", "start", "menu", "help"]):
            return {"intent": "greeting", "confidence": 0.9, "entities": {},
                    "reply": self._greeting_reply(), "next_action": "show_menu"}

        # Human handoff
        if any(w in msg for w in ["agent", "human", "person", "speak to someone", "representative"]):
            return {"intent": "handoff", "confidence": 0.95, "entities": {},
                    "reply": "Connecting you to a human agent...", "next_action": "handoff"}

        # Product search
        if any(w in msg for w in ["search", "find", "looking for", "show me", "do you have", "buy"]):
            return {"intent": "search", "confidence": 0.8, "entities": {"query": message},
                    "reply": f"Let me search for '{message}' for you...", "next_action": "search_products"}

        # Order status
        if any(w in msg for w in ["order", "track", "delivery", "shipped", "status"]):
            return {"intent": "order_status", "confidence": 0.8, "entities": {},
                    "reply": "Please provide your order ID to check the status.", "next_action": "get_order_status"}

        # Cart
        if any(w in msg for w in ["cart", "basket", "bag"]):
            return {"intent": "view_cart", "confidence": 0.85, "entities": {},
                    "reply": "Let me show you your cart...", "next_action": "view_cart"}

        # Checkout
        if any(w in msg for w in ["checkout", "pay", "payment", "buy now", "purchase"]):
            return {"intent": "checkout", "confidence": 0.85, "entities": {},
                    "reply": "Ready to checkout! Let me prepare your order...", "next_action": "initiate_checkout"}

        # Unknown
        return {"intent": "unknown", "confidence": 0.3, "entities": {},
                "reply": self._greeting_reply(), "next_action": "show_menu"}

    async def _route_to_subagent(self, intent_result: dict, ctx, inp: AgentInput) -> tuple[str, list]:
        """Route to the appropriate sub-agent based on classified intent."""
        intent = intent_result.get("intent", "unknown")
        entities = intent_result.get("entities", {})
        tool_calls = []

        try:
            if intent == "search":
                query = entities.get("query", inp.message)
                result = await self.commerce_tools.search_products(query)
                if result.get("found"):
                    products = result["products"]
                    reply = f"I found {len(products)} product(s) for you:\n\n"
                    for i, p in enumerate(products, 1):
                        reply += f"{i}. *{p['name']}* — {p['price']}\n   {p.get('description', '')}\n\n"
                    reply += "Reply with the number to add to cart, or type 'more' for details."
                else:
                    reply = f"Sorry, I couldn't find any products matching your search. Try different keywords."
                tool_calls.append({"tool": "search_products", "result": result})

            elif intent == "view_cart":
                if ctx.cart_id:
                    result = await self.commerce_tools.get_cart(ctx.cart_id)
                    if result.get("item_count", 0) > 0:
                        items_text = "\n".join([f"• {i['name']} x{i['qty']} — {i['price']}" for i in result["items"]])
                        reply = f"🛒 *Your Cart*\n\n{items_text}\n\n*Total: {result['total']}*\n\nType 'checkout' to proceed."
                    else:
                        reply = "Your cart is empty. Browse our products to get started!"
                else:
                    reply = "Your cart is empty. Browse our products to get started!"

            elif intent == "checkout":
                if ctx.cart_id:
                    result = await self.commerce_tools.initiate_checkout(ctx.cart_id)
                    if result.get("success"):
                        reply = f"✅ {result['message']}\n\nOrder ID: {result['order_id']}\n\nYou'll receive a payment link shortly."
                    else:
                        reply = "I couldn't process your checkout. Please try again or type 'agent' for help."
                else:
                    reply = "Your cart is empty. Add some products first!"

            elif intent == "order_status":
                order_id = entities.get("order_id")
                if order_id:
                    result = await self.commerce_tools.get_order_status(order_id)
                    reply = result.get("message", "Order status unavailable.")
                else:
                    reply = "Please provide your order ID (e.g., 'status ORD-12345')."

            elif intent == "greeting":
                reply = intent_result.get("reply", self._greeting_reply())

            else:
                reply = intent_result.get("reply", self._greeting_reply())

        except Exception as e:
            log.error("subagent_error", intent=intent, error=str(e))
            reply = "I encountered an issue. Please try again or type 'agent' to speak with a human."

        return reply, tool_calls

    def _greeting_reply(self) -> str:
        return (
            "👋 Welcome! I'm your shopping assistant.\n\n"
            "How can I help you today?\n\n"
            "1️⃣  Browse Products\n"
            "2️⃣  Search for something\n"
            "3️⃣  View Cart\n"
            "4️⃣  Check Order Status\n"
            "5️⃣  Speak to an Agent\n\n"
            "Just type your question or choose a number!"
        )

