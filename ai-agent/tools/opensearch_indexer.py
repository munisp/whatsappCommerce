"""
opensearch_indexer.py — OpenSearch indexing and search helpers for WhatsApp Commerce

Provides:
  - Index products, orders, conversations, and PO drafts
  - Full-text search with fuzzy matching
  - Bulk indexing for initial data loads
  - Index lifecycle management (create, delete, refresh)

Falls back gracefully when OPENSEARCH_URL is not set.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime
from typing import Any

logger = logging.getLogger(__name__)

OPENSEARCH_URL = os.getenv("OPENSEARCH_URL", "")
OPENSEARCH_USER = os.getenv("OPENSEARCH_USER", "admin")
OPENSEARCH_PASS = os.getenv("OPENSEARCH_PASS", "admin")

_client = None


def _get_client():
    global _client
    if _client is not None:
        return _client
    if not OPENSEARCH_URL:
        logger.info("[OpenSearch] OPENSEARCH_URL not set — search disabled")
        return None
    try:
        from opensearchpy import OpenSearch, RequestsHttpConnection
        from opensearchpy.helpers import bulk as os_bulk  # noqa: F401
        host = OPENSEARCH_URL.rstrip("/")
        _client = OpenSearch(
            hosts=[host],
            http_auth=(OPENSEARCH_USER, OPENSEARCH_PASS),
            use_ssl=host.startswith("https"),
            verify_certs=False,
            connection_class=RequestsHttpConnection,
            timeout=10,
        )
        logger.info("[OpenSearch] client initialised → %s", host)
        return _client
    except Exception as exc:
        logger.warning("[OpenSearch] init failed: %s", exc)
        return None


# ─── Index Definitions ────────────────────────────────────────────────────────

INDICES = {
    "products": {
        "mappings": {
            "properties": {
                "id": {"type": "keyword"},
                "name": {"type": "text", "analyzer": "standard"},
                "description": {"type": "text"},
                "price": {"type": "float"},
                "currency": {"type": "keyword"},
                "tenant_id": {"type": "keyword"},
                "category": {"type": "keyword"},
                "tags": {"type": "keyword"},
                "indexed_at": {"type": "date"},
            }
        }
    },
    "orders": {
        "mappings": {
            "properties": {
                "id": {"type": "keyword"},
                "customer_phone": {"type": "keyword"},
                "tenant_id": {"type": "keyword"},
                "status": {"type": "keyword"},
                "total": {"type": "float"},
                "items": {"type": "nested"},
                "created_at": {"type": "date"},
            }
        }
    },
    "conversations": {
        "mappings": {
            "properties": {
                "id": {"type": "keyword"},
                "phone": {"type": "keyword"},
                "tenant_id": {"type": "keyword"},
                "messages": {"type": "text"},
                "intent": {"type": "keyword"},
                "updated_at": {"type": "date"},
            }
        }
    },
    "hermes_po_drafts": {
        "mappings": {
            "properties": {
                "id": {"type": "keyword"},
                "tenant_id": {"type": "keyword"},
                "supplier_name": {"type": "text"},
                "status": {"type": "keyword"},
                "total_amount": {"type": "float"},
                "created_at": {"type": "date"},
            }
        }
    },
}


def ensure_indices() -> None:
    """Create all indices if they don't exist."""
    client = _get_client()
    if not client:
        return
    for name, body in INDICES.items():
        try:
            if not client.indices.exists(index=name):
                client.indices.create(index=name, body=body)
                logger.info("[OpenSearch] Created index: %s", name)
        except Exception as exc:
            logger.warning("[OpenSearch] ensure_index %s failed: %s", name, exc)


def index_document(index: str, doc_id: str, doc: dict[str, Any]) -> bool:
    """Index a single document. Returns True on success."""
    client = _get_client()
    if not client:
        return False
    try:
        doc["indexed_at"] = datetime.utcnow().isoformat()
        client.index(index=index, id=doc_id, body=doc, refresh=False)
        return True
    except Exception as exc:
        logger.warning("[OpenSearch] index %s/%s failed: %s", index, doc_id, exc)
        return False


def bulk_index(index: str, docs: list[dict[str, Any]], id_field: str = "id") -> int:
    """Bulk index documents. Returns count of successfully indexed docs."""
    client = _get_client()
    if not client:
        return 0
    try:
        from opensearchpy.helpers import bulk
        actions = [
            {"_index": index, "_id": doc.get(id_field), "_source": doc}
            for doc in docs
        ]
        success, _ = bulk(client, actions, raise_on_error=False)
        return success
    except Exception as exc:
        logger.warning("[OpenSearch] bulk_index %s failed: %s", index, exc)
        return 0


def search(index: str, query: str, size: int = 20, filters: dict[str, str] | None = None) -> list[dict]:
    """Full-text search with optional keyword filters."""
    client = _get_client()
    if not client:
        return []
    try:
        must_clauses: list[dict] = [
            {"multi_match": {"query": query, "fields": ["*"], "fuzziness": "AUTO"}}
        ]
        if filters:
            for field, value in filters.items():
                must_clauses.append({"term": {field: value}})
        body = {"query": {"bool": {"must": must_clauses}}, "size": size}
        resp = client.search(index=index, body=body)
        return [{"id": h["_id"], **h["_source"]} for h in resp["hits"]["hits"]]
    except Exception as exc:
        logger.warning("[OpenSearch] search %s failed: %s", index, exc)
        return []


def delete_document(index: str, doc_id: str) -> bool:
    """Delete a document by ID."""
    client = _get_client()
    if not client:
        return False
    try:
        client.delete(index=index, id=doc_id, ignore=[404])
        return True
    except Exception as exc:
        logger.warning("[OpenSearch] delete %s/%s failed: %s", index, doc_id, exc)
        return False


def health_check() -> dict[str, Any]:
    """Return cluster health status."""
    client = _get_client()
    if not client:
        return {"online": False, "error": "not_configured"}
    try:
        import time
        t0 = time.monotonic()
        info = client.cluster.health()
        latency_ms = int((time.monotonic() - t0) * 1000)
        status = info.get("status", "unknown")
        return {
            "online": status in ("green", "yellow"),
            "status": status,
            "latency_ms": latency_ms,
        }
    except Exception as exc:
        return {"online": False, "error": str(exc)}
