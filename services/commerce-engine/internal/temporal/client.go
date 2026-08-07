package temporal

// client.go — Temporal workflow client for the Commerce Engine.
//
// The Commerce Engine uses Temporal to orchestrate durable order fulfillment
// workflows. Each checkout triggers an OrderFulfillmentWorkflow that:
//   1. Confirms payment via the Payment Orchestrator
//   2. Reserves inventory atomically
//   3. Syncs the order to Odoo ERP
//   4. Sends WhatsApp order confirmation to the buyer
//
// When TEMPORAL_ADDRESS is not set, the client falls back to a no-op that
// records the workflow intent in PostgreSQL for later replay.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"

	"go.uber.org/zap"
)

// ─── Configuration ────────────────────────────────────────────────────────────

type Config struct {
	Address   string // e.g. temporal:7233
	Namespace string // e.g. default
	TaskQueue string // e.g. whatsapp-commerce
	// Platform API for fallback recording
	PlatformAPIURL string
	PlatformAPIKey string
}

func ConfigFromEnv() Config {
	return Config{
		Address:        os.Getenv("TEMPORAL_ADDRESS"),
		Namespace:      getEnvOrDefault("TEMPORAL_NAMESPACE", "default"),
		TaskQueue:      getEnvOrDefault("TEMPORAL_TASK_QUEUE", "whatsapp-commerce"),
		PlatformAPIURL: getEnvOrDefault("PLATFORM_API_URL", "http://localhost:3000"),
		PlatformAPIKey: os.Getenv("PLATFORM_API_KEY"),
	}
}

func getEnvOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// ─── Workflow input types ─────────────────────────────────────────────────────

type OrderItem struct {
	ProductID string  `json:"productId"`
	Quantity  int     `json:"quantity"`
	Price     float64 `json:"price"`
}

type OrderFulfillmentInput struct {
	OrderID       string      `json:"orderId"`
	TenantID      string      `json:"tenantId"`
	CustomerID    string      `json:"customerId"`
	Items         []OrderItem `json:"items"`
	TotalAmount   float64     `json:"totalAmount"`
	WAPhoneNumber string      `json:"waPhoneNumber"`
}

type WorkflowResult struct {
	WorkflowID string `json:"workflowId"`
	RunID      string `json:"runId"`
	Started    bool   `json:"started"`
	Error      string `json:"error,omitempty"`
}

// ─── Client ───────────────────────────────────────────────────────────────────

type Client struct {
	cfg    Config
	http   *http.Client
	logger *zap.Logger
}

func NewClient(cfg Config, logger *zap.Logger) *Client {
	return &Client{
		cfg:    cfg,
		http:   &http.Client{Timeout: 10 * time.Second},
		logger: logger,
	}
}

// StartOrderFulfillment starts a Temporal OrderFulfillmentWorkflow.
// Falls back to recording the intent via the platform API when Temporal is unavailable.
func (c *Client) StartOrderFulfillment(ctx context.Context, input OrderFulfillmentInput) (WorkflowResult, error) {
	workflowID := fmt.Sprintf("order-fulfillment-%s", input.OrderID)
	// Try Temporal gRPC via the platform API temporal bridge
	if c.cfg.Address != "" {
		result, err := c.startViaTemporalBridge(ctx, "OrderFulfillmentWorkflow", workflowID, input)
		if err == nil {
			c.logger.Info("temporal.workflow.started",
				zap.String("workflow_id", workflowID),
				zap.String("run_id", result.RunID),
				zap.String("order_id", input.OrderID),
			)
			return result, nil
		}
		c.logger.Warn("temporal.workflow.start_failed",
			zap.String("workflow_id", workflowID),
			zap.Error(err),
		)
	}
	// Fallback: record via platform API
	return c.recordWorkflowFallback(ctx, "OrderFulfillmentWorkflow", workflowID, input.TenantID, input.OrderID, input)
}

// startViaTemporalBridge calls the platform's /api/trpc/temporal.startWorkflow endpoint.
// The platform Node.js server has the @temporalio/client and acts as the Temporal bridge.
func (c *Client) startViaTemporalBridge(
	ctx context.Context,
	workflowType string,
	workflowID string,
	input interface{},
) (WorkflowResult, error) {
	payload := map[string]interface{}{
		"json": map[string]interface{}{
			"workflowType": workflowType,
			"workflowId":   workflowID,
			"input":        input,
		},
	}
	b, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, "POST",
		c.cfg.PlatformAPIURL+"/api/trpc/temporal.startWorkflow",
		bytes.NewReader(b),
	)
	if err != nil {
		return WorkflowResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.cfg.PlatformAPIKey != "" {
		req.Header.Set("X-Internal-Token", c.cfg.PlatformAPIKey)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return WorkflowResult{}, fmt.Errorf("temporal bridge unreachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return WorkflowResult{}, fmt.Errorf("temporal bridge returned %d", resp.StatusCode)
	}
	var result struct {
		Result struct {
			Data WorkflowResult `json:"data"`
		} `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return WorkflowResult{}, err
	}
	return result.Result.Data, nil
}

// recordWorkflowFallback persists the workflow intent to the DB via the platform API.
func (c *Client) recordWorkflowFallback(
	ctx context.Context,
	workflowType string,
	workflowID string,
	tenantID string,
	entityID string,
	input interface{},
) (WorkflowResult, error) {
	syntheticRunID := fmt.Sprintf("local-%d", time.Now().UnixNano())
	payload := map[string]interface{}{
		"json": map[string]interface{}{
			"workflowId":   workflowID,
			"runId":        syntheticRunID,
			"workflowType": workflowType,
			"tenantId":     tenantID,
			"entityId":     entityID,
			"status":       "running",
			"input":        input,
		},
	}
	b, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, "POST",
		c.cfg.PlatformAPIURL+"/api/trpc/temporal.recordRun",
		bytes.NewReader(b),
	)
	if err != nil {
		return WorkflowResult{WorkflowID: workflowID, RunID: syntheticRunID, Started: false, Error: err.Error()}, nil
	}
	req.Header.Set("Content-Type", "application/json")
	if c.cfg.PlatformAPIKey != "" {
		req.Header.Set("X-Internal-Token", c.cfg.PlatformAPIKey)
	}
	resp, _ := c.http.Do(req)
	if resp != nil {
		defer resp.Body.Close()
	}
	c.logger.Info("temporal.workflow.fallback_recorded",
		zap.String("workflow_id", workflowID),
		zap.String("run_id", syntheticRunID),
	)
	return WorkflowResult{WorkflowID: workflowID, RunID: syntheticRunID, Started: false, Error: "temporal_unavailable"}, nil
}

// Health checks Temporal connectivity via the platform bridge.
func (c *Client) Health(ctx context.Context) (bool, int64) {
	if c.cfg.Address == "" {
		return false, 0
	}
	start := time.Now()
	req, _ := http.NewRequestWithContext(ctx, "GET",
		c.cfg.PlatformAPIURL+"/api/health/temporal",
		nil,
	)
	resp, err := c.http.Do(req)
	latency := time.Since(start).Milliseconds()
	if err != nil || resp.StatusCode >= 400 {
		return false, latency
	}
	return true, latency
}
