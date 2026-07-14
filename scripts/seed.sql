-- ============================================================
-- WhatsApp Commerce Platform — PostgreSQL Seed Data (v2)
-- ============================================================

-- Tenants (already inserted, skip)

-- Customers (correct column: whatsappPhone not phone, waId not waId)
INSERT INTO customers (id, "tenantId", "whatsappPhone", name, email, language, "totalOrders", "totalSpent") VALUES
('cust-001', 'tenant-001', '+2348012345678', 'Adaeze Okonkwo', 'adaeze@example.com', 'en', 5, 47500.00),
('cust-002', 'tenant-001', '+2348023456789', 'Chukwudi Eze', 'chukwudi@example.com', 'en', 3, 28900.00),
('cust-003', 'tenant-002', '+254712345678', 'Wanjiku Kamau', 'wanjiku@example.com', 'en', 8, 156000.00),
('cust-004', 'tenant-002', '+254723456789', 'Omondi Otieno', 'omondi@example.com', 'en', 2, 34500.00),
('cust-005', 'tenant-003', '+27821234567', 'Thabo Nkosi', 'thabo@example.com', 'en', 4, 8200.00),
('cust-006', 'tenant-003', '+27832345678', 'Lerato Dlamini', 'lerato@example.com', 'en', 1, 1850.00),
('cust-007', 'tenant-004', '+233201234567', 'Kwame Asante', 'kwame@example.com', 'en', 6, 3200.00),
('cust-008', 'tenant-005', '+201012345678', 'Fatima Hassan', 'fatima@example.com', 'ar', 3, 12400.00)
ON CONFLICT DO NOTHING;

-- Conversations (correct columns: no waId, status values: open/pending/resolved/closed, aiHandled not botHandled)
INSERT INTO conversations (id, "tenantId", "customerId", status, "messageCount", "aiHandled", "escalatedAt") VALUES
('conv-001', 'tenant-001', 'cust-001', 'open', 12, true, NULL),
('conv-002', 'tenant-001', 'cust-002', 'open', 8, false, NOW() - INTERVAL '10 minutes'),
('conv-003', 'tenant-002', 'cust-003', 'resolved', 24, true, NULL),
('conv-004', 'tenant-002', 'cust-004', 'open', 6, true, NULL),
('conv-005', 'tenant-003', 'cust-005', 'open', 15, false, NOW() - INTERVAL '20 minutes'),
('conv-006', 'tenant-004', 'cust-007', 'resolved', 9, true, NULL),
('conv-007', 'tenant-005', 'cust-008', 'open', 18, true, NULL)
ON CONFLICT DO NOTHING;

-- Orders (paymentStatus enum: unpaid/pending/paid/refunded/failed)
INSERT INTO orders (id, "tenantId", "customerId", "conversationId", "orderNumber", status, "totalAmount", currency, "paymentStatus", items) VALUES
('ord-001', 'tenant-001', 'cust-001', 'conv-001', 'ORD-2026-001', 'confirmed', 4250.00, 'NGN', 'paid', '[{"sku":"FRU-001","name":"Fresh Tomatoes","qty":3,"price":850},{"sku":"FRU-002","name":"Plantain Bunch","qty":1,"price":1200}]'),
('ord-002', 'tenant-001', 'cust-002', 'conv-002', 'ORD-2026-002', 'shipped', 2500.00, 'NGN', 'paid', '[{"sku":"GRN-001","name":"Ugu Leaves","qty":5,"price":500}]'),
('ord-003', 'tenant-002', 'cust-003', 'conv-003', 'ORD-2026-003', 'delivered', 86500.00, 'KES', 'paid', '[{"sku":"TECH-001","name":"Samsung Galaxy A55","qty":1,"price":58000},{"sku":"ACC-001","name":"USB-C Charger","qty":2,"price":3200}]'),
('ord-004', 'tenant-002', 'cust-004', 'conv-004', 'ORD-2026-004', 'pending', 28500.00, 'KES', 'unpaid', '[{"sku":"TECH-002","name":"Infinix Hot 40 Pro","qty":1,"price":28500}]'),
('ord-005', 'tenant-003', 'cust-005', 'conv-005', 'ORD-2026-005', 'confirmed', 3300.00, 'ZAR', 'paid', '[{"sku":"BTQ-001","name":"Ankara Dress","qty":1,"price":1200},{"sku":"BTQ-002","name":"Beaded Necklace","qty":2,"price":450}]'),
('ord-006', 'tenant-004', 'cust-007', 'conv-006', 'ORD-2026-006', 'delivered', 840.00, 'GHS', 'paid', '[{"sku":"FSH-001","name":"Kente Shirt","qty":3,"price":280}]'),
('ord-007', 'tenant-005', 'cust-008', 'conv-007', 'ORD-2026-007', 'confirmed', 28000.00, 'EGP', 'pending', '[{"sku":"ELC-001","name":"HP Laptop","qty":1,"price":28000}]')
ON CONFLICT DO NOTHING;

