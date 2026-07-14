package handler

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/whatsapp-commerce/conversation-orchestrator/internal/config"
	"github.com/whatsapp-commerce/conversation-orchestrator/internal/orchestrator"
	"github.com/whatsapp-commerce/conversation-orchestrator/internal/store"
	"go.uber.org/zap"
)

type Handler struct {
	cfg   *config.Config
	orch  *orchestrator.Orchestrator
	db    *store.DB
	logger *zap.Logger
}

func New(cfg *config.Config, orch *orchestrator.Orchestrator, db *store.DB, logger *zap.Logger) *Handler {
	return &Handler{cfg: cfg, orch: orch, db: db, logger: logger}
}

func (h *Handler) ProcessInboundMessage(c *gin.Context) {
	var msg orchestrator.InboundMessage
	if err := c.ShouldBindJSON(&msg); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.orch.ProcessMessage(c.Request.Context(), msg); err != nil {
		h.logger.Error("process message failed", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "processing failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "processed"})
}

func (h *Handler) ProcessEvent(c *gin.Context) {
	var event map[string]interface{}
	if err := c.ShouldBindJSON(&event); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	// Route events based on type
	eventType, _ := event["event_type"].(string)
	h.logger.Info("processing event", zap.String("type", eventType))
	c.JSON(http.StatusOK, gin.H{"status": "accepted", "event_type": eventType})
}

func (h *Handler) ListConversations(c *gin.Context) {
	tenantID := mustUUID(c.GetHeader("X-Tenant-ID"))
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))
	offset, _ := strconv.Atoi(c.DefaultQuery("offset", "0"))

	convs, err := h.db.ListConversations(c.Request.Context(), tenantID, limit, offset)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"conversations": convs, "count": len(convs)})
}

func (h *Handler) GetConversation(c *gin.Context) {
	tenantID := mustUUID(c.GetHeader("X-Tenant-ID"))
	convID := mustUUID(c.Param("id"))

	conv, err := h.db.GetConversation(c.Request.Context(), tenantID, convID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "conversation not found"})
		return
	}
	c.JSON(http.StatusOK, conv)
}

func (h *Handler) GetMessages(c *gin.Context) {
	tenantID := mustUUID(c.GetHeader("X-Tenant-ID"))
	convID := mustUUID(c.Param("id"))
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))

	msgs, err := h.db.GetMessages(c.Request.Context(), tenantID, convID, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"messages": msgs, "count": len(msgs)})
}

func (h *Handler) RequestHandoff(c *gin.Context) {
	tenantID := mustUUID(c.GetHeader("X-Tenant-ID"))
	convID := mustUUID(c.Param("id"))

	var req struct {
		Reason  string `json:"reason"`
		Summary string `json:"summary"`
	}
	c.ShouldBindJSON(&req)

	if err := h.db.UpdateConversationState(c.Request.Context(), convID, "handed_off"); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	h.logger.Info("handoff requested",
		zap.String("tenant_id", tenantID.String()),
		zap.String("conv_id", convID.String()),
		zap.String("reason", req.Reason),
	)
	c.JSON(http.StatusOK, gin.H{"status": "handed_off", "conversation_id": convID, "at": time.Now()})
}

func (h *Handler) ResolveConversation(c *gin.Context) {
	tenantID := mustUUID(c.GetHeader("X-Tenant-ID"))
	convID := mustUUID(c.Param("id"))

	if err := h.db.UpdateConversationState(c.Request.Context(), convID, "resolved"); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	_ = json.NewEncoder(nil) // suppress unused import
	h.logger.Info("conversation resolved", zap.String("tenant_id", tenantID.String()), zap.String("conv_id", convID.String()))
	c.JSON(http.StatusOK, gin.H{"status": "resolved", "conversation_id": convID, "at": time.Now()})
}

func mustUUID(s string) uuid.UUID {
	id, err := uuid.Parse(s)
	if err != nil {
		return uuid.Nil
	}
	return id
}

