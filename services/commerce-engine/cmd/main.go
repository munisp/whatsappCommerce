package main

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/whatsapp-commerce/commerce-engine/internal/config"
	"github.com/whatsapp-commerce/commerce-engine/internal/handler"
	"github.com/whatsapp-commerce/commerce-engine/internal/middleware"
	"github.com/whatsapp-commerce/commerce-engine/internal/store"
	"github.com/whatsapp-commerce/otelx"
	"go.uber.org/zap"
)

// newRouter is the real, single definition of the app's routing (which routes require the internal key,
// which don't — only /health). main() and the tests both call this, so a route mistakenly added to the
// wrong group is something the tests can actually catch, not just something a hand-duplicated test router
// would miss (see rust/ledger-bridge and rust/recon-worker's build_router for the same fix applied there).
func newRouter(cfg *config.Config, h *handler.Handler, logger *zap.Logger) *gin.Engine {
	r := gin.New()
	r.Use(gin.Recovery())

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok", "service": "commerce-engine", "otel_enabled": otelx.Status()})
	})

	protected := r.Group("/")
	protected.Use(middleware.InternalAuth(cfg, logger))

	// Products & Catalog (projection reads)
	protected.GET("/products", h.ListProducts)
	protected.GET("/products/:id", h.GetProduct)
	protected.GET("/products/search", h.SearchProducts)
	protected.GET("/inventory/:sku", h.GetStockLevel)

	// Cart
	protected.POST("/carts", h.CreateCart)
	protected.GET("/carts/:id", h.GetCart)
	protected.POST("/carts/:id/items", h.AddCartItem)
	protected.DELETE("/carts/:id/items/:item_id", h.RemoveCartItem)
	protected.POST("/carts/:id/checkout", h.InitiateCheckout)

	// Orders
	protected.GET("/orders", h.ListOrders)
	protected.GET("/orders/:id", h.GetOrder)
	protected.POST("/orders/:id/cancel", h.CancelOrder)
	protected.POST("/orders/:id/confirm", h.ConfirmOrder)

	// Internal: catalog projection sync (from Odoo events)
	protected.POST("/internal/sync/product", h.SyncProduct)
	protected.POST("/internal/sync/stock", h.SyncStockLevel)

	return r
}

func main() {
	cfg := config.Load()
	logger, _ := zap.NewProduction()
	defer logger.Sync()

	// === W35 otel ===
	otelShutdown, _ := otelx.Init(context.Background(), "commerce-engine")
	defer func() { _ = otelShutdown(context.Background()) }()
	// === END W35 otel ===

	db, err := store.NewPostgres(cfg.DatabaseURL)
	if err != nil {
		logger.Fatal("db connect failed", zap.Error(err))
	}

	h := handler.New(cfg, db, logger)
	r := newRouter(cfg, h, logger)

	srv := &http.Server{Addr: ":" + cfg.Port, Handler: otelx.Middleware("commerce-engine")(r)} // === W35 otel ===
	go func() {
		logger.Info("Commerce Engine starting", zap.String("port", cfg.Port))
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatal("server failed", zap.Error(err))
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}

