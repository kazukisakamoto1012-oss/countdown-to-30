// 30歳まで、あと — Cloudflare Worker
//
// サイトの代わりに Google ドキュメントへ日記を書き込む、小さなサーバー。
// Google の合鍵（リフレッシュトークン）や秘密の鍵はブラウザに置けないので、ここで預かる。
//
// 受け付ける URL
//   GET  /hello              動作確認
//   POST /google/connect     Google の許可画面の URL を返す
//   GET  /google/callback    Google から戻ってきたときに合鍵を受け取って保存する
//   GET  /google/status      連携しているかどうか
//   POST /google/disconnect  連携を解除する
//   POST /diary/sync         指定した月の日記を Google ドキュメントに書き直す

import { buildMonthContent } from "./markdown.js";

// このサイト以外のページからは呼べないようにする（CORS）
const ALLOWED_ORIGINS = ["https://kazukisakamoto1012-oss.github.io", "http://localhost:8000"];
const SITE_URL = "https://kazukisakamoto1012-oss.github.io/countdown-to-30/";

const GOOGLE_SCOPE = "https://www.googleapis.com/auth/drive.file"; // このアプリが作ったファイルだけ扱える
const DOC_TITLE = "30歳までの日記";
const TAB_EMOJI = "📔";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request.headers.get("Origin"));

    // ブラウザが本番のお願いの前に送ってくる「確認」（プリフライト）
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      const route = `${request.method} ${url.pathname}`;
      let response;
      if (route === "GET /hello") response = hello(request, url);
      else if (route === "POST /google/connect") response = await connect(request, env, url);
      else if (route === "GET /google/callback") {
        return await callback(env, url).catch((err) => {
          console.error(err);
          return Response.redirect(`${SITE_URL}?google=error`, 302);
        });
      }
      else if (route === "GET /google/status") response = await status(request, env);
      else if (route === "POST /google/disconnect") response = await disconnect(request, env);
      else if (route === "POST /diary/sync") response = await sync(request, env);
      else response = json({ error: "not_found" }, 404);
      return withHeaders(response, cors);
    } catch (err) {
      if (err instanceof HttpError) return withHeaders(json({ error: err.code }, err.status), cors);
      console.error(err);
      return withHeaders(json({ error: "server_error" }, 500), cors);
    }
  },
};

// ===== 各 URL の処理 =====

