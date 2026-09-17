// === W45 go-rust-services ===
// approvals.go — durable pending-approval store for PO drafts (MSG-15).
//
// The previous implementation kept `pendingApprovals sync.Map` in process
// memory: every restart silently dropped every outstanding merchant approval
// and nothing ever expired or reminded. This file replaces it with a
// Redis-backed store:
//
//   hermes:approval:{token}        STRING  JSON PODraftPayload, SETEX ttl
//   hermes:approvals:expiry        ZSET    member=token score=expiresAtUnix
//   hermes:approvals:reminder      ZSET    member=token score=nextReminderUnix
//
// plus a reminder/expiry sweep (StartApprovalSweep) that re-sends the approval
// template to the merchant before expiry and, once expired, removes the
// approval and notifies the platform with decision "expired" so the PO draft
// is never left parked forever.
//
// Redis is REQUIRED in production (fail-closed at startup). In development a
// plain map+mutex fallback is allowed but is loudly logged and reported via
// Backend() so it is never silent.

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// ApprovalStore is the pending-approval persistence contract.
type ApprovalStore interface {
	// Save persists a pending approval with the given TTL.
	Save(ctx context.Context, po PODraftPayload, ttl time.Duration) error
	// Get loads a pending approval by token. ErrApprovalNotFound when absent.
	Get(ctx context.Context, token string) (PODraftPayload, error)
	// Delete removes a pending approval (decision reached or expired).
	Delete(ctx context.Context, token string) error
	// DueReminders returns tokens whose reminder is due at/before `now`.
	DueReminders(ctx context.Context, now time.Time) ([]string, error)
	// MarkReminded schedules the next reminder for token.
	MarkReminded(ctx context.Context, token string, next time.Time) error
	// Expired returns tokens whose expiry passed at/before `now`.
	Expired(ctx context.Context, now time.Time) ([]string, error)
	// Backend reports "redis" or "memory" for health/logging honesty.
	Backend() string
}

var ErrApprovalNotFound = errors.New("approval token not found")

const (
	approvalKeyPrefix   = "hermes:approval:"
	approvalExpiryZSet  = "hermes:approvals:expiry"
	approvalReminderZet = "hermes:approvals:reminder"
)

// ─── Redis-backed store ───────────────────────────────────────────────────────

type redisApprovalStore struct {
	client *redis.Client
}

func newRedisApprovalStore(redisURL string) (*redisApprovalStore, error) {
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, fmt.Errorf("parse REDIS_URL: %w", err)
	}
	client := redis.NewClient(opt)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("redis ping: %w", err)
	}
	return &redisApprovalStore{client: client}, nil
}

func (s *redisApprovalStore) Save(ctx context.Context, po PODraftPayload, ttl time.Duration) error {
	body, err := json.Marshal(po)
	if err != nil {
		return fmt.Errorf("marshal approval: %w", err)
	}
	expiresAt := time.Now().Add(ttl)
	pipe := s.client.TxPipeline()
	pipe.Set(ctx, approvalKeyPrefix+po.ApprovalToken, body, ttl)
	pipe.ZAdd(ctx, approvalExpiryZSet, redis.Z{Score: float64(expiresAt.Unix()), Member: po.ApprovalToken})
	_, err = pipe.Exec(ctx)
	return err
}

func (s *redisApprovalStore) Get(ctx context.Context, token string) (PODraftPayload, error) {
	var po PODraftPayload
	raw, err := s.client.Get(ctx, approvalKeyPrefix+token).Bytes()
	if errors.Is(err, redis.Nil) {
		return po, ErrApprovalNotFound
	}
	if err != nil {
		return po, err
	}
	if err := json.Unmarshal(raw, &po); err != nil {
		return po, fmt.Errorf("unmarshal approval: %w", err)
	}
	return po, nil
}

func (s *redisApprovalStore) Delete(ctx context.Context, token string) error {
	pipe := s.client.TxPipeline()
	pipe.Del(ctx, approvalKeyPrefix+token)
	pipe.ZRem(ctx, approvalExpiryZSet, token)
	pipe.ZRem(ctx, approvalReminderZet, token)
	_, err := pipe.Exec(ctx)
	return err
}

func (s *redisApprovalStore) DueReminders(ctx context.Context, now time.Time) ([]string, error) {
	return s.client.ZRangeByScore(ctx, approvalReminderZet, &redis.ZRangeBy{
		Min: "-inf", Max: strconv.FormatInt(now.Unix(), 10),
	}).Result()
}

func (s *redisApprovalStore) MarkReminded(ctx context.Context, token string, next time.Time) error {
	return s.client.ZAdd(ctx, approvalReminderZet, redis.Z{Score: float64(next.Unix()), Member: token}).Err()
}

func (s *redisApprovalStore) Expired(ctx context.Context, now time.Time) ([]string, error) {
	return s.client.ZRangeByScore(ctx, approvalExpiryZSet, &redis.ZRangeBy{
		Min: "-inf", Max: strconv.FormatInt(now.Unix(), 10),
	}).Result()
}

func (s *redisApprovalStore) Backend() string { return "redis" }

// ─── Development fallback (map + mutex — NOT the old bare sync.Map) ──────────

type memoryApprovalStore struct {
	mu        sync.Mutex
	items     map[string]memoryApproval
	reminders map[string]time.Time
}

type memoryApproval struct {
	po        PODraftPayload
	expiresAt time.Time
}

