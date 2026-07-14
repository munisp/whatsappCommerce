package handler

import (
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/whatsapp-commerce/commerce-engine/internal/config"
	"github.com/whatsapp-commerce/commerce-engine/internal/store"
	"go.uber.org/zap"
)

type Handler struct {
	cfg    *config.Config
	db     *store.DB
	logger *zap.Logger
}

func New(cfg *config.Config, db *store.DB, logger *zap.Logger) *Handler {
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
	stock, err := h.db.GetStockLevel(c.Request.Context(), tenantID, sku)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "stock level not found"})
		return
	}
	c.JSON(http.StatusOK, stock)
}

func (h *Handler) CreateCart(c *gin.Context) {
	tenantID := mustUUID(c.GetHeader("X-Tenant-ID"))
	var req struct {
		CustomerID string `json:"customer_id" binding:"required"`
		Currency   string `json:"currency"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	currency := req.Currency
	if currency == "" {
		currency = "USD"
	}
	cart := store.CartRow{
		ID:         uuid.New(),
		TenantID:   tenantID,
		CustomerID: mustUUID(req.CustomerID),
		Status:     "active",
		Currency:   currency,
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
	c.JSON(http.StatusOK, gin.H{"cart": cart, "items": items})
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

	// Validate cart belongs to tenant
	cart, err := h.db.GetCart(c.Request.Context(), tenantID, cartID)
	if err != nil || cart.Status != "active" {
		c.JSON(http.StatusNotFound, gin.H{"error": "cart not found or not active"})
		return
	}

	product, err := h.db.GetProduct(c.Request.Context(), tenantID, mustUUID(req.ProductID))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "product not found"})
		return
	}

	item := store.CartItemRow{
		ID:          uuid.New(),
		CartID:      cartID,
		ProductID:   product.ID,
		SKU:         product.SKU,
		ProductName: product.Name,
		Quantity:    req.Quantity,
		UnitPrice:   product.Price,
		TotalPrice:  product.Price * float64(req.Quantity),
	}

	if err := h.db.AddCartItem(c.Request.Context(), item); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, item)
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
	if err != nil || cart.Status != "active" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cart not found or not active"})
		return
	}

	items, err := h.db.GetCartItems(c.Request.Context(), cartID)
	if err != nil || len(items) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cart is empty"})
		return
	}

	// Calculate total
	var total float64
	for _, item := range items {
		total += item.TotalPrice
	}

	// Create order (pending payment)
	order := store.OrderRow{
		ID:         uuid.New(),
		TenantID:   tenantID,
		CustomerID: cart.CustomerID,
		CartID:     cartID,
		Status:     "pending",
		Currency:   cart.Currency,
		TotalAmount: total,
		WorkflowID: uuid.New().String(), // Temporal workflow ID placeholder
		CreatedAt:  time.Now(),
		UpdatedAt:  time.Now(),
	}

	if err := h.db.CreateOrder(c.Request.Context(), order); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Update cart status
	h.db.UpdateCartStatus(c.Request.Context(), cartID, "checkout")

	h.logger.Info("checkout initiated",
		zap.String("tenant_id", tenantID.String()),
		zap.String("order_id", order.ID.String()),
		zap.Float64("total", total),
	)

	c.JSON(http.StatusCreated, gin.H{
		"order":      order,
		"items":      items,
		"next_step":  "payment",
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
	if order.Status == "paid" || order.Status == "shipped" || order.Status == "delivered" {
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
	var s store.StockRow
	if err := c.ShouldBindJSON(&s); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	s.UpdatedAt = time.Now()
	if err := h.db.UpsertStockLevel(c.Request.Context(), s); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "synced", "sku": s.SKU})
}

func mustUUID(s string) uuid.UUID {
	id, _ := uuid.Parse(s)
	return id
}

