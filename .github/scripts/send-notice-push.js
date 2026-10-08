// プッシュ通知を送るスクリプト（GitHub Actions から実行）
//   node send-notice-push.js          … 新しいお知らせ／共有課題／年間予定があれば通知（5分おき）
//   node send-notice-push.js daily    … 期限が3日以内の共有課題があれば通知（毎朝）
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

const SITE_URL = 'https://uru55.github.io/timetable/';
// この時間より古い投稿は通知しない（Actionsが止まっていたときの古い通知を防ぐ）
const WINDOW_MS = 6 * 60 * 60 * 1000;
// 毎朝の通知で「期限が近い」とみなす日数
const DUE_DAYS = 3;

const DAY_NAMES = { Mon: '月', Tue: '火', Wed: '水', Thu: '木', Fri: '金' };

// ---------- 文面づくり（テストしやすいよう、通信しない関数にしてある） ----------
function subjectLabel(v) {
  if (v.subject) return v.subject;
  const m = /^(\w+)_(\d+)$/.exec(v.subjectKey || '');
  return m ? `${DAY_NAMES[m[1]] || m[1]}曜${m[2]}限` : '課題';
}
function fmtMD(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return `${m}/${d}`;
}
function noticeMessage(v) {
  return { title: '新しいお知らせ', body: String(v.title || '').slice(0, 120) };
}
function todoMessage(v) {
  const due = v.dueDate ? `（期限 ${fmtMD(v.dueDate)}）` : '';
  return { title: '新しい課題が追加されました', body: `${subjectLabel(v)}：${v.text || ''}${due}`.slice(0, 120) };
}
function eventMessage(v) {
  return { title: '年間予定が追加されました', body: `${v.date || ''} ${v.desc || ''}`.trim().slice(0, 120) };
}
function changeMessage(v) {
  const label = { cancel: '休講', room: '教室変更', makeup: '補講' }[v.type] || '変更';
  let date = '';
  if (v.date) {
    const [, m, d] = v.date.split('-').map(Number);
    const w = '日月火水木金土'[new Date(v.date + 'T00:00:00Z').getUTCDay()];
    date = `${m}/${d}(${w})`;
  }
  const per = v.period ? `${v.period}限` : '';
  const sub = v.subject || '';
  let tail = label;
  if (v.type === 'room' && v.room) tail += ` → ${v.room}`;
  if (v.type === 'makeup' && v.room) tail = `補講（教室 ${v.room}）`;
  return { title: `${label}のお知らせ`, body: `${date}${per} ${sub} ${tail}`.replace(/\s+/g, ' ').trim().slice(0, 120) };
}
function todayJST(now = Date.now()) {
  return new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(toIso + 'T00:00:00Z') - Date.parse(fromIso + 'T00:00:00Z')) / 86400000);
}
function dueWord(diff) {
  return diff === 0 ? '今日' : diff === 1 ? '明日' : `あと${diff}日`;
}
function dailyMessage(todos, today) {
  const items = todos
    .filter((t) => t.dueDate)
    .map((t) => ({ ...t, diff: daysBetween(today, t.dueDate) }))
    .filter((t) => t.diff >= 0 && t.diff <= DUE_DAYS)
    .sort((a, b) => a.diff - b.diff || String(a.dueDate).localeCompare(b.dueDate));
  if (items.length === 0) return null;
  const lines = items.slice(0, 3).map((t) => `${subjectLabel(t)}「${t.text}」${dueWord(t.diff)}`);
  const more = items.length > 3 ? ` ほか${items.length - 3}件` : '';
  return { title: `共有課題の期限が近づいています（${items.length}件）`, body: (lines.join(' / ') + more).slice(0, 180) };
}

// ---------- 送信 ----------
async function sendToAll(tokens, msg, tag, invalid) {
  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    const res = await getMessaging().sendEachForMulticast({
      tokens: chunk,
      data: { title: msg.title, body: msg.body, url: SITE_URL, tag },
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
    console.log(`  「${msg.title}」 送信 ${res.successCount} 成功 / ${res.failureCount} 失敗`);
  }
}

async function loadTokens(db) {
  const snap = await db.collection('pushTokens').get();
  return snap.docs.map((d) => d.id);
}
async function cleanup(db, invalid) {
  await Promise.all([...invalid].map((t) => db.collection('pushTokens').doc(t).delete()));
  if (invalid.size) console.log(`無効な宛先を ${invalid.size} 件削除しました`);
}

// 新しい投稿（createdAtが新しく、pushedAtが無いもの）を集める
async function newDocs(db, collection) {
  const since = Timestamp.fromMillis(Date.now() - WINDOW_MS);
  const snap = await db.collection(collection).where('createdAt', '>', since).get();
  return snap.docs
    .filter((d) => !d.get('pushedAt'))
    .sort((a, b) => a.get('createdAt').toMillis() - b.get('createdAt').toMillis());
}

async function runNew(db) {
  const jobs = [
    ['notices', noticeMessage, 'notice-'],
    ['sharedTodos', todoMessage, 'todo-'],
    ['events', eventMessage, changeMessage, 'event-'],
    ['changes', changeMessage, 'change-'],
  ];
  const found = [];
  for (const [col, build, prefix] of jobs) {
    (await newDocs(db, col)).forEach((d) => found.push({ doc: d, msg: build(d.data()), tag: prefix + d.id }));
  }
  if (found.length === 0) {
    console.log('新しい投稿はありません');
    return;
  }
  const tokens = await loadTokens(db);
  console.log(`新しい投稿 ${found.length} 件 / 送信先 ${tokens.length} 台`);
  const invalid = new Set();
  for (const f of found) {
    await sendToAll(tokens, f.msg, f.tag, invalid);
    // 送信できたら「通知済み」の印を付ける（次回以降は送らない）
    await f.doc.ref.update({ pushedAt: FieldValue.serverTimestamp() });
  }
  await cleanup(db, invalid);
}

async function runDaily(db) {
  const today = todayJST();
  const snap = await db.collection('sharedTodos').get();
  const msg = dailyMessage(snap.docs.map((d) => d.data()), today);
  if (!msg) {
    console.log(`${today}：期限が${DUE_DAYS}日以内の共有課題はありません`);
    return;
  }
  const tokens = await loadTokens(db);
  console.log(`${today}：${msg.title} / 送信先 ${tokens.length} 台`);
  const invalid = new Set();
  await sendToAll(tokens, msg, 'due-' + today, invalid);
  await cleanup(db, invalid);
}

async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.error('FIREBASE_SERVICE_ACCOUNT が設定されていません');
    process.exit(1);
  }
  let account;
  try {
    account = JSON.parse(raw);
  } catch (e) {
    console.error('FIREBASE_SERVICE_ACCOUNT がJSONとして読めません。鍵ファイルの中身を全部貼り直してください');
    process.exit(1);
  }
  initializeApp({ credential: cert(account) });
  const db = getFirestore();
  if (process.argv[2] === 'daily') await runDaily(db);
  else await runNew(db);
}

module.exports = { noticeMessage, todoMessage, eventMessage, changeMessage, dailyMessage, todayJST, daysBetween };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
