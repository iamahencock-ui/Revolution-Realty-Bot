// ---------------------------------------------------------------------------
// verify.js — IGN ownership verification via a DC Treasury micropayment.
//
// Flow: user gets a unique 32-char memo, pays {amount} to VERIFY_ACCOUNT_ID
// with that memo in-game, then clicks confirm. We read the account's recent
// transactions, find the one carrying the memo, and read the payer's UUID/IGN.
// ---------------------------------------------------------------------------
import crypto from "node:crypto";

const BASE = process.env.DC_API_BASE || "https://api.democracycraft.net/economy";
const TOKEN = () => process.env.DC_API_TOKEN || null;
const VERIFY_ACCOUNT_ID = () => process.env.VERIFY_ACCOUNT_ID || null;
// Account payouts are debited from. Defaults to the same firm account that
// receives verification/escrow payments.
const FROM_ACCOUNT_ID = () =>
  process.env.DC_FROM_ACCOUNT_ID || process.env.VERIFY_ACCOUNT_ID || null;

export function verifyEnabled() {
  return !!(TOKEN() && VERIFY_ACCOUNT_ID());
}

// Escrow/autopay needs both a token and an account to pay from.
export function dealEnabled() {
  return !!(TOKEN() && FROM_ACCOUNT_ID());
}

// A 32-char alphanumeric memo (no symbols, so DC can't strip/mangle it).
export function newMemoCode() {
  return crypto.randomBytes(24).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
}

async function apiGet(path) {
  const jwt = TOKEN();
  if (!jwt) return { ok: false, error: "NO_TOKEN" };
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
  } catch (e) {
    return { ok: false, error: "NETWORK", message: e.message };
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, data };
  return { ok: false, status: res.status, error: data.error || `HTTP_${res.status}`, message: data.message || "" };
}

// Resolve a player UUID to their current IGN via the Treasury API.
async function ignForUuid(uuid) {
  if (!uuid) return null;
  const r = await apiGet(`/api/v1/accounts/by-player?uuid=${encodeURIComponent(uuid)}`);
  return r.ok ? r.data.playerName ?? null : null;
}

// Look for a received payment carrying `code` in its memo/message.
// Returns { ok, found, ign, uuid, txnId, amount } or an error.
export async function findVerificationPayment(code, minAmount = 0.01, limit = 100) {
  const acct = VERIFY_ACCOUNT_ID();
  if (!acct) return { ok: false, error: "NO_ACCOUNT" };

  const r = await apiGet(`/api/v1/accounts/${acct}/transactions?limit=${limit}`);
  if (!r.ok) return r;

  const items = r.data.items || [];
  const needle = code.toLowerCase();
  const has = (s) => (s || "").toLowerCase().includes(needle);

  const match = items.find(
    (t) =>
      (has(t.memo) || has(t.message)) &&
      Math.abs(Number(t.amount)) + 1e-9 >= minAmount
  );
  if (!match) return { ok: true, found: false };

  const ign = await ignForUuid(match.initiatorUuid);
  return {
    ok: true,
    found: true,
    ign,
    uuid: match.initiatorUuid || null,
    txnId: match.txnId,
    amount: match.amount,
  };
}

// Send a payment to a player by IGN (firm account -> player). Money is a
// decimal string; idempotency key makes retries safe.
export async function payToPlayer(playerName, amount, memo) {
  const jwt = TOKEN();
  if (!jwt) return { ok: false, error: "NO_TOKEN" };
  const body = {
    toPlayerName: playerName,
    amount: Number(amount).toFixed(2),
    memo: memo || "Revolution Realty payout",
  };
  const from = FROM_ACCOUNT_ID();
  if (from) body.fromAccountId = Number(from);

  let res;
  try {
    res = await fetch(`${BASE}/api/v1/transfers/to-player`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: "NETWORK", message: e.message };
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, txnId: data.txnId };
  return { ok: false, status: res.status, error: data.error || `HTTP_${res.status}`, message: data.message || "" };
}
