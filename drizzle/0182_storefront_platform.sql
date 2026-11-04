-- Storefront platform: templates with draft/published design, per-store customer accounts,
-- saved addresses, password recovery and newsletter sign-ups. All additive.
ALTER TABLE storefronts ADD COLUMN IF NOT EXISTS template_id varchar(40);
ALTER TABLE storefronts ADD COLUMN IF NOT EXISTS draft_config jsonb;
ALTER TABLE storefronts ADD COLUMN IF NOT EXISTS published_config jsonb;
ALTER TABLE storefronts ADD COLUMN IF NOT EXISTS draft_updated_at timestamp;
ALTER TABLE storefronts ADD COLUMN IF NOT EXISTS published_at timestamp;

CREATE TABLE IF NOT EXISTS store_accounts (
  id varchar(36) PRIMARY KEY,
  tenant_id varchar(36) NOT NULL,
  email varchar(320) NOT NULL,
  name varchar(255) NOT NULL,
  phone varchar(30),
  password_hash varchar(255) NOT NULL,
  marketing_opt_in boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS store_accounts_tenant_email_uidx ON store_accounts (tenant_id, lower(email));

CREATE TABLE IF NOT EXISTS store_account_addresses (
  id varchar(36) PRIMARY KEY,
  tenant_id varchar(36) NOT NULL,
  account_id varchar(36) NOT NULL REFERENCES store_accounts(id) ON DELETE CASCADE,
  label varchar(60),
  recipient varchar(255) NOT NULL,
  phone varchar(30) NOT NULL,
  line1 varchar(255) NOT NULL,
  city varchar(120) NOT NULL,
  state varchar(120),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS store_account_addresses_account_idx ON store_account_addresses (tenant_id, account_id);

CREATE TABLE IF NOT EXISTS store_password_resets (
  token_hash varchar(64) PRIMARY KEY,
  tenant_id varchar(36) NOT NULL,
  account_id varchar(36) NOT NULL REFERENCES store_accounts(id) ON DELETE CASCADE,
  expires_at timestamp NOT NULL,
  used_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS store_newsletter_subscribers (
  id varchar(36) PRIMARY KEY,
  tenant_id varchar(36) NOT NULL,
  email varchar(320) NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS store_newsletter_tenant_email_uidx ON store_newsletter_subscribers (tenant_id, lower(email));
