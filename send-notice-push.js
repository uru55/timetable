// 新しいお知らせ（notices）があれば、通知をオンにした全員にプッシュ通知を送る。
// GitHub Actions から5分おきに実行される。
const admin = require('firebase-admin');

const SITE_URL = 'https://uru55.github.io/timetable/';
// この時間より古いお知らせは通知しない（Actionsが止まっていたときの古い通知を防ぐ）
const WINDOW_MS = 6 * 60 * 60 * 1000;

async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.error('FIREBASE_SERVICE_ACCOUNT が設定されていません');
    process.exit(1);
  }
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  const db = admin.firestore();

  const since = admin.firestore.Timestamp.fromMillis(Date.now() - WINDOW_MS);
  const snap = await db.collection('notices').where('createdAt', '>', since).get();
  const targets = snap.docs
    .filter((d) => !d.get('pushedAt'))
    .sort((a, b) => a.get('createdAt').toMillis() - b.get('createdAt').toMillis());

  if (targets.length === 0) {
    console.log('新しいお知らせはありません');
    return;
  }

  const tokenSnap = await db.collection('pushTokens').get();
  const tokens = tokenSnap.docs.map((d) => d.id);
  console.log(`新しいお知らせ ${targets.length} 件 / 送信先 ${tokens.length} 台`);

  const invalid = new Set();
  for (const doc of targets) {
    const title = '新しいお知らせ';
    const body = String(doc.get('title') || '').slice(0, 120);

    for (let i = 0; i < tokens.length; i += 500) {
      const chunk = tokens.slice(i, i + 500);
      const res = await admin.messaging().sendEachForMulticast({
        tokens: chunk,
        data: { title, body, url: SITE_URL, tag: 'notice-' + doc.id },
        webpush: { headers: { Urgency: 'high' } },
      });
      res.responses.forEach((r, idx) => {
        if (r.success) return;
        const code = r.error && r.error.code;
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/invalid-argument'
        ) {
          invalid.add(chunk[idx]);
        }
      });
      console.log(`  送信 ${res.successCount} 成功 / ${res.failureCount} 失敗`);
    }
    // 送信できたら「通知済み」の印を付ける（次回以降は送らない）
    await doc.ref.update({ pushedAt: admin.firestore.FieldValue.serverTimestamp() });
  }

  // 使えなくなったトークンを掃除する
  await Promise.all([...invalid].map((t) => db.collection('pushTokens').doc(t).delete()));
  if (invalid.size) console.log(`無効な宛先を ${invalid.size} 件削除しました`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
