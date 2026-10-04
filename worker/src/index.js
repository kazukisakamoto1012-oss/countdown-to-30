// Cloudflare Workers の入口。
// 誰かがこの Worker の URL にアクセスするたびに fetch が呼ばれ、
// return した Response（返事）がその人に届く。
export default {
  async fetch(request) {
    const url = new URL(request.url);

    // request.cf には、Cloudflare が教えてくれるアクセスの情報が入っている
    const country = request.cf?.country ?? "不明"; // アクセスした人の国
    const colo = request.cf?.colo ?? "不明";       // 返事をしたデータセンター（空港コード）

    const message = [
      "こんにちは！ Cloudflare Workers から返事しています。",
      `アクセスしたパス：${url.pathname}`,
      `あなたのいる国：${country}`,
      `返事をしたデータセンター：${colo}`,
    ].join("\n");

    return new Response(message, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
