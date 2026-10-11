// 日記（マークダウン）を Google ドキュメント用に変換する部分

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

// 日記（マークダウン）を、Google ドキュメント用の「文章」と「書式の位置」に変換する
export function buildMonthContent(entries) {
  let text = "";
  const styles = [];
  const addLine = (line) => {
    const start = text.length;
    text += line + "\n";
    return [start, text.length];
  };

  if (entries.length === 0) {
    addLine("この月の日記はまだありません。");
    return { text, styles };
  }

  for (const entry of entries) {
    const [hs, he] = addLine(formatDate(entry.entry_date));
    styles.push({ type: "heading", style: "HEADING_2", start: hs, end: he });

    for (const raw of entry.body.split("\n")) {
      let line = raw;
      let block = null;
      let level = 0; // 箇条書きの字下げの深さ
      let m;
      if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
        block = { type: "heading", style: ["HEADING_3", "HEADING_4", "HEADING_5"][m[1].length - 1] };
        line = m[2];
      } else if ((m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s?(.*)$/))) {
        line = (m[1] === " " ? "☐ " : "☑ ") + m[2];
      } else if ((m = line.match(/^(\s*)[-*]\s+(.*)$/))) {
        block = { type: "bullet" };
        level = indentLevel(m[1]);
        line = m[2];
      } else if ((m = line.match(/^(\s*)\d+\.\s+(.*)$/))) {
        block = { type: "number" };
        level = indentLevel(m[1]);
        line = m[2];
      } else if ((m = line.match(/^>\s?(.*)$/))) {
        block = { type: "quote" };
        line = m[1];
      } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
        line = "―――――";
      }

      // **太字** の記号を取り除き、太字にする位置を覚えておく
      const bolds = [];
      let plain = "";
      let last = 0;
      for (const b of line.matchAll(/\*\*(.+?)\*\*/g)) {
        plain += line.slice(last, b.index);
        bolds.push([plain.length, plain.length + b[1].length]);
        plain += b[1];
        last = b.index + b[0].length;
      }
      plain += line.slice(last);

      // Google ドキュメントは、行頭のタブの数でリストの深さを決める（タブは箇条書きにするときに消える）
      const tabs = "\t".repeat(level);
      plain = tabs + plain;
      for (const b of bolds) { b[0] += tabs.length; b[1] += tabs.length; }

      const [start, end] = addLine(plain);
      for (const [bs, be] of bolds) styles.push({ type: "bold", start: start + bs, end: start + be });
      if (block) {
        // 続いている箇条書きは1つのリストにまとめる
        const prev = styles.findLast((s) => s.type !== "bold");
        if ((block.type === "bullet" || block.type === "number") && prev?.type === block.type && prev.end === start) prev.end = end;
        else styles.push({ ...block, start, end });
      }
    }
    addLine(""); // 日記と日記の間を1行あける
  }
  return { text, styles };
}

// 行頭の空白から字下げの深さを出す（スペース2つ、またはタブ1つで1段）
function indentLevel(space) {
  const width = space.replace(/\t/g, "  ").length;
  return Math.min(Math.floor(width / 2), 8);
}

function formatDate(str) {
  const [y, m, d] = str.split("-").map(Number);
  return `${m}月${d}日（${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`;
}
