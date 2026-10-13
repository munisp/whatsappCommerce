package handler

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/whatsapp-commerce/commerce-engine/internal/config"
	"github.com/whatsapp-commerce/commerce-engine/internal/store"
	"go.uber.org/zap"
)

type Handler struct {
	cfg    *config.Config
	db     Store
	logger *zap.Logger
}

func New(cfg *config.Config, db Store, logger *zap.Logger) *Handler {
	return &Handler{cfg: cfg, db: db, logger: logger}
}

func (h *Handler) ListProducts(c *gin.Context) {
	tenantID := mustUUID(c.GetHeader("X-Tenant-ID"))
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "20"))
	offset, _ := strconv.Atoi(c.DefaultQuery("offset", "0"))
	category := c.Query("category")

	products, err := h.db.ListProducts(c.Request.Context(), tenantID, category, limit, offset)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"products": products, "count": len(products)})
}

func (h *Handler) GetProduct(c *gin.Context) {
	tenantID := mustUUID(c.GetHeader("X-Tenant-ID"))
	id := mustUUID(c.Param("id"))
	p, err := h.db.GetProduct(c.Request.Context(), tenantID, id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "product not found"})
		return
	}
	c.JSON(http.StatusOK, p)
}

func (h *Handler) SearchProducts(c *gin.Context) {
	tenantID := mustUUID(c.GetHeader("X-Tenant-ID"))
	q := c.Query("q")
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "10"))
	products, err := h.db.SearchProducts(c.Request.Context(), tenantID, q, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"products": products, "query": q})
}

func (h *Handler) GetStockLevel(c *gin.Context) {
	tenantID := mustUUID(c.GetHeader("X-Tenant-ID"))
	sku := c.Param("sku")
	product, err := h.db.GetStockLevel(c.Request.Context(), tenantID, sku)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "stock level not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"sku": product.SKU, "available": product.StockQuantity, "updated_at": product.UpdatedAt})
}

func (h *Handler) CreateCart(c *gin.Context) {
	tenantID := mustUUID(c.GetHeader("X-Tenant-ID"))
	var req struct {
		CustomerID string `json:"customer_id" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	cart := store.CartRow{
		ID:         uuid.New(),
		TenantID:   tenantID,
		CustomerID: mustUUID(req.CustomerID),
		ExpiresAt:  time.Now().Add(24 * time.Hour),
		CreatedAt:  time.Now(),
		UpdatedAt:  time.Now(),
	}
	if err := h.db.CreateCart(c.Request.Context(), cart); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, cart)
}

func (h *Handler) GetCart(c *gin.Context) {
	tenantID := mustUUID(c.GetHeader("X-Tenant-ID"))
	id := mustUUID(c.Param("id"))
	cart, err := h.db.GetCart(c.Request.Context(), tenantID, id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "cart not found"})
		return
	}
	items, _ := h.db.GetCartItems(c.Request.Context(), id)
	c.JSON(http.StatusOK, gin.H{"cart": cart, "items": items, "total": cartTotal(items)})
}

func (h *Handler) AddCartItem(c *gin.Context) {
	tenantID := mustUUID(c.GetHeader("X-Tenant-ID"))
	cartID := mustUUID(c.Param("id"))

	var req struct {
		ProductID string `json:"product_id" binding:"required"`
		Quantity  int    `json:"quantity" binding:"required,min=1"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Validate the cart belongs to this tenant. cart_sessions has no status
	// column (it is a shared chat-wizard session object, not an exclusively
	// commerce-engine-owned cart) — existence + tenant match is the only
	// guard this service can correctly express.
	if _, err := h.db.GetCart(c.Request.Context(), tenantID, cartID); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "cart not found"})
		return
	}

	product, err := h.db.GetProduct(c.Request.Context(), tenantID, mustUUID(req.ProductID))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "product not found"})
		return
	}

	item := store.CartItemRow{
		ID:            uuid.New(),
		CartSessionID: cartID,
		ProductID:     product.ID,
		ProductName:   product.Name,
		Quantity:      req.Quantity,
		UnitPrice:     product.Price,
		Currency:      product.Currency,
		CreatedAt:     time.Now(),
	}

	if err := h.db.AddCartItem(c.Request.Context(), item); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, gin.H{
		"id": item.ID, "cart_session_id": item.CartSessionID, "product_id": item.ProductID,
		"product_name": item.ProductName, "quantity": item.Quantity, "unit_price": item.UnitPrice,
		"currency": item.Currency, "total_price": item.TotalPrice(), "created_at": item.CreatedAt,
	})
}

func (h *Handler) RemoveCartItem(c *gin.Context) {
	tenantID := mustUUID(c.GetHeader("X-Tenant-ID"))
	cartID := mustUUID(c.Param("id"))
	itemID := mustUUID(c.Param("item_id"))

	if _, err := h.db.GetCart(c.Request.Context(), tenantID, cartID); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "cart not found"})
		return
	}
	if err := h.db.RemoveCartItem(c.Request.Context(), cartID, itemID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "removed"})
}