-- Payment Intents (correct column: providerPaymentId not providerRef; status enum: initiated/pending/succeeded/failed/cancelled/refunded)
INSERT INTO payment_intents (id, "tenantId", "orderId", "customerId", amount, currency, status, provider, "idempotencyKey", "providerPaymentId") VALUES
('pi-001', 'tenant-001', 'ord-001', 'cust-001', 4250.00, 'NGN', 'succeeded', 'paystack', 'idem-001', 'PAY-001-NG'),
('pi-002', 'tenant-001', 'ord-002', 'cust-002', 2500.00, 'NGN', 'succeeded', 'paystack', 'idem-002', 'PAY-002-NG'),
('pi-003', 'tenant-002', 'ord-003', 'cust-003', 86500.00, 'KES', 'succeeded', 'stripe', 'idem-003', 'pi_stripe_003'),
('pi-004', 'tenant-002', 'ord-004', 'cust-004', 28500.00, 'KES', 'pending', 'stripe', 'idem-004', NULL),
('pi-005', 'tenant-003', 'ord-005', 'cust-005', 3300.00, 'ZAR', 'succeeded', 'stripe', 'idem-005', 'pi_stripe_005'),
('pi-006', 'tenant-004', 'ord-006', 'cust-007', 840.00, 'GHS', 'succeeded', 'paystack', 'idem-006', 'PAY-006-GH'),
('pi-007', 'tenant-005', 'ord-007', 'cust-008', 28000.00, 'EGP', 'pending', 'stripe', 'idem-007', NULL)
ON CONFLICT DO NOTHING;

-- WhatsApp Menu Items (need tenantId)
INSERT INTO whatsapp_menu_items (id, "menuId", "tenantId", "parentId", type, title, description, payload, "sortOrder") VALUES
('mi-001', 'menu-001', 'tenant-001', NULL, 'section', 'Shop Fresh Produce', 'Browse our daily fresh items', NULL, 1),
('mi-002', 'menu-001', 'tenant-001', 'mi-001', 'list_item', 'Vegetables', 'Fresh vegetables delivered daily', 'BROWSE_VEG', 1),
('mi-003', 'menu-001', 'tenant-001', 'mi-001', 'list_item', 'Fruits', 'Seasonal fruits and tropicals', 'BROWSE_FRU', 2),
('mi-004', 'menu-001', 'tenant-001', NULL, 'section', 'My Orders', 'Track and manage your orders', NULL, 2),
('mi-005', 'menu-001', 'tenant-001', 'mi-004', 'quick_reply', 'Track My Order', NULL, 'TRACK_ORDER', 1),
('mi-006', 'menu-001', 'tenant-001', 'mi-004', 'quick_reply', 'Reorder Last', NULL, 'REORDER_LAST', 2),
('mi-007', 'menu-002', 'tenant-002', NULL, 'section', 'Browse Phones', 'Latest smartphones', NULL, 1),
('mi-008', 'menu-002', 'tenant-002', 'mi-007', 'catalog_link', 'View All Phones', 'See our full phone catalog', 'CAT_PHONES', 1),
('mi-009', 'menu-002', 'tenant-002', NULL, 'section', 'Support', 'Get help with your order', NULL, 2),
('mi-010', 'menu-002', 'tenant-002', 'mi-009', 'quick_reply', 'Talk to Agent', NULL, 'ESCALATE_HUMAN', 1)
ON CONFLICT DO NOTHING;

