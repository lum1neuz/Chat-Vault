/**
 * The saved .html version of a chat: a self-contained reading page. The chat's Markdown is embedded as text and drawn by a
 * small renderer inside the page, so the file works offline, in any browser, and can hand the Markdown back with one click.
 * Nothing below may contain a backtick or a dollar-brace, because the page script lives in a String.raw template.
 */
const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<style>
:root{--bg:#fafaf9;--panel:#ffffff;--ink:#1c1917;--muted:#78716c;--line:#e7e5e4;--accent:#c2410c;--accent-soft:#fff1e8;--user:#f3f4f6;--code:#f5f5f4;--codeink:#1c1917;--shadow:0 1px 2px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.05)}
:root[data-theme=dark]{--bg:#0c0a09;--panel:#171412;--ink:#f5f5f4;--muted:#a8a29e;--line:#292524;--accent:#fb923c;--accent-soft:#2a1a10;--user:#1c1917;--code:#1c1917;--codeink:#f5f5f4;--shadow:none}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0c0a09;--panel:#171412;--ink:#f5f5f4;--muted:#a8a29e;--line:#292524;--accent:#fb923c;--accent-soft:#2a1a10;--user:#1c1917;--code:#1c1917;--codeink:#f5f5f4;--shadow:none}}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.7 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.top{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.top-in{max-width:820px;margin:0 auto;padding:12px 20px;display:flex;align-items:center;gap:12px}
.brand{font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.btn{font:inherit;font-size:13px;line-height:1;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 12px;cursor:pointer;transition:background .15s,border-color .15s}
.btn:hover{border-color:var(--muted)}
.btn.primary{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.wrap{max-width:820px;margin:0 auto;padding:36px 20px 96px}
main{min-width:0}
.hero{margin-bottom:28px}
.hero h1{font-size:30px;line-height:1.25;margin:0 0 12px;letter-spacing:-.02em}
.meta{display:flex;flex-wrap:wrap;gap:8px}
.chip{font-size:12px;color:var(--muted);background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:4px 10px}
.msg{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:6px 22px 8px;margin:16px 0;box-shadow:var(--shadow)}
.msg.user{background:var(--user)}
.msg>h2{display:flex;align-items:center;gap:10px;font-size:13px;margin:14px 0 6px;color:var(--muted);font-weight:600}
.msg>h2 .who{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:8px;background:var(--accent-soft);color:var(--accent);font-size:12px;font-weight:700}
.msg.user>h2 .who{background:var(--ink);color:var(--bg)}
.msg>h2 .name{color:var(--ink)}
.msg>h2 .when{margin-left:auto;font-weight:400;font-size:12px}
.msg h1,.msg h3,.msg h4,.msg h5,.msg h6{line-height:1.3;margin:1.4em 0 .5em;letter-spacing:-.01em}
.msg h1{font-size:1.4em}.msg h3{font-size:1.15em}.msg h4{font-size:1.02em}
.msg p{margin:.7em 0}
.msg a{color:var(--accent);text-underline-offset:3px}
.msg ul,.msg ol{padding-left:1.4em;margin:.7em 0}
.msg li{margin:.25em 0}
.msg blockquote{margin:1em 0;padding:.2em 1em;border-left:3px solid var(--accent);color:var(--muted);background:var(--accent-soft);border-radius:0 8px 8px 0}
.msg hr{border:0;border-top:1px solid var(--line);margin:1.6em 0}
.msg code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);color:var(--codeink);padding:2px 6px;border-radius:6px}
.codebox{position:relative;margin:1em 0}
.codebox pre{margin:0;background:var(--code);border:1px solid var(--line);border-radius:10px;padding:14px 16px;overflow:auto}
.codebox pre code{background:none;padding:0;font-size:13px;color:var(--codeink)}
.codebox .lang{position:absolute;top:8px;left:12px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.codebox pre.has-lang{padding-top:30px}
.codebox button{position:absolute;top:6px;right:6px;font-size:11px;padding:4px 8px;border-radius:6px;border:1px solid var(--line);background:var(--panel);color:var(--muted);cursor:pointer;opacity:0;transition:opacity .15s}
.codebox:hover button{opacity:1}
.tablebox{overflow:auto;margin:1em 0}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{border:1px solid var(--line);padding:8px 12px;text-align:left}
th{background:var(--code)}
.foot{margin-top:40px;color:var(--muted);font-size:12px;text-align:center}
@media (max-width:640px){.hero h1{font-size:24px}.msg{padding:4px 16px 6px}}
@media print{.top,.codebox button{display:none}.wrap{padding:0}.msg{box-shadow:none;break-inside:avoid-page}body{background:#fff}}
</style>
</head>
<body>
<header class="top"><div class="top-in">
<div class="brand">__TITLE__</div>
<button class="btn" id="copy-md">Copy Markdown</button>
<button class="btn" id="print">Print / PDF</button>
</div></header>
<div class="wrap">
<main>
<div class="hero"><h1>__TITLE__</h1><div class="meta">__META__</div></div>
<div id="chat"></div>
<p class="foot">Saved from ChatVault</p>
</main>
</div>
<script id="md" type="text/markdown">__MD__</script>
<script>
(function () {
  var BT = String.fromCharCode(96);
  var FENCE = BT + BT + BT;
  var source = document.getElementById("md").textContent.replace(/^\n/, "");

  function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  function inline(text) {
    var stash = [];
    var s = text.replace(new RegExp(BT + "([^" + BT + "]+)" + BT, "g"), function (m, c) {
      stash.push("<code>" + esc(c) + "</code>");
      return "\u0000" + (stash.length - 1) + "\u0000";
    });
    s = esc(s);
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    return s.replace(/\u0000(\d+)\u0000/g, function (m, i) { return stash[+i]; });
  }

  function isTableSep(l) { return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.indexOf("-") > -1; }
  function cells(l) { return l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (c) { return c.trim(); }); }

  function render(md) {
    var lines = md.split("\n"), out = [], i = 0;
    while (i < lines.length) {
      var line = lines[i];
      var t = line.trim();
      if (t.indexOf(FENCE) === 0) {
        var lang = t.slice(3).trim(), code = [];
        i++;
        while (i < lines.length && lines[i].trim().indexOf(FENCE) !== 0) { code.push(lines[i]); i++; }
        i++;
        out.push('<div class="codebox">' + (lang ? '<span class="lang">' + esc(lang) + "</span>" : "") + "<button>Copy</button><pre" + (lang ? ' class="has-lang"' : "") + "><code>" + esc(code.join("\n")) + "</code></pre></div>");
        continue;
      }
      var h = /^(#{1,6})\s+(.*)$/.exec(t);
      if (h) { out.push("<h" + h[1].length + ">" + inline(h[2]) + "</h" + h[1].length + ">"); i++; continue; }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { out.push("<hr>"); i++; continue; }
      if (t.charAt(0) === ">") {
        var q = [];
        while (i < lines.length && lines[i].trim().charAt(0) === ">") { q.push(lines[i].trim().replace(/^>\s?/, "")); i++; }
        out.push("<blockquote>" + render(q.join("\n")) + "</blockquote>");
        continue;
      }
      if (t.indexOf("|") > -1 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        var head = cells(t), rows = [];
        i += 2;
        while (i < lines.length && lines[i].trim().indexOf("|") > -1) { rows.push(cells(lines[i])); i++; }
        out.push('<div class="tablebox"><table><thead><tr>' + head.map(function (c) { return "<th>" + inline(c) + "</th>"; }).join("") + "</tr></thead><tbody>" +
          rows.map(function (r) { return "<tr>" + r.map(function (c) { return "<td>" + inline(c) + "</td>"; }).join("") + "</tr>"; }).join("") + "</tbody></table></div>");
        continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        var items = [];
        while (i < lines.length && (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
          var m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
          if (m) items.push({ depth: Math.floor(m[1].length / 2), ordered: /\d/.test(m[2]), text: m[3] });
          else items[items.length - 1].text += " " + lines[i].trim();
          i++;
        }
        var html = "", stack = [];
        items.forEach(function (it) {
          while (stack.length > it.depth + 1) html += "</li></" + stack.pop() + ">";
          if (stack.length === it.depth + 1) html += "</li>";
          while (stack.length < it.depth + 1) { var tag = it.ordered ? "ol" : "ul"; stack.push(tag); html += "<" + tag + ">"; }
          html += "<li>" + inline(it.text);
        });
        while (stack.length) html += "</li></" + stack.pop() + ">";
        out.push(html);
        continue;
      }
      if (!t) { i++; continue; }
      var para = [];
      while (i < lines.length && lines[i].trim() && lines[i].trim().indexOf(FENCE) !== 0 && !/^(#{1,6}\s|>|\s*([-*+]|\d+[.)])\s)/.test(lines[i])) { para.push(lines[i].trim()); i++; }
      out.push("<p>" + inline(para.join("\n")).replace(/\n/g, "<br>") + "</p>");
    }
    return out.join("\n");
  }

  var firstH2 = source.search(/^## /m);
  var body = firstH2 < 0 ? source : source.slice(firstH2);
  var parts = body.split(/^## /m).filter(function (p) { return p.trim(); });
  var chat = document.getElementById("chat");
  parts.forEach(function (part, n) {
    var nl = part.indexOf("\n");
    var title = (nl < 0 ? part : part.slice(0, nl)).trim();
    var rest = nl < 0 ? "" : part.slice(nl + 1);
    var bits = title.split(" · ");
    var name = bits[0], when = bits.slice(1).join(" · ");
    var isUser = name === "You";
    var sec = document.createElement("section");
    sec.className = "msg " + (isUser ? "user" : "ai");
    sec.id = "m" + n;
    sec.innerHTML = '<h2><span class="who">' + esc(name.charAt(0)) + '</span><span class="name">' + esc(name) + '</span><span class="when">' + esc(when) + "</span></h2>" + render(rest);
    chat.appendChild(sec);
  });

  function copy(text, btn, label) {
    var done = function () { var old = btn.textContent; btn.textContent = label || "Copied"; setTimeout(function () { btn.textContent = old; }, 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done);
    else { var ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); done(); }
  }
  document.getElementById("copy-md").onclick = function () { copy(source, this, "Copied"); };
  document.getElementById("print").onclick = function () { window.print(); };
  document.querySelectorAll(".codebox button").forEach(function (b) {
    b.onclick = function () { copy(b.parentNode.querySelector("code").textContent, b, "Copied"); };
  });
})();
</script>
</body>
</html>`;

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Wraps Markdown in the reading page. `meta` is a short list of facts shown as chips under the title. */
export function toReaderHtml(title: string, meta: string[], markdown: string) {
  const chips = meta.map((m) => `<span class="chip">${esc(m)}</span>`).join("");
  // "</" inside the embedded text would close the script early.
  const safeMd = markdown.replace(/<\//g, "<\\/");
  return PAGE.split("__TITLE__")
    .join(esc(title))
    .split("__META__")
    .join(chips)
    .replace("__MD__", () => safeMd);
}