func (h *Handler) InitiateCheckout(c *gin.Context) {
	tenantID := mustUUID(c.GetHeader("X-Tenant-ID"))
	cartID := mustUUID(c.Param("id"))

	cart, err := h.db.GetCart(c.Request.Context(), tenantID, cartID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cart not found"})
		return
	}

	items, err := h.db.GetCartItems(c.Request.Context(), cartID)
	if err != nil || len(items) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cart is empty"})
		return
	}

	total := cartTotal(items)
	currency := items[0].Currency
	itemsJSON, err := json.Marshal(items)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// orderNumber matches the real server-side convention (server/routers/orderCrud.ts):
	// "ORD-" + base36 millisecond timestamp, uppercased.
	orderNumber := "ORD-" + strings.ToUpper(strconv.FormatInt(time.Now().UnixMilli(), 36))

	order := store.OrderRow{
		ID:          uuid.New(),
		TenantID:    tenantID,
		CustomerID:  cart.CustomerID,
		OrderNumber: orderNumber,
		// status/paymentStatus: left as the schema's own defaults convey
		// ("pending"/"unpaid") by setting them explicitly here rather than
		// relying on implicit DB defaults, so the returned row is accurate
		// immediately without a round-trip re-read.
		Status:        "pending",
		TotalAmount:   total,
		Currency:      currency,
		PaymentStatus: "unpaid",
		Items:         itemsJSON,
		CreatedAt:     time.Now(),
		UpdatedAt:     time.Now(),
	}

	if err := h.db.CreateOrder(c.Request.Context(), order); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	h.logger.Info("checkout initiated",
		zap.String("tenant_id", tenantID.String()),
		zap.String("order_id", order.ID.String()),
		zap.String("order_number", orderNumber),
		zap.Float64("total", total),
	)

	c.JSON(http.StatusCreated, gin.H{
		"order":       order,
		"items":       items,
		"next_step":   "payment",
		"payment_url": "/api/v1/payments/initiate",
	})
}

func (h *Handler) ListOrders(c *gin.Context) {
	tenantID := mustUUID(c.GetHeader("X-Tenant-ID"))
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "20"))
	offset, _ := strconv.Atoi(c.DefaultQuery("offset", "0"))
	orders, err := h.db.ListOrders(c.Request.Context(), tenantID, limit, offset)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"orders": orders, "count": len(orders)})
}

func (h *Handler) GetOrder(c *gin.Context) {
	tenantID := mustUUID(c.GetHeader("X-Tenant-ID"))
	id := mustUUID(c.Param("id"))
	order, err := h.db.GetOrder(c.Request.Context(), tenantID, id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "order not found"})
		return
	}
	c.JSON(http.StatusOK, order)
}

func (h *Handler) CancelOrder(c *gin.Context) {
	tenantID := mustUUID(c.GetHeader("X-Tenant-ID"))
	id := mustUUID(c.Param("id"))
	order, err := h.db.GetOrder(c.Request.Context(), tenantID, id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "order not found"})
		return
	}
	// "paid" was never a valid order status (payment is tracked separately
	// via paymentStatus) — this previously could never trip. Checking
	// paymentStatus directly is the real equivalent of the original intent:
	// don't let an order that has actually been paid for be cancelled.
	if order.PaymentStatus == "completed" || order.Status == "shipped" || order.Status == "delivered" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot cancel order in status: " + order.Status})
		return
	}
	h.db.UpdateOrderStatus(c.Request.Context(), id, "cancelled")
	c.JSON(http.StatusOK, gin.H{"status": "cancelled", "order_id": id})
}

func (h *Handler) ConfirmOrder(c *gin.Context) {
	tenantID := mustUUID(c.GetHeader("X-Tenant-ID"))
	id := mustUUID(c.Param("id"))
	if _, err := h.db.GetOrder(c.Request.Context(), tenantID, id); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "order not found"})
		return
	}
	h.db.UpdateOrderStatus(c.Request.Context(), id, "confirmed")
	c.JSON(http.StatusOK, gin.H{"status": "confirmed", "order_id": id})
}

func (h *Handler) SyncProduct(c *gin.Context) {
	var p store.ProductRow
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if p.ID == uuid.Nil {
		p.ID = uuid.New()
	}
	if p.Status == "" {
		p.Status = "active"
	}
	p.UpdatedAt = time.Now()
	if p.CreatedAt.IsZero() {
		p.CreatedAt = time.Now()
	}
	if err := h.db.UpsertProduct(c.Request.Context(), p); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "synced", "sku": p.SKU})
}

func (h *Handler) SyncStockLevel(c *gin.Context) {
	var req struct {
		TenantID  string `json:"tenant_id" binding:"required"`
		SKU       string `json:"sku" binding:"required"`
		Available int    `json:"available" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.db.UpsertStockLevel(c.Request.Context(), mustUUID(req.TenantID), req.SKU, req.Available); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "synced", "sku": req.SKU})
}

// EventEnvelope mirrors the Kafka event shape event-processor sends
// (rust/event-processor/src/main.rs's EventEnvelope). Only the QA-038
// internal-key-gated caller (event-processor) reaches this route.
type EventEnvelope struct {
	ID             string          `json:"id"`
	TenantID       string          `json:"tenant_id"`
	EventType      string          `json:"event_type"`
	IdempotencyKey string          `json:"idempotency_key"`
	Payload        json.RawMessage `json:"payload"`
}

// ProcessEvent handles commerce.* events routed here by event-processor.
// Unrecognized event types are acknowledged (200), not rejected, so a new
// event type added to the routing table upstream doesn't start failing
// deliveries here before this handler is updated to understand it.
func (h *Handler) ProcessEvent(c *gin.Context) {
	var env EventEnvelope
	if err := c.ShouldBindJSON(&env); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	h.logger.Info("commerce event received",
		zap.String("event_type", env.EventType),
		zap.String("tenant_id", env.TenantID),
		zap.String("idempotency_key", env.IdempotencyKey),
	)
	c.JSON(http.StatusOK, gin.H{"status": "accepted", "event_type": env.EventType})
}

func cartTotal(items []store.CartItemRow) float64 {
	var total float64
	for _, item := range items {
		total += item.TotalPrice()
	}
	return total
}

func mustUUID(s string) uuid.UUID {
	id, _ := uuid.Parse(s)
	return id
}
