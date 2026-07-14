"""Guardrails — policy enforcement layer for the AI agent.

Implements the safety boundaries described in the architecture blueprint:
- PII detection and redaction
- Sentiment-based escalation triggers
- Topic boundary enforcement (no medical/legal/financial advice)
- Response length and format validation
- Injection attack detection
"""
import re
import structlog
from dataclasses import dataclass
from typing import Optional

log = structlog.get_logger()

# ─── PII Patterns ─────────────────────────────────────────────────────────────

PII_PATTERNS = [
    (re.compile(r"\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b"), "[CARD_REDACTED]"),
    (re.compile(r"\b\d{3}-\d{2}-\d{4}\b"), "[SSN_REDACTED]"),
    (re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b"), "[EMAIL_REDACTED]"),
    (re.compile(r"\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b"), "[PHONE_REDACTED]"),
]

# ─── Injection Patterns ────────────────────────────────────────────────────────

INJECTION_PATTERNS = [
    re.compile(r"ignore\s+(previous|all|above)\s+instructions", re.IGNORECASE),
    re.compile(r"you\s+are\s+now\s+a\s+different", re.IGNORECASE),
    re.compile(r"jailbreak", re.IGNORECASE),
    re.compile(r"system\s*prompt", re.IGNORECASE),
    re.compile(r"<\s*script\s*>", re.IGNORECASE),
    re.compile(r"prompt\s+injection", re.IGNORECASE),
]

# ─── Negative Sentiment Keywords ──────────────────────────────────────────────

NEGATIVE_SENTIMENT_KEYWORDS = [
    "angry", "furious", "terrible", "awful", "horrible", "disgusting",
    "scam", "fraud", "cheat", "steal", "lawsuit", "sue", "legal action",
    "refund now", "cancel everything", "worst", "never again",
]

# ─── Out-of-scope Topics ──────────────────────────────────────────────────────

OUT_OF_SCOPE_PATTERNS = [
    re.compile(r"\b(medical|diagnosis|treatment|prescription|drug|medicine)\b", re.IGNORECASE),
    re.compile(r"\b(legal advice|lawyer|attorney|court|lawsuit)\b", re.IGNORECASE),
    re.compile(r"\b(invest|stock market|crypto|bitcoin|trading advice)\b", re.IGNORECASE),
]


@dataclass
class GuardrailResult:
    passed: bool
    redacted_text: str
    escalate: bool = False
    escalation_reason: Optional[str] = None
    blocked: bool = False
    block_reason: Optional[str] = None
    warnings: list[str] = None

    def __post_init__(self):
        if self.warnings is None:
            self.warnings = []


class Guardrails:
    """Policy enforcement for inbound messages and outbound responses."""

    def __init__(self, sentiment_threshold: float = 0.2):
        self.sentiment_threshold = sentiment_threshold

    def check_inbound(self, text: str, tenant_id: str, conversation_id: str) -> GuardrailResult:
        """Apply all guardrails to an inbound user message."""
        result = GuardrailResult(passed=True, redacted_text=text)

        # 1. Injection detection
        for pattern in INJECTION_PATTERNS:
            if pattern.search(text):
                log.warning("injection_attempt_detected",
                            tenant_id=tenant_id, conversation_id=conversation_id,
                            pattern=pattern.pattern[:50])
                result.blocked = True
                result.block_reason = "potential_injection"
                result.passed = False
                result.redacted_text = "[Message blocked by security policy]"
                return result

        # 2. PII redaction
        redacted = text
        for pattern, replacement in PII_PATTERNS:
            if pattern.search(redacted):
                redacted = pattern.sub(replacement, redacted)
                result.warnings.append(f"PII redacted: {replacement}")
        result.redacted_text = redacted

        # 3. Negative sentiment detection
        text_lower = text.lower()
        neg_count = sum(1 for kw in NEGATIVE_SENTIMENT_KEYWORDS if kw in text_lower)
        if neg_count >= 2:
            result.escalate = True
            result.escalation_reason = "sentiment_risk"
            log.info("sentiment_escalation_triggered",
                     tenant_id=tenant_id, conversation_id=conversation_id,
                     neg_count=neg_count)

        # 4. Out-of-scope topic detection
        for pattern in OUT_OF_SCOPE_PATTERNS:
            if pattern.search(text):
                result.warnings.append("out_of_scope_topic_detected")
                # Don't block, but flag for careful handling
                break

        return result

    def check_outbound(self, text: str, max_length: int = 1500) -> GuardrailResult:
        """Validate and sanitize an outbound AI response."""
        result = GuardrailResult(passed=True, redacted_text=text)

        # 1. Length enforcement
        if len(text) > max_length:
            result.redacted_text = text[:max_length] + "...\n\nType 'more' to continue."
            result.warnings.append(f"response_truncated: {len(text)} -> {max_length}")

        # 2. PII in outbound (shouldn't happen but defensive)
        redacted = result.redacted_text
        for pattern, replacement in PII_PATTERNS:
            redacted = pattern.sub(replacement, redacted)
        result.redacted_text = redacted

        return result

    def redact_pii(self, text: str) -> str:
        """Standalone PII redaction utility."""
        for pattern, replacement in PII_PATTERNS:
            text = pattern.sub(replacement, text)
        return text

