// Google OAuth 2.0 + YouTube Data API v3 için minimal istemci. Yerleşik fetch (Node 20+)
// dışında bağımlılık YOK: kullanılan uç nokta sayısı üç (token, liveStreams, ileride
// liveBroadcasts), bunun için googleapis (~15 MB) ya da google-auth-library gereksiz.
//
// Akış seçimi: loopback redirect (http://127.0.0.1:<port>) + PKCE.
// OOB akışı (urn:ietf:wg:oauth:2.0:oob) Ekim 2022'den beri engelli — invalid_request
// döner, yani "consent URL üret, kodu yapıştır"ın klasik biçimi artık yok. Desktop
// client'ta loopback izinli ve port önceden kaydedilmek zorunda değil. Ayrıntı: KARARLAR.md
const crypto = require('crypto');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://www.googleapis.com/youtube/v3';
// .readonly transition/insert için yetmez — tam youtube scope'u gerekiyor.
const SCOPE = 'https://www.googleapis.com/auth/youtube';

const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// PKCE (S256): code_verifier rastgele, challenge onun SHA-256'sı. Desktop akışında
// authorization code'un araya girenler tarafından kullanılmasını engeller.
function createPkcePair() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function buildConsentUrl({ clientId, redirectUri, codeChallenge, scope = SCOPE }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    // offline + consent: refresh token'ın MUTLAKA dönmesi için. prompt=consent olmadan
    // aynı client'a ikinci izinde Google refresh_token'ı atlar ve elde sadece 1 saatlik
    // access token kalır — sessiz ve kafa karıştırıcı bir başarısızlık.
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    include_granted_scopes: 'true',
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

// Google'ın hata gövdesi { error, error_description } — mesajı okunur hale getirir.
async function postToken(body) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`token uç noktası JSON olmayan yanıt verdi (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const detail = data.error_description || data.error || `HTTP ${res.status}`;
    // invalid_grant en sık iki sebepten gelir; ikisi de teşhis edilmezse saatler yakar.
    const hint = data.error === 'invalid_grant'
      ? '\n  Olası sebep: refresh token iptal edildi/süresi doldu (OAuth consent screen ' +
        '"Testing" modundaysa token 7 GÜNDE expire olur — "In production"a al), ' +
        'ya da authorization code bir kez kullanıldı/süresi geçti.'
      : '';
    throw new Error(`OAuth hatası: ${detail}${hint}`);
  }
  return data;
}

function exchangeCodeForTokens({ clientId, clientSecret, code, codeVerifier, redirectUri }) {
  return postToken({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
}

async function getAccessToken({ clientId, clientSecret, refreshToken }) {
  const data = await postToken({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  if (!data.access_token) throw new Error('token yanıtında access_token yok');
  return { accessToken: data.access_token, expiresInSeconds: data.expires_in ?? null, scope: data.scope ?? null };
}

// YouTube Data API çağrısı. Hata gövdesindeki gerçek mesajı yukarı taşır: API'nin
// "quotaExceeded" / "liveStreamingNotEnabled" gibi ayrımları teşhis için kritik.
async function apiRequest({ accessToken, path: apiPath, params = {}, method = 'GET', body = null }) {
  const url = new URL(`${API_BASE}/${apiPath}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`YouTube API JSON olmayan yanıt verdi (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
  }
  if (!res.ok) {
    const err = data?.error;
    const reason = err?.errors?.[0]?.reason;
    const detail = err?.message || `HTTP ${res.status}`;
    throw new Error(`YouTube API hatası (${apiPath}): ${detail}${reason ? ` [reason=${reason}]` : ''}`);
  }
  return data;
}

// Kanalın kalıcı stream'leri (part=cdn: ingestionInfo.streamName = stream key).
function listLiveStreams({ accessToken }) {
  return apiRequest({
    accessToken,
    path: 'liveStreams',
    params: { part: 'id,snippet,cdn,status', mine: 'true', maxResults: '50' },
  });
}

module.exports = {
  SCOPE, AUTH_ENDPOINT, TOKEN_ENDPOINT, API_BASE,
  createPkcePair, buildConsentUrl, exchangeCodeForTokens, getAccessToken,
  apiRequest, listLiveStreams,
};
