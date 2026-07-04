#!/usr/bin/env python3
"""Stage 2 — ingest Sapiom transactions + account balance into DuckDB.

Real mode (default):
    SAPIOM_API_KEY=... python ingest.py
Fixture mode (no key / no network required):
    python ingest.py --from-file tests/fixture_transactions.json

Writes/updates spend.duckdb with three tables: transactions, costs,
balance_snapshots. Safe to rerun (INSERT OR REPLACE on PK).
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit

API_BASE = "https://api.sapiom.ai"
TRANSACTIONS_PATH = "/v1/transactions"
ACCOUNTS_PATH = "/v1/accounts"
DEFAULT_DB = "spend.duckdb"


def die(msg: str) -> None:
    print(f"FATAL: {msg}", file=sys.stderr)
    sys.exit(1)


def api_get(path: str, api_key: str) -> dict:
    url = path if path.startswith("http") else f"{API_BASE}{path}"
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {api_key}",
            "User-Agent": "curl/8.6.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        die(f"GET {url} failed: HTTP {e.code} {e.read()[:500]!r}")
    except urllib.error.URLError as e:
        die(f"GET {url} failed: {e.reason}")


def _fix_next_link(next_link: str) -> str:
    """The API's links.next omits the /v1 prefix (e.g. "/transactions?page[after]=...").
    Prefix bare paths with /v1. If next_link is already absolute, only rewrite its
    path when it points at our API host and is missing the /v1 prefix."""
    if not next_link:
        return next_link
    if next_link.startswith("http"):
        parts = urlsplit(next_link)
        if parts.netloc == urlsplit(API_BASE).netloc and not parts.path.startswith("/v1/"):
            parts = parts._replace(path=f"/v1{parts.path}")
            return urlunsplit(parts)
        return next_link
    return next_link if next_link.startswith("/v1/") else f"/v1{next_link}"


def fetch_transactions_real(api_key: str) -> list:
    """Follow JSON:API links.next pagination until exhausted."""
    all_txns = []
    path = TRANSACTIONS_PATH
    page_num = 0
    while path:
        page_num += 1
        page = api_get(path, api_key)
        data = page.get("data", [])
        all_txns.extend(data)
        print(f"  page {page_num}: {len(data)} transactions (running total {len(all_txns)})")
        next_link = (page.get("links") or {}).get("next")
        path = _fix_next_link(next_link)  # relative /v1 path, absolute URL, or None to stop
    return all_txns


def fetch_accounts_real(api_key: str) -> dict:
    return api_get(ACCOUNTS_PATH, api_key)


def load_fixture(path: str) -> tuple:
    with open(path) as f:
        fixture = json.load(f)
    txns = fixture["transactions_page"]["data"]
    accounts = fixture["accounts"]
    return txns, accounts


def extract_balance(accounts_payload: dict) -> str:
    """Pull the default account's totalBalance (string, 18dp) from the /v1/accounts payload."""
    accounts = accounts_payload.get("data", [])
    if not accounts:
        die("accounts payload has no data")
    default = next((a for a in accounts if a.get("isDefault")), accounts[0])
    balance = default.get("totalBalance")
    if balance is None:
        die("account record missing totalBalance field")
    return balance


def normalize_transaction(txn: dict) -> tuple:
    """Returns (transaction_row_tuple, [cost_row_tuples]).

    BUILD 0 (2026-07-04): added trace_external_id (from trace.externalId) and
    costs.cost_details (JSON blob). Field availability was probed live against
    GET /v1/transactions before adding: trace.externalId, outcome (top-level),
    costs[].isEstimate/supersededAt/supersedesCostId/costDetails all confirmed
    present. No top-level `payment` sub-object and no `factPhase` field exist
    anywhere in the live data (checked both a single-cost and a 2-cost/
    superseded transaction) — those two were deliberately NOT added. See
    BACKLOG.md BUILD 0 for the full verification note.
    """
    agent = txn.get("agent") or {}
    trace = txn.get("trace") or {}
    txn_row = (
        txn["id"],
        txn.get("serviceName"),
        txn.get("actionName"),
        txn.get("status"),
        txn.get("outcome"),
        txn.get("agentId"),
        agent.get("name"),
        txn.get("traceId"),
        trace.get("externalId"),
        txn.get("createdAt"),
        txn.get("authorizedAt"),
        txn.get("completedAt"),
        json.dumps(txn),
    )
    cost_rows = []
    for c in txn.get("costs", []) or []:
        cost_details = c.get("costDetails")
        cost_rows.append((
            c["id"],
            c["transactionId"],
            c["fiatAmount"],
            bool(c.get("isEstimate")),
            bool(c.get("isActive")),
            c.get("supersedesCostId"),
            c.get("supersededAt"),
            c.get("createdAt"),
            json.dumps(cost_details) if cost_details is not None else None,
        ))
    return txn_row, cost_rows


