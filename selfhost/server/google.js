"use strict";
/* Google sign-in, authorization-code flow. Needs GOOGLE_CLIENT_ID and
   GOOGLE_CLIENT_SECRET; without them the endpoints report themselves as off and
   the game runs on anonymous sessions exactly as before. */

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const ISSUERS = ["accounts.google.com", "https://accounts.google.com"];

const configured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

function authUrl(redirectUri, state, nonce) {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    prompt: "select_account",
    access_type: "online"
  });
  return AUTH + "?" + p.toString();
}

async function exchange(code, redirectUri) {
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    })
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error("token exchange failed (" + res.status + "): " + detail.slice(0, 200));
  }
  return res.json();
}

/* The id_token came back on our own TLS call to Google's token endpoint, so the
   channel already vouches for it — OIDC Core 3.1.3.7 lets a confidential client
   skip signature checking in the code flow. The claims still have to be checked:
   that is what binds the token to this app rather than someone else's. */
function readIdToken(idToken, nonce) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw new Error("malformed id_token");
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch (e) {
    throw new Error("unreadable id_token");
  }
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(process.env.GOOGLE_CLIENT_ID)) throw new Error("id_token is for another app");
  if (!ISSUERS.includes(claims.iss)) throw new Error("id_token issuer mismatch");
  if (!claims.sub) throw new Error("id_token has no subject");
  if (Number(claims.exp) * 1000 < Date.now() - 60000) throw new Error("id_token expired");
  if (nonce && claims.nonce && claims.nonce !== nonce) throw new Error("nonce mismatch");
  return claims;
}

module.exports = { configured, authUrl, exchange, readIdToken };
