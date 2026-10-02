// .env.youtube okuma: ayrı dosya sözleşmesi, ortam değişkeni önceliği, eksik key raporu.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadYoutubeCredentials, loadAlertChannel, CredentialsError,
} = require('../../src/infrastructure/youtube-credentials');

function tempRoot(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-cred-'));
  if (contents !== undefined) fs.writeFileSync(path.join(dir, '.env.youtube'), contents);
  return dir;
}

test('dosyadan okur', () => {
  const rootDir = tempRoot('YOUTUBE_CLIENT_ID=cid\nYOUTUBE_CLIENT_SECRET=sec\nYOUTUBE_REFRESH_TOKEN=rt\n');
  const c = loadYoutubeCredentials({ rootDir, env: {} });
  assert.equal(c.clientId, 'cid');
  assert.equal(c.clientSecret, 'sec');
  assert.equal(c.refreshToken, 'rt');
  assert.equal(c.credentialsPath, path.join(rootDir, '.env.youtube'));
});

test('ortam değişkeni dosyayı ezer (systemd/CI dosyasız çalışabilsin)', () => {
  const rootDir = tempRoot('YOUTUBE_CLIENT_ID=dosya\nYOUTUBE_CLIENT_SECRET=s\nYOUTUBE_REFRESH_TOKEN=r\n');
  const c = loadYoutubeCredentials({ rootDir, env: { YOUTUBE_CLIENT_ID: 'ortam' } });
  assert.equal(c.clientId, 'ortam');
  assert.equal(c.clientSecret, 's');
});

test('dosya yoksa ortam değişkenleriyle çalışır', () => {
  const rootDir = tempRoot(undefined);
  const c = loadYoutubeCredentials({
    rootDir,
    env: { YOUTUBE_CLIENT_ID: 'c', YOUTUBE_CLIENT_SECRET: 's', YOUTUBE_REFRESH_TOKEN: 'r' },
  });
  assert.equal(c.refreshToken, 'r');
});

test('boş değer eksik sayılır ve tüm eksikler tek mesajda listelenir', () => {
  const rootDir = tempRoot('YOUTUBE_CLIENT_ID=\nYOUTUBE_CLIENT_SECRET=   \n');
  assert.throws(() => loadYoutubeCredentials({ rootDir, env: {} }), (err) => {
    assert.ok(err instanceof CredentialsError);
    assert.match(err.message, /YOUTUBE_CLIENT_ID/);
    assert.match(err.message, /YOUTUBE_CLIENT_SECRET/);
    assert.match(err.message, /YOUTUBE_REFRESH_TOKEN/);
    assert.match(err.message, /cp \.env\.youtube\.example/); // ne yapacağını söylüyor
    return true;
  });
});

// get-refresh-token.js refresh token'ı henüz ÜRETİYOR: onu zorunlu tutmak scripti
// kullanılamaz hale getirirdi.
test('requireRefreshToken=false: token olmadan da yüklenir', () => {
  const rootDir = tempRoot('YOUTUBE_CLIENT_ID=c\nYOUTUBE_CLIENT_SECRET=s\n');
  const c = loadYoutubeCredentials({ rootDir, env: {}, requireRefreshToken: false });
  assert.equal(c.clientId, 'c');
  assert.equal(c.refreshToken, undefined);
});

test('refresh token eksikse mesaj get-refresh-token.js\'i gösterir', () => {
  const rootDir = tempRoot('YOUTUBE_CLIENT_ID=c\nYOUTUBE_CLIENT_SECRET=s\n');
  assert.throws(() => loadYoutubeCredentials({ rootDir, env: {} }), /get-refresh-token\.js/);
});

test('değerlerin kenar boşlukları kırpılır', () => {
  const rootDir = tempRoot('YOUTUBE_CLIENT_ID=  cid  \nYOUTUBE_CLIENT_SECRET=sec\nYOUTUBE_REFRESH_TOKEN=rt\n');
  assert.equal(loadYoutubeCredentials({ rootDir, env: {} }).clientId, 'cid');
});

// loadAlertChannel: yayın süreci (index.js) bildirim URL'sini buradan okuyor. YouTube
// kimliğini ZORUNLU tutmamalı — aksi halde yayın OAuth'a bağımlı hale gelirdi.
test('loadAlertChannel: YouTube kimliği hiç yokken de çalışır, atmaz', () => {
  const rootDir = tempRoot('ALERT_WEBHOOK_URL=https://ntfy.sh/gizli\n');
  assert.equal(loadAlertChannel({ rootDir, env: {} }).alertWebhookUrl, 'https://ntfy.sh/gizli');
});

test('loadAlertChannel: dosya hiç yoksa undefined döner (bildirim kanalı kapalı)', () => {
  const rootDir = tempRoot(); // .env.youtube yazılmadı
  assert.equal(loadAlertChannel({ rootDir, env: {} }).alertWebhookUrl, undefined);
});

test('loadAlertChannel: ortam değişkeni dosyayı ezer, boş değer "yok" sayılır', () => {
  const rootDir = tempRoot('ALERT_WEBHOOK_URL=https://ntfy.sh/dosya\n');
  assert.equal(
    loadAlertChannel({ rootDir, env: { ALERT_WEBHOOK_URL: 'https://ntfy.sh/ortam' } }).alertWebhookUrl,
    'https://ntfy.sh/ortam',
  );
  assert.equal(loadAlertChannel({ rootDir: tempRoot('ALERT_WEBHOOK_URL=   \n'), env: {} }).alertWebhookUrl, undefined);
});