-- Tenant Menu Assignments (need id column)
INSERT INTO tenant_menu_assignments (id, "tenantId", "menuId", "isActive", "assignedAt") VALUES
('tma-001', 'tenant-001', 'menu-001', true, NOW()),
('tma-002', 'tenant-002', 'menu-002', true, NOW()),
('tma-003', 'tenant-004', 'menu-004', true, NOW())
ON CONFLICT DO NOTHING;

-- WhatsApp Templates (no status column — use isActive boolean)
INSERT INTO whatsapp_templates (id, "tenantId", name, category, language, "headerText", "bodyText", "footerText", variables, "usageCount", "isActive") VALUES
('tpl-001', 'tenant-001', 'Order Confirmation', 'TRANSACTIONAL', 'en', 'Order Confirmed ✅', 'Hi {{customer_name}}, your order #{{order_number}} for {{total_amount}} has been confirmed! Expected delivery: {{delivery_date}}.', 'Lagos Fresh Market', '["customer_name","order_number","total_amount","delivery_date"]', 142, true),
('tpl-002', 'tenant-001', 'Shipping Update', 'TRANSACTIONAL', 'en', 'Your Order is on the Way 🚚', 'Hi {{customer_name}}, order #{{order_number}} is now with our delivery partner. Track here: {{tracking_link}}', 'Lagos Fresh Market', '["customer_name","order_number","tracking_link"]', 98, true),
('tpl-003', 'tenant-002', 'Payment Reminder', 'TRANSACTIONAL', 'en', 'Payment Pending ⏰', 'Hi {{customer_name}}, your order #{{order_number}} worth {{amount}} is awaiting payment. Pay now: {{payment_link}}', 'Nairobi Tech Store', '["customer_name","order_number","amount","payment_link"]', 67, true),
('tpl-004', 'tenant-002', 'Welcome Message', 'MARKETING', 'en', 'Welcome to Nairobi Tech Store! 🎉', 'Hi {{customer_name}}! Welcome to Nairobi Tech Store. Browse our latest phones and accessories. Type MENU to get started.', 'Nairobi Tech Store', '["customer_name"]', 312, true),
('tpl-005', 'tenant-003', 'Flash Sale Alert', 'MARKETING', 'en', '🔥 Flash Sale — {{discount}}% OFF Today Only!', 'Hi {{customer_name}}, our {{sale_name}} is LIVE! Get {{discount}}% off all items. Use code {{promo_code}} at checkout. Valid until {{expiry_time}}.', 'Cape Town Boutique', '["customer_name","sale_name","discount","promo_code","expiry_time"]', 0, false)
ON CONFLICT DO NOTHING;

-- Template Versions (correct columns: changedBy not createdBy)
INSERT INTO template_versions (id, "templateId", version, "bodyText", "headerText", "footerText", status, "publishedAt", "changedBy") VALUES
('tv-001', 'tpl-001', 1, 'Hi {{customer_name}}, order #{{order_number}} confirmed!', 'Order Confirmed', 'Lagos Fresh Market', 'published', NOW() - INTERVAL '30 days', 'admin'),
('tv-002', 'tpl-001', 2, 'Hi {{customer_name}}, your order #{{order_number}} for {{total_amount}} is confirmed! Delivery: {{delivery_date}}.', 'Order Confirmed ✅', 'Lagos Fresh Market', 'published', NOW() - INTERVAL '15 days', 'admin'),
('tv-003', 'tpl-001', 3, 'Hi {{customer_name}}, your order #{{order_number}} for {{total_amount}} has been confirmed! Expected delivery: {{delivery_date}}.', 'Order Confirmed ✅', 'Lagos Fresh Market', 'published', NOW() - INTERVAL '2 days', 'admin'),
('tv-004', 'tpl-002', 1, 'Hi {{customer_name}}, order #{{order_number}} is on its way!', 'Shipping Update 🚚', 'Lagos Fresh Market', 'published', NOW() - INTERVAL '20 days', 'admin'),
('tv-005', 'tpl-002', 2, 'Hi {{customer_name}}, order #{{order_number}} is now with our delivery partner. Track here: {{tracking_link}}', 'Your Order is on the Way 🚚', 'Lagos Fresh Market', 'published', NOW() - INTERVAL '5 days', 'admin'),
('tv-006', 'tpl-004', 1, 'Hi {{customer_name}}! Welcome to Nairobi Tech Store. Type MENU to get started.', 'Welcome to Nairobi Tech Store! 🎉', 'Nairobi Tech Store', 'published', NOW() - INTERVAL '60 days', 'admin')
ON CONFLICT DO NOTHING;

