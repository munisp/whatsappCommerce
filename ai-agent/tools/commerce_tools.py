"""Commerce tools for the AI agent — product search, cart management, order status."""
import httpx
import structlog
from typing import Any, Optional
from pydantic import BaseModel, Field

log = structlog.get_logger()


class ProductSearchInput(BaseModel):
    query: str = Field(description="Natural language product search query")
    category: Optional[str] = Field(None, description="Optional product category filter")
    limit: int = Field(5, description="Maximum number of results")


class AddToCartInput(BaseModel):
    cart_id: str = Field(description="Cart UUID")
    product_id: str = Field(description="Product UUID to add")
    quantity: int = Field(1, description="Quantity to add")


class OrderStatusInput(BaseModel):
    order_id: str = Field(description="Order UUID")


class CommerceTools:
    """Wraps the Commerce Engine HTTP API as LangChain-compatible tools."""

    def __init__(self, base_url: str, tenant_id: str):
        self.base_url = base_url.rstrip("/")
        self.tenant_id = tenant_id
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            headers={"X-Tenant-ID": tenant_id},
            timeout=10.0,
        )

    async def search_products(self, query: str, category: Optional[str] = None, limit: int = 5) -> dict[str, Any]:
        """Search the product catalog by natural language query."""
        try:
            params = {"q": query, "limit": limit}
            if category:
                params["category"] = category
            resp = await self._client.get("/products/search", params=params)
            resp.raise_for_status()
            data = resp.json()
            products = data.get("products", [])
            if not products:
                return {"found": False, "message": f"No products found for '{query}'"}
            # Format for conversational display
            formatted = []
            for p in products[:limit]:
                formatted.append({
                    "id": p["id"],
                    "name": p["name"],
                    "price": f"{p['currency']} {p['price']:.2f}",
                    "category": p.get("category", ""),
                    "sku": p["sku"],
                    "description": p.get("description", "")[:100],
                })
            return {"found": True, "products": formatted, "count": len(formatted)}
        except Exception as e:
            log.error("product_search_failed", error=str(e), query=query)
            return {"found": False, "error": str(e)}

    async def get_product_details(self, product_id: str) -> dict[str, Any]:
        """Get full details for a specific product."""
        try:
            resp = await self._client.get(f"/products/{product_id}")
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            return {"error": str(e)}

    async def check_stock(self, sku: str) -> dict[str, Any]:
        """Check real-time stock availability for a SKU."""
        try:
            resp = await self._client.get(f"/inventory/{sku}")
            resp.raise_for_status()
            data = resp.json()
            available = data.get("available", 0)
            return {
                "sku": sku,
                "in_stock": available > 0,
                "available_qty": available,
                "message": f"{'In stock' if available > 0 else 'Out of stock'} ({available} units available)",
            }
        except Exception as e:
            return {"error": str(e), "in_stock": False}

    async def create_cart(self, customer_id: str, currency: str = "USD") -> dict[str, Any]:
        """Create a new shopping cart for the customer."""
        try:
            resp = await self._client.post("/carts", json={"customer_id": customer_id, "currency": currency})
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            return {"error": str(e)}

    async def add_to_cart(self, cart_id: str, product_id: str, quantity: int = 1) -> dict[str, Any]:
        """Add a product to the customer's cart."""
        try:
            resp = await self._client.post(f"/carts/{cart_id}/items", json={"product_id": product_id, "quantity": quantity})
            resp.raise_for_status()
            return {"success": True, "message": f"Added {quantity} item(s) to cart", "item": resp.json()}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def get_cart(self, cart_id: str) -> dict[str, Any]:
        """Get the current cart contents."""
        try:
            resp = await self._client.get(f"/carts/{cart_id}")
            resp.raise_for_status()
            data = resp.json()
            cart = data.get("cart", {})
            items = data.get("items", [])
            total = sum(i.get("total_price", 0) for i in items)
            return {
                "cart_id": cart_id,
                "items": [{"name": i["product_name"], "qty": i["quantity"], "price": i["total_price"]} for i in items],
                "total": f"{cart.get('currency', 'USD')} {total:.2f}",
                "item_count": len(items),
            }
        except Exception as e:
            return {"error": str(e)}

    async def get_order_status(self, order_id: str) -> dict[str, Any]:
        """Get the current status of an order."""
        try:
            resp = await self._client.get(f"/orders/{order_id}")
            resp.raise_for_status()
            data = resp.json()
            return {
                "order_id": order_id,
                "status": data.get("status"),
                "total": f"{data.get('currency', 'USD')} {data.get('total_amount', 0):.2f}",
                "created_at": data.get("created_at"),
                "message": f"Your order is currently {data.get('status', 'unknown')}.",
            }
        except Exception as e:
            return {"error": str(e)}

    async def initiate_checkout(self, cart_id: str) -> dict[str, Any]:
        """Initiate checkout for the cart — creates an order."""
        try:
            resp = await self._client.post(f"/carts/{cart_id}/checkout")
            resp.raise_for_status()
            data = resp.json()
            order = data.get("order", {})
            return {
                "success": True,
                "order_id": order.get("id"),
                "total": f"{order.get('currency', 'USD')} {order.get('total_amount', 0):.2f}",
                "next_step": "payment",
                "message": f"Order created! Total: {order.get('currency', 'USD')} {order.get('total_amount', 0):.2f}. Proceeding to payment...",
            }
        except Exception as e:
            return {"success": False, "error": str(e)}

