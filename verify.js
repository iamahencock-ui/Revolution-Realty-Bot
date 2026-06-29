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

export function verifyEnabled() {
  return !!(TOKEN() && VERIFY_ACCOUNT_ID());
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
export async function findVerificationPayment(code, minAmount = 0.01) {
  const acct = VERIFY_ACCOUNT_ID();
  if (!acct) return { ok: false, error: "NO_ACCOUNT" };

  const r = await apiGet(`/api/v1/accounts/${acct}/transactions?limit=50`);
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