function hello(request, url) {
  const message = [
    "こんにちは！ Cloudflare Workers から返事しています。",
    `アクセスしたパス：${url.pathname}`,
    `あなたのいる国：${request.cf?.country ?? "不明"}`,
    `返事をしたデータセンター：${request.cf?.colo ?? "不明"}`,
  ].join("\n");
  return new Response(message, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

// ① 連携ボタン → Google の許可画面の URL を作って返す
async function connect(request, env, url) {
  const user = await getUser(request, env);
  const body = await request.json().catch(() => ({}));
  const returnTo = isAllowedReturn(body.returnTo) ? body.returnTo : SITE_URL;

  // state：「誰が」「どこへ戻るか」を署名付きで Google に預け、戻ってきたときに改ざんがないか確かめる
  const state = await signState(env, { uid: user.id, returnTo, exp: Date.now() + 10 * 60 * 1000 });

  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${url.origin}/google/callback`,
    response_type: "code",
    scope: GOOGLE_SCOPE,
    access_type: "offline", // 合鍵（リフレッシュトークン）をもらう
    prompt: "consent",      // 毎回確認画面を出して、確実に合鍵を受け取る
    login_hint: user.email || "",
    state,
  });
  return json({ url: auth.toString() });
}

// ③④ Google から戻ってきた → 引換券（code）を合鍵に交換して、暗号化して保存
async function callback(env, url) {
  const payload = await verifyState(env, url.searchParams.get("state"));
  if (!payload) {
    console.error("invalid state", url.searchParams.get("error") || "");
    return Response.redirect(`${SITE_URL}?google=error`, 302);
  }
  const back = (result) => Response.redirect(`${payload.returnTo}?google=${result}`, 302);

  const code = url.searchParams.get("code");
  if (!code) return back("cancelled"); // 許可画面で「キャンセル」した

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  const token = await res.json();
  if (!res.ok || !token.refresh_token) {
    // 失敗の理由だけをログに残す（鍵の中身は出さない）
    console.error("token exchange failed", res.status, token.error, token.error_description, "has_refresh_token:", Boolean(token.refresh_token));
    return back("error");
  }
  // 許可画面でドライブへのチェックを外された場合
  if (!String(token.scope || "").split(" ").includes(GOOGLE_SCOPE)) {
    console.error("scope missing", token.scope);
    return back("scope");
  }

  await saveConnection(env, {
    user_id: payload.uid,
    refresh_token_encrypted: await encrypt(env, token.refresh_token),
    updated_at: new Date().toISOString(),
  });
  return back("connected");
}

async function status(request, env) {
  const user = await getUser(request, env);
  const conn = await getConnection(env, user.id);
  return json({ connected: Boolean(conn), docUrl: conn?.doc_id ? docUrl(conn.doc_id) : null });
}

async function disconnect(request, env) {
  const user = await getUser(request, env);
  const conn = await getConnection(env, user.id);
  if (conn) {
    // Google 側でも合鍵を無効にする（ドキュメント自体はドライブに残る）
    const refreshToken = await decrypt(env, conn.refresh_token_encrypted);
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, { method: "POST" });
    await supabase(env, `google_connections?user_id=eq.${user.id}`, { method: "DELETE" });
  }
  return json({ connected: false });
}

// 日記を保存・削除したとき → その月のタブを最新の内容で書き直す
async function sync(request, env) {
  const user = await getUser(request, env);
  const body = await request.json().catch(() => ({}));
  const months = [...new Set(Array.isArray(body.months) ? body.months : [])]
    .filter((m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m))
    .slice(0, 120);
  if (months.length === 0) throw new HttpError(400, "bad_request");

  const conn = await getConnection(env, user.id);
  if (!conn) throw new HttpError(409, "not_connected");
  const accessToken = await getAccessToken(env, conn);

  const ctx = { accessToken, docId: conn.doc_id, monthTabs: { ...conn.month_tabs } };
  let tabId = null;
  for (const month of months.sort()) {
    const entries = await supabase(
      env,
      `diaries?select=entry_date,body&entry_date=gte.${month}-01&entry_date=lt.${nextMonth(month)}-01&order=entry_date.asc`,
      { userToken: user.token } // 本人のログイン情報で読む（RLS で本人の日記だけが返る）
    );
    tabId = await writeMonth(ctx, month, entries);
  }

  await saveConnection(env, {
    user_id: user.id,
    refresh_token_encrypted: conn.refresh_token_encrypted,
    doc_id: ctx.docId,
    month_tabs: ctx.monthTabs,
    updated_at: new Date().toISOString(),
  });
  return json({ docUrl: docUrl(ctx.docId, tabId) });
}

// ===== Google ドキュメントへの書き込み =====

async function writeMonth(ctx, month, entries) {
  let doc = ctx.docId ? await getDocument(ctx) : null;
  if (!doc) {
    // ドキュメントがまだない（または削除された）→ 新しく作る
    const created = await docsApi(ctx, "", { method: "POST", body: { title: DOC_TITLE } });
    ctx.docId = created.documentId;
    ctx.monthTabs = {};
    doc = await getDocument(ctx);
  }

  const tabs = doc.tabs || [];
  const tabExists = (id) => tabs.some((t) => t.tabProperties.tabId === id);
  // 手で削除されたタブは忘れる
  for (const [m, id] of Object.entries(ctx.monthTabs)) if (!tabExists(id)) delete ctx.monthTabs[m];

  const title = `${Number(month.slice(0, 4))}年${Number(month.slice(5))}月`;
  let tabId = ctx.monthTabs[month];
  let endIndex = 2; // 空のタブの本文の終わり

  if (tabId) {
    endIndex = bodyEndIndex(tabs.find((t) => t.tabProperties.tabId === tabId));
  } else {
    const usedIds = Object.values(ctx.monthTabs);
    const blank = tabs.length === 1 && !usedIds.includes(tabs[0].tabProperties.tabId) && bodyEndIndex(tabs[0]) <= 2;
    if (blank) {
      // 作ったばかりのドキュメントの最初のタブを、この月のタブとして使う
      tabId = tabs[0].tabProperties.tabId;
      await docsApi(ctx, ":batchUpdate", {
        method: "POST",
        body: { requests: [{ updateDocumentTabProperties: { tabProperties: { tabId, title, iconEmoji: TAB_EMOJI }, fields: "title,iconEmoji" } }] },
      });
    } else {
      // 月の順に並ぶ位置に新しいタブを追加する
      const index = Object.keys(ctx.monthTabs).filter((m) => m < month).length;
      const res = await docsApi(ctx, ":batchUpdate", {
        method: "POST",
        body: { requests: [{ addDocumentTab: { tabProperties: { title, iconEmoji: TAB_EMOJI, index } } }] },
      });
      tabId = res.replies[0].addDocumentTab.tabProperties.tabId;
    }
    ctx.monthTabs[month] = tabId;
  }

  // 中身を全部消して、最新の日記を書き直す
  const { text, styles } = buildMonthContent(entries);
  const range = (start, end) => ({ startIndex: start + 1, endIndex: end + 1, tabId });
  const whole = range(0, text.length);
  const requests = [];
  if (endIndex - 1 > 1) requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1, tabId } } });
  requests.push(
    { insertText: { location: { index: 1, tabId }, text } },
    // 前の書式が残らないよう、いったん普通の文章に戻す
    { updateParagraphStyle: { range: whole, paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType,indentStart,indentFirstLine" } },
    { deleteParagraphBullets: { range: whole } },
    { updateTextStyle: { range: whole, textStyle: {}, fields: "bold,italic,foregroundColor" } }
  );
  for (const s of styles) {
    const r = range(s.start, s.end);
    if (s.type === "heading") {
      requests.push({ updateParagraphStyle: { range: r, paragraphStyle: { namedStyleType: s.style }, fields: "namedStyleType" } });
    } else if (s.type === "bullet" || s.type === "number") {
      // 箇条書きにすると行頭のタブが消えて位置がずれるので、ほかの書式を付け終えてから、後ろから順に付ける
      continue;
    } else if (s.type === "quote") {
      const indent = { magnitude: 18, unit: "PT" };
      requests.push(
        { updateParagraphStyle: { range: r, paragraphStyle: { indentStart: indent, indentFirstLine: indent }, fields: "indentStart,indentFirstLine" } },
        { updateTextStyle: { range: r, textStyle: { italic: true, foregroundColor: { color: { rgbColor: { red: 0.45, green: 0.45, blue: 0.45 } } } }, fields: "italic,foregroundColor" } }
      );
    } else if (s.type === "bold") {
      requests.push({ updateTextStyle: { range: r, textStyle: { bold: true }, fields: "bold" } });
    }
  }
  const lists = styles.filter((s) => s.type === "bullet" || s.type === "number").sort((x, y) => y.start - x.start);
  for (const s of lists) {
    const bulletPreset = s.type === "bullet" ? "BULLET_DISC_CIRCLE_SQUARE" : "NUMBERED_DECIMAL_ALPHA_ROMAN";
    requests.push({ createParagraphBullets: { range: range(s.start, s.end), bulletPreset } });
  }
  await docsApi(ctx, ":batchUpdate", { method: "POST", body: { requests } });
  return tabId;
}

function nextMonth(month) {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

function bodyEndIndex(tab) {
  const content = tab?.documentTab?.body?.content || [];
  return content.length ? content[content.length - 1].endIndex : 2;
}

const docUrl = (docId, tabId) => `https://docs.google.com/document/d/${docId}/edit${tabId ? `?tab=${tabId}` : ""}`;

async function getDocument(ctx) {
  try {
    return await docsApi(ctx, `/${ctx.docId}?includeTabsContent=true`);
  } catch (err) {
    if (err.status === 404 || err.status === 403) return null; // 削除された・別アカウントで作ったもの
    throw err;
  }
}

async function docsApi(ctx, path, { method = "GET", body } = {}) {
  const target = path.startsWith(":") ? `/${ctx.docId}${path}` : path;
  const res = await fetch(`https://docs.googleapis.com/v1/documents${target}`, {
    method,
    headers: { Authorization: `Bearer ${ctx.accessToken}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = new Error(`Google Docs API ${res.status}: ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// 合鍵（リフレッシュトークン）から、1時間だけ使える鍵（アクセストークン）をもらう
async function getAccessToken(env, conn) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: await decrypt(env, conn.refresh_token_encrypted),
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (res.ok) return data.access_token;
  if (data.error === "invalid_grant") {
    // Google 側で連携が取り消された → 保存している合鍵も消して、連携し直してもらう
    await supabase(env, `google_connections?user_id=eq.${conn.user_id}`, { method: "DELETE" });
    throw new HttpError(409, "not_connected");
  }
  throw new Error(`Google token ${res.status}: ${JSON.stringify(data)}`);
}

// ===== Supabase =====

// サイトから届いたログイン情報（アクセストークン）が本物か、Supabase に確かめる
async function getUser(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new HttpError(401, "unauthorized");
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new HttpError(401, "unauthorized");
  const user = await res.json();
  return { id: user.id, email: user.email, token };
}

// userToken を渡すと「その人として」（RLS あり）、渡さないと secret key で（RLS なし）読み書きする
async function supabase(env, path, { method = "GET", body, userToken, prefer } = {}) {
  const headers = { "content-type": "application/json" };
  if (userToken) {
    headers.apikey = env.SUPABASE_PUBLISHABLE_KEY;
    headers.Authorization = `Bearer ${userToken}`;
  } else {
    headers.apikey = env.SUPABASE_SECRET_KEY;
  }
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getConnection(env, userId) {
  const rows = await supabase(env, `google_connections?user_id=eq.${userId}&select=*`);
  return rows[0] || null;
}

function saveConnection(env, row) {
  return supabase(env, "google_connections?on_conflict=user_id", {
    method: "POST",
    body: row,
    prefer: "resolution=merge-duplicates,return=minimal",
  });
}

// ===== 署名と暗号化 =====

const encoder = new TextEncoder();
const toBase64Url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64 = (str) => Uint8Array.from(atob(str.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function hmac(env, data) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.STATE_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toBase64Url(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}

async function signState(env, payload) {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(env, body)}`;
}

async function verifyState(env, state) {
  if (!state || !state.includes(".")) return null;
  const [body, sig] = state.split(".");
  const expected = await hmac(env, body);
  // 文字を1つずつ比べ終わるまで結果を出さない（時間の差から推測されないように）
  let diff = sig.length ^ expected.length;
  for (let i = 0; i < Math.min(sig.length, expected.length); i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  const payload = JSON.parse(new TextDecoder().decode(fromBase64(body)));
  if (payload.exp < Date.now() || !isAllowedReturn(payload.returnTo)) return null;
  return payload;
}

// 合鍵はそのまま保存せず、Worker だけが知っている鍵（ENCRYPTION_KEY）で暗号化しておく
async function aesKey(env) {
  return crypto.subtle.importKey("raw", fromBase64(env.ENCRYPTION_KEY), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encrypt(env, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), encoder.encode(plain));
  return `${toBase64Url(iv)}.${toBase64Url(data)}`;
}

async function decrypt(env, stored) {
  const [iv, data] = stored.split(".").map(fromBase64);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await aesKey(env), data);
  return new TextDecoder().decode(plain);
}

// ===== 小さな道具 =====

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function isAllowedReturn(value) {
  return typeof value === "string" && ALLOWED_ORIGINS.some((o) => value === o + "/" || value.startsWith(o + "/"));
}

function corsHeaders(origin) {
  if (!ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function withHeaders(response, extra) {
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries(extra)) res.headers.set(k, v);
  return res;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