func newMemoryApprovalStore() *memoryApprovalStore {
	return &memoryApprovalStore{
		items:     make(map[string]memoryApproval),
		reminders: make(map[string]time.Time),
	}
}

func (s *memoryApprovalStore) Save(_ context.Context, po PODraftPayload, ttl time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.items[po.ApprovalToken] = memoryApproval{po: po, expiresAt: time.Now().Add(ttl)}
	return nil
}

func (s *memoryApprovalStore) Get(_ context.Context, token string) (PODraftPayload, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.items[token]
	if !ok || time.Now().After(item.expiresAt) {
		return PODraftPayload{}, ErrApprovalNotFound
	}
	return item.po, nil
}

func (s *memoryApprovalStore) Delete(_ context.Context, token string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.items, token)
	delete(s.reminders, token)
	return nil
}

func (s *memoryApprovalStore) DueReminders(_ context.Context, now time.Time) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for token, at := range s.reminders {
		if !at.After(now) {
			if item, ok := s.items[token]; ok && now.Before(item.expiresAt) {
				out = append(out, token)
			}
		}
	}
	return out, nil
}

func (s *memoryApprovalStore) MarkReminded(_ context.Context, token string, next time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reminders[token] = next
	return nil
}

func (s *memoryApprovalStore) Expired(_ context.Context, now time.Time) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for token, item := range s.items {
		if !now.Before(item.expiresAt) {
			out = append(out, token)
		}
	}
	return out, nil
}

func (s *memoryApprovalStore) Backend() string { return "memory" }

// ─── Constructor ─────────────────────────────────────────────────────────────

// NewApprovalStore builds the store. Redis is mandatory in production;
// development may fall back to memory with a loud warning.
func NewApprovalStore(cfg Config, logger *slog.Logger) (ApprovalStore, error) {
	if cfg.RedisURL != "" {
		store, err := newRedisApprovalStore(cfg.RedisURL)
		if err != nil {
			return nil, err
		}
		logger.Info("approval store: durable Redis backend",
			"ttl_minutes", cfg.ApprovalTTLMinutes)
		return store, nil
	}
	if cfg.IsProduction() {
		return nil, errors.New("REDIS_URL is required in production — pending approvals must survive restarts (MSG-15)")
	}
	logger.Warn("REDIS_URL not set — pending approvals use IN-MEMORY store (dev only, lost on restart)")
	return newMemoryApprovalStore(), nil
}

// ─── Reminder / expiry sweep ──────────────────────────────────────────────────

// StartApprovalSweep runs the reminder + expiry sweep until ctx is cancelled.
// Reminders re-send the approval template to the merchant; expired approvals
// are deleted and the platform is notified with decision "expired".
func (ep *EventProcessor) StartApprovalSweep(ctx context.Context) {
	interval := time.Duration(ep.cfg.ApprovalReminderIntervalSeconds) * time.Second
	if interval <= 0 {
		interval = time.Hour
	}
	// Tick at least 4x per reminder interval so reminders/expiry are timely,
	// capped at once a minute to keep the loop cheap.
	tick := interval / 4
	if tick > time.Minute {
		tick = time.Minute
	}
	if tick <= 0 {
		tick = time.Minute
	}
	ticker := time.NewTicker(tick)
	defer ticker.Stop()
	ep.logger.Info("approval sweep started", "tick", tick.String(), "reminder_interval", interval.String())
	for {
		select {
		case <-ctx.Done():
			ep.logger.Info("approval sweep stopped")
			return
		case <-ticker.C:
			ep.runApprovalSweep(ctx, interval)
		}
	}
}

func (ep *EventProcessor) runApprovalSweep(ctx context.Context, reminderInterval time.Duration) {
	now := time.Now()

	// 1. Reminders due → re-send the approval template and reschedule.
	due, err := ep.approvals.DueReminders(ctx, now)
	if err != nil {
		ep.logger.Error("approval sweep: due reminders query failed", "error", err)
	} else {
		for _, token := range due {
			po, err := ep.approvals.Get(ctx, token)
			if err != nil {
				_ = ep.approvals.MarkReminded(ctx, token, now.Add(reminderInterval))
				continue
			}
			if err := ep.waSender.SendApprovalRequest(ctx, po); err != nil {
				ep.logger.Error("approval reminder send failed", "po_id", po.POID, "error", err)
				continue // retry next tick
			}
			ep.logger.Info("approval reminder sent", "po_id", po.POID, "token", token)
			_ = ep.approvals.MarkReminded(ctx, token, now.Add(reminderInterval))
		}
	}

	// 2. Expired approvals → delete + notify platform (decision "expired").
	expired, err := ep.approvals.Expired(ctx, now)
	if err != nil {
		ep.logger.Error("approval sweep: expiry query failed", "error", err)
		return
	}
	for _, token := range expired {
		po, err := ep.approvals.Get(ctx, token)
		if err != nil {
			_ = ep.approvals.Delete(ctx, token)
			continue
		}
		if err := ep.approvals.Delete(ctx, token); err != nil {
			ep.logger.Error("approval sweep: delete expired failed", "token", token, "error", err)
			continue
		}
		ep.logger.Info("approval expired", "po_id", po.POID, "token", token)
		if err := ep.platform.NotifyPODecision(ctx, ApprovalReply{
			ApprovalToken: token,
			Decision:      "expired",
			MerchantPhone: po.MerchantPhone,
		}); err != nil {
			ep.logger.Error("approval expiry notify failed", "po_id", po.POID, "error", err)
		}
	}
}
