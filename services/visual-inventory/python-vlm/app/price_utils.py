"""
Price-tag parsing utilities (Nigerian Naira).

Mirrors the semantics of `parseReceiptAmount` in
`server/services/receiptVision.ts` (TypeScript) so the CV stack and the
receipt-verification stack agree on how a printed price string becomes a
numeric major-unit amount:

  - Accepts optional currency prefixes: "₦", "NGN", "N" (case-insensitive).
  - Accepts thousands separators ("12,500") and optional kobo decimals.
  - Returns the amount in MAJOR units (naira) as a float.
  - Returns None when nothing parseable is found or the value is <= 0.
"""
import re
from typing import Optional

# Same shape as the TS regex:
#   (?:₦|NGN|N)?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)
_PRICE_RE = re.compile(
    r"(?:₦|NGN|N)?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)",
    re.IGNORECASE,
)


def parse_naira_price(text: object) -> Optional[float]:
    """
    Parse a price string into naira major units.

    >>> parse_naira_price("₦12,500")
    12500.0
    >>> parse_naira_price("NGN 12500.00")
    12500.0
    >>> parse_naira_price("12,500.00")
    12500.0
    >>> parse_naira_price("free") is None
    True
    """
    if not text:
        return None
    m = _PRICE_RE.search(str(text))
    if not m:
        return None
    try:
        value = float(m.group(1).replace(",", ""))
    except ValueError:
        return None
    return value if value > 0 else None