-- Service Health (correct columns: latencyMs not latency; no version column; details not metadata)
INSERT INTO service_health (id, "serviceName", status, "latencyMs", "errorRate", "lastCheckedAt", details) VALUES
(1, 'api-gateway', 'healthy', 12, 0.10, NOW(), '{"port":8080,"language":"Go","replicas":3,"version":"v1.4.2"}'),
(2, 'webhook-ingestor', 'healthy', 8, 0.00, NOW(), '{"port":8081,"language":"Go","replicas":2,"version":"v1.2.1"}'),
(3, 'conversation-orchestrator', 'healthy', 45, 0.20, NOW(), '{"port":8082,"language":"Go","replicas":2,"version":"v1.3.0"}'),
(4, 'commerce-engine', 'healthy', 28, 0.10, NOW(), '{"port":8083,"language":"Go","replicas":2,"version":"v1.1.5"}'),
(5, 'payment-orchestrator', 'healthy', 67, 0.30, NOW(), '{"port":8084,"language":"Go","replicas":2,"version":"v1.0.8"}'),
(6, 'event-processor', 'healthy', 3, 0.00, NOW(), '{"port":9001,"language":"Rust","replicas":4,"version":"v0.9.3"}'),
(7, 'ledger-bridge', 'healthy', 5, 0.00, NOW(), '{"port":9002,"language":"Rust","replicas":2,"version":"v0.8.1"}'),
(8, 'recon-worker', 'healthy', 4, 0.10, NOW(), '{"port":9003,"language":"Rust","replicas":1,"version":"v0.7.2"}'),
(9, 'ai-agent', 'healthy', 320, 0.80, NOW(), '{"port":8090,"language":"Python","replicas":3,"version":"v2.1.0"}'),
(10, 'admin-dashboard', 'healthy', 15, 0.00, NOW(), '{"port":3000,"language":"TypeScript","replicas":1,"version":"v1.5.0"}')
ON CONFLICT (id) DO UPDATE SET "latencyMs" = EXCLUDED."latencyMs", "lastCheckedAt" = NOW();

-- Agent Events (correct columns: intentType not intent; model not modelUsed; latencyMs not processingTimeMs)
INSERT INTO agent_events (id, "tenantId", "conversationId", "eventType", "intentType", confidence, "latencyMs", model) VALUES
('ae-001', 'tenant-001', 'conv-001', 'intent_detected', 'browse_products', 0.960, 145, 'gpt-4o-mini'),
('ae-002', 'tenant-001', 'conv-001', 'product_recommended', 'product_search', 0.890, 320, 'gpt-4o-mini'),
('ae-003', 'tenant-001', 'conv-002', 'escalation_triggered', 'complaint', 0.780, 98, 'gpt-4o-mini'),
('ae-004', 'tenant-002', 'conv-003', 'order_placed', 'checkout', 0.990, 210, 'gpt-4o'),
('ae-005', 'tenant-002', 'conv-004', 'intent_detected', 'browse_products', 0.940, 132, 'gpt-4o'),
('ae-006', 'tenant-003', 'conv-005', 'escalation_triggered', 'return_request', 0.820, 115, 'gpt-4o-mini'),
('ae-007', 'tenant-004', 'conv-006', 'order_placed', 'checkout', 0.970, 198, 'gpt-4o-mini'),
('ae-008', 'tenant-005', 'conv-007', 'intent_detected', 'payment_inquiry', 0.910, 167, 'gpt-4o')
ON CONFLICT DO NOTHING;
