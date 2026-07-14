package store

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	_ "github.com/lib/pq"
)

type TenantRow struct {
	ID            uuid.UUID `db:"id"`
	Slug          string    `db:"slug"`
	Name          string    `db:"name"`
	WebhookSecret string    `db:"webhook_secret"`
}

type DB struct {
	db *sqlx.DB
}

func NewPostgres(dsn string) (*DB, error) {
	db, err := sqlx.Connect("postgres", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(10)
	db.SetConnMaxLifetime(5 * time.Minute)
	return &DB{db: db}, nil
}

func (d *DB) GetTenantBySlug(ctx context.Context, slug string) (*TenantRow, error) {
	var t TenantRow
	err := d.db.GetContext(ctx, &t, `SELECT id, slug, name, webhook_secret FROM tenants WHERE slug=$1 AND is_active=true`, slug)
	return &t, err
}

func (d *DB) IsProcessed(ctx context.Context, key string) bool {
	var count int
	d.db.QueryRowContext(ctx, `SELECT COUNT(1) FROM processed_events WHERE idempotency_key=$1`, key).Scan(&count)
	return count > 0
}

func (d *DB) MarkProcessed(ctx context.Context, key string, ttl time.Duration) {
	d.db.ExecContext(ctx,
		`INSERT INTO processed_events (idempotency_key, expires_at) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		key, time.Now().Add(ttl),
	)
}

