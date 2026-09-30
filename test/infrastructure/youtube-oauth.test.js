// OAuth/API katmanı testleri: ağ yok, global fetch sahteleniyor.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  createPkcePair, buildConsentUrl, exchangeCodeForTokens, getAccessToken,
  listLiveStreams, SCOPE,
} = require('../../src/infrastructure/youtube-oauth');

// Sahte fetch: çağrıları kaydeder, sıradaki yanıtı döner.
function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const fn = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const next = queue.shift();
    if (!next) throw new Error('beklenmeyen fetch çağrısı');
    return {
      ok: next.status === undefined ? true : next.status < 400,
      status: next.status ?? 200,
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)),
    };
  };
  return { fn, calls };
}

function withFetch(responses, body) {
  const { fn, calls } = fakeFetch(responses);
  const original = global.fetch;
  global.fetch = fn;
  return Promise.resolve(body(calls)).finally(() => { global.fetch = original; });
}

test('PKCE: challenge, verifier\'ın base64url SHA-256\'sı ve URL-güvenli', () => {
  const { verifier, challenge } = createPkcePair();
  const expected = crypto.createHash('sha256').update(verifier).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(challenge, expected);
  assert.match(verifier, /^[A-Za-z0-9_-]+$/); // = + / içermemeli
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(createPkcePair().verifier, verifier); // her çağrı farklı
});

test('consent URL: offline + prompt=consent + S256 + tam youtube scope', () => {
  const url = new URL(buildConsentUrl({
    clientId: 'cid', redirectUri: 'http://127.0.0.1:8765', codeChallenge: 'chal',
  }));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const p = url.searchParams;
  assert.equal(p.get('client_id'), 'cid');
  assert.equal(p.get('redirect_uri'), 'http://127.0.0.1:8765');
  assert.equal(p.get('response_type'), 'code');
  // access_type=offline + prompt=consent olmadan refresh_token dönmez (sessiz hata).
  assert.equal(p.get('access_type'), 'offline');
  assert.equal(p.get('prompt'), 'consent');
  assert.equal(p.get('code_challenge'), 'chal');
  assert.equal(p.get('code_challenge_method'), 'S256');
  // .readonly transition/insert için yetmez.
  assert.equal(p.get('scope'), SCOPE);
  assert.doesNotMatch(SCOPE, /readonly/);
});

test('consent URL: OOB redirect kullanılmıyor (Google 2022\'den beri engelliyor)', () => {
  const url = buildConsentUrl({ clientId: 'c', redirectUri: 'http://127.0.0.1:8765', codeChallenge: 'x' });
  assert.doesNotMatch(url, /oauth:2\.0:oob/);
});

test('code takası: code_verifier ve redirect_uri gönderilir', () => withFetch(
  [{ body: { refresh_token: 'rt', access_token: 'at' } }],
  async (calls) => {
    const tokens = await exchangeCodeForTokens({
      clientId: 'cid', clientSecret: 'sec', code: 'the-code',
      codeVerifier: 'ver', redirectUri: 'http://127.0.0.1:8765',
    });
    assert.equal(tokens.refresh_token, 'rt');
    assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
    const sent = new URLSearchParams(calls[0].options.body);
    assert.equal(sent.get('grant_type'), 'authorization_code');
    assert.equal(sent.get('code'), 'the-code');
    assert.equal(sent.get('code_verifier'), 'ver');
    assert.equal(sent.get('redirect_uri'), 'http://127.0.0.1:8765');
  },
));

test('access token: refresh_token grant, expires_in ve scope taşınır', () => withFetch(
  [{ body: { access_token: 'at', expires_in: 3599, scope: SCOPE } }],
  async (calls) => {
    const r = await getAccessToken({ clientId: 'c', clientSecret: 's', refreshToken: 'rt' });
    assert.deepEqual(r, { accessToken: 'at', expiresInSeconds: 3599, scope: SCOPE });
    const sent = new URLSearchParams(calls[0].options.body);
    assert.equal(sent.get('grant_type'), 'refresh_token');
    assert.equal(sent.get('refresh_token'), 'rt');
  },
));

// invalid_grant'ın en sık sebebi Testing modundaki 7 günlük expire — mesaj onu söylemeli,
// yoksa teşhis saatler yakar.
test('invalid_grant: 7 gün / Testing modu ipucu mesaja girer', () => withFetch(
  [{ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }],
  async () => {
    await assert.rejects(
      getAccessToken({ clientId: 'c', clientSecret: 's', refreshToken: 'rt' }),
      (err) => /Token has been expired/.test(err.message) && /7 GÜNDE/.test(err.message) && /In production/.test(err.message),
    );
  },
));

test('token uç noktası JSON olmayan yanıt verirse anlaşılır hata', () => withFetch(
  [{ status: 502, body: '<html>bad gateway</html>' }],
  async () => {
    await assert.rejects(
      getAccessToken({ clientId: 'c', clientSecret: 's', refreshToken: 'rt' }),
      /JSON olmayan yanıt.*502/s,
    );
  },
));

test('access_token yoksa hata (sessizce undefined dönmez)', () => withFetch(
  [{ body: { expires_in: 3599 } }],
  async () => {
    await assert.rejects(getAccessToken({ clientId: 'c', clientSecret: 's', refreshToken: 'rt' }),
      /access_token yok/);
  },
));

test('liveStreams.list: part=cdn ve mine=true, Bearer header', () => withFetch(
  [{ body: { items: [] } }],
  async (calls) => {
    await listLiveStreams({ accessToken: 'at' });
    const url = new URL(calls[0].url);
    assert.equal(url.origin + url.pathname, 'https://www.googleapis.com/youtube/v3/liveStreams');
    // cdn olmadan ingestionInfo.streamName gelmez, yani key eşleştirmesi yapılamaz.
    assert.match(url.searchParams.get('part'), /cdn/);
    assert.equal(url.searchParams.get('mine'), 'true');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer at');
  },
));

test('API hatası: mesaj ve reason yukarı taşınır', () => withFetch(
  [{ status: 403, body: { error: { message: 'The request cannot be completed', errors: [{ reason: 'quotaExceeded' }] } } }],
  async () => {
    await assert.rejects(listLiveStreams({ accessToken: 'at' }),
      /liveStreams.*cannot be completed.*reason=quotaExceeded/s);
  },
));
