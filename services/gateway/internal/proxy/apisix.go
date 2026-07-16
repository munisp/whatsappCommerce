// apisix.go — APISIX Admin API client
// Manages routes, upstreams, and plugins programmatically via APISIX Admin API v3.
package proxy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// APISIXClient manages APISIX resources via the Admin API.
type APISIXClient struct {
	adminURL string
	adminKey string
	http     *http.Client
}

// NewAPISIXClient creates a new APISIX Admin API client.
func NewAPISIXClient(adminURL, adminKey string) *APISIXClient {
	return &APISIXClient{
		adminURL: adminURL,
		adminKey: adminKey,
		http: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// APISIXRoute represents an APISIX route definition.
type APISIXRoute struct {
	ID         string                 `json:"id,omitempty"`
	Name       string                 `json:"name"`
	URI        string                 `json:"uri"`
	Methods    []string               `json:"methods,omitempty"`
	UpstreamID string                 `json:"upstream_id,omitempty"`
	Upstream   *APISIXUpstream        `json:"upstream,omitempty"`
	Plugins    map[string]interface{} `json:"plugins,omitempty"`
	Status     int                    `json:"status"` // 1=enabled, 0=disabled
}

// APISIXUpstream represents an APISIX upstream definition.
type APISIXUpstream struct {
	ID    string                 `json:"id,omitempty"`
	Name  string                 `json:"name"`
	Type  string                 `json:"type"` // roundrobin, chash, ewma
	Nodes map[string]int         `json:"nodes"` // host:port -> weight
	Checks *APISIXHealthCheck    `json:"checks,omitempty"`
}

// APISIXHealthCheck configures active/passive health checks on an upstream.
type APISIXHealthCheck struct {
	Active *APISIXActiveCheck `json:"active,omitempty"`
}

type APISIXActiveCheck struct {
	Type       string              `json:"type"` // http, https, tcp
	HTTPPath   string              `json:"http_path"`
	Interval   int                 `json:"interval"`
	Timeout    int                 `json:"timeout"`
	Concurrency int                `json:"concurrency"`
	Healthy    APISIXHealthyConfig `json:"healthy"`
	Unhealthy  APISIXHealthyConfig `json:"unhealthy"`
}

type APISIXHealthyConfig struct {
	Interval  int   `json:"interval,omitempty"`
	Successes int   `json:"successes,omitempty"`
	HTTPCodes []int `json:"http_codes,omitempty"`
	Failures  int   `json:"failures,omitempty"`
}

func (c *APISIXClient) do(method, path string, body interface{}) ([]byte, int, error) {
	var reqBody io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, 0, err
		}
		reqBody = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, c.adminURL+path, reqBody)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("X-API-KEY", c.adminKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	return respBody, resp.StatusCode, nil
}

// UpsertRoute creates or updates a route.
func (c *APISIXClient) UpsertRoute(route APISIXRoute) error {
	_, status, err := c.do("PUT", fmt.Sprintf("/apisix/admin/routes/%s", route.ID), route)
	if err != nil {
		return fmt.Errorf("upsert route: %w", err)
	}
	if status >= 400 {
		return fmt.Errorf("upsert route failed: status %d", status)
	}
	return nil
}

// DeleteRoute removes a route by ID.
func (c *APISIXClient) DeleteRoute(id string) error {
	_, status, err := c.do("DELETE", fmt.Sprintf("/apisix/admin/routes/%s", id), nil)
	if err != nil {
		return fmt.Errorf("delete route: %w", err)
	}
	if status >= 400 && status != 404 {
		return fmt.Errorf("delete route failed: status %d", status)
	}
	return nil
}

// UpsertUpstream creates or updates an upstream.
func (c *APISIXClient) UpsertUpstream(upstream APISIXUpstream) error {
	_, status, err := c.do("PUT", fmt.Sprintf("/apisix/admin/upstreams/%s", upstream.ID), upstream)
	if err != nil {
		return fmt.Errorf("upsert upstream: %w", err)
	}
	if status >= 400 {
		return fmt.Errorf("upsert upstream failed: status %d", status)
	}
	return nil
}

// ListRoutes returns all configured routes.
func (c *APISIXClient) ListRoutes() ([]APISIXRoute, error) {
	body, status, err := c.do("GET", "/apisix/admin/routes", nil)
	if err != nil {
		return nil, fmt.Errorf("list routes: %w", err)
	}
	if status >= 400 {
		return nil, fmt.Errorf("list routes failed: status %d", status)
	}
	var result struct {
		List []struct {
			Value APISIXRoute `json:"value"`
		} `json:"list"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}
	routes := make([]APISIXRoute, len(result.List))
	for i, item := range result.List {
		routes[i] = item.Value
	}
	return routes, nil
}

// Health checks if the APISIX Admin API is reachable.
func (c *APISIXClient) Health() (bool, int64, error) {
	start := time.Now()
	_, status, err := c.do("GET", "/apisix/admin/routes", nil)
	latency := time.Since(start).Milliseconds()
	if err != nil {
		return false, latency, err
	}
	return status < 400, latency, nil
}

// BootstrapWACommerceRoutes registers the standard WhatsApp Commerce routes in APISIX.
// Call this on gateway startup when APISIX_ADMIN_KEY is set.
func BootstrapWACommerceRoutes(client *APISIXClient, services map[string]string) error {
	upstreams := []APISIXUpstream{
		{ID: "upstream-node", Name: "node-server", Type: "roundrobin",
			Nodes: map[string]int{services["node"]: 1},
			Checks: &APISIXHealthCheck{Active: &APISIXActiveCheck{
				Type: "http", HTTPPath: "/api/health", Interval: 10, Timeout: 3, Concurrency: 2,
				Healthy: APISIXHealthyConfig{Successes: 2, HTTPCodes: []int{200}},
				Unhealthy: APISIXHealthyConfig{Failures: 2},
			}}},
		{ID: "upstream-hermes", Name: "hermes-skills", Type: "roundrobin",
			Nodes: map[string]int{services["hermes"]: 1}},
	}
	for _, u := range upstreams {
		if err := client.UpsertUpstream(u); err != nil {
			return fmt.Errorf("bootstrap upstream %s: %w", u.ID, err)
		}
	}

	routes := []APISIXRoute{
		{ID: "route-api", Name: "node-api", URI: "/api/*", Methods: []string{"GET", "POST", "PUT", "DELETE", "PATCH"},
			UpstreamID: "upstream-node", Status: 1,
			Plugins: map[string]interface{}{
				"limit-req": map[string]interface{}{"rate": 100, "burst": 50, "key": "remote_addr"},
				"cors":       map[string]interface{}{"allow_origins": "*"},
			}},
		{ID: "route-hermes", Name: "hermes-api", URI: "/hermes/*", Methods: []string{"GET", "POST"},
			UpstreamID: "upstream-hermes", Status: 1},
	}
	for _, r := range routes {
		if err := client.UpsertRoute(r); err != nil {
			return fmt.Errorf("bootstrap route %s: %w", r.ID, err)
		}
	}
	return nil
}