def init_schema(con) -> None:
    con.execute("""
        CREATE TABLE IF NOT EXISTS transactions (
            id VARCHAR PRIMARY KEY,
            service_name VARCHAR,
            action_name VARCHAR,
            status VARCHAR,
            outcome VARCHAR,
            agent_id VARCHAR,
            agent_name VARCHAR,
            trace_id VARCHAR,
            trace_external_id VARCHAR,
            created_at TIMESTAMP,
            authorized_at TIMESTAMP,
            completed_at TIMESTAMP,
            raw JSON
        )
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS costs (
            id VARCHAR PRIMARY KEY,
            transaction_id VARCHAR,
            fiat_amount DECIMAL(38,18),
            is_estimate BOOLEAN,
            is_active BOOLEAN,
            supersedes_cost_id VARCHAR,
            superseded_at TIMESTAMP,
            created_at TIMESTAMP,
            cost_details JSON
        )
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS balance_snapshots (
            fetched_at TIMESTAMP,
            balance DECIMAL(38,18),
            raw JSON
        )
    """)
    # BUILD 0 migration: CREATE TABLE IF NOT EXISTS above is a no-op against
    # an already-existing spend.duckdb from before this schema change, so
    # add the two new columns explicitly (idempotent — IF NOT EXISTS guards
    # re-running against an already-migrated db).
    con.execute("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS trace_external_id VARCHAR")
    con.execute("ALTER TABLE costs ADD COLUMN IF NOT EXISTS cost_details JSON")


def run_dq_checks(txn_rows: list, cost_rows: list) -> None:
    txn_ids = [r[0] for r in txn_rows]
    if len(txn_ids) != len(set(txn_ids)):
        die("DQ FAIL: duplicate transaction ids in batch")

    txn_id_set = set(txn_ids)
    for c in cost_rows:
        if c[1] not in txn_id_set:
            die(f"DQ FAIL: cost row {c[0]} references unknown transaction_id {c[1]}")

    from decimal import Decimal
    negative = [c[0] for c in cost_rows if Decimal(c[2]) < 0]
    if negative:
        die(f"DQ FAIL: negative fiat_amount on cost rows: {negative}")

    print(f"  DQ OK: {len(txn_ids)} unique transaction ids, "
          f"{len(cost_rows)} cost rows, no negatives, no orphan transaction_ids")


def main():
    ap = argparse.ArgumentParser(description="Ingest Sapiom transactions + balance into DuckDB")
    ap.add_argument("--from-file", metavar="JSON",
                     help="Read transactions/accounts from a fixture JSON file instead of the live API")
    ap.add_argument("--db", default=DEFAULT_DB, help=f"DuckDB file path (default {DEFAULT_DB})")
    args = ap.parse_args()

    if args.from_file:
        print(f"Loading fixture from {args.from_file} (no API calls)")
        txns, accounts_payload = load_fixture(args.from_file)
    else:
        api_key = os.environ.get("SAPIOM_API_KEY")
        if not api_key:
            die("SAPIOM_API_KEY env var not set (use --from-file to test without a key)")
        print("Fetching transactions from live API...")
        txns = fetch_transactions_real(api_key)
        print("Fetching account balance from live API...")
        accounts_payload = fetch_accounts_real(api_key)

    txn_rows = []
    cost_rows = []
    for t in txns:
        tr, crs = normalize_transaction(t)
        txn_rows.append(tr)
        cost_rows.extend(crs)

    print(f"Parsed {len(txn_rows)} transactions, {len(cost_rows)} cost rows")
    run_dq_checks(txn_rows, cost_rows)

    balance = extract_balance(accounts_payload)

    import duckdb
    con = duckdb.connect(args.db)
    init_schema(con)

    # Named columns (not positional VALUES) — required because ALTER TABLE
    # ADD COLUMN (in init_schema, for pre-existing dbs migrating to this
    # schema) always appends new columns at the physical end of the table,
    # which no longer matches the CREATE TABLE-only column order used below.
    # Naming columns explicitly makes the insert order-independent of the
    # table's actual physical column layout.
    con.executemany(
        """INSERT OR REPLACE INTO transactions
           (id, service_name, action_name, status, outcome, agent_id, agent_name,
            trace_id, trace_external_id, created_at, authorized_at, completed_at, raw)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        txn_rows,
    )
    con.executemany(
        """INSERT OR REPLACE INTO costs
           (id, transaction_id, fiat_amount, is_estimate, is_active,
            supersedes_cost_id, superseded_at, created_at, cost_details)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        cost_rows,
    )
    fetched_at = datetime.now(timezone.utc).isoformat()
    con.execute(
        "INSERT INTO balance_snapshots VALUES (?, ?, ?)",
        (fetched_at, balance, json.dumps(accounts_payload)),
    )

    n_txns = con.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
    n_costs = con.execute("SELECT COUNT(*) FROM costs").fetchone()[0]
    n_snaps = con.execute("SELECT COUNT(*) FROM balance_snapshots").fetchone()[0]
    print(f"DB state: transactions={n_txns} costs={n_costs} balance_snapshots={n_snaps}")
    print(f"Latest balance snapshot: {balance}")
    con.close()


if __name__ == "__main__":
    main()
