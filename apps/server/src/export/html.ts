import { toHtml } from "hast-util-to-html";
import { fontFaces } from "./fonts.ts";
import type { RenderedDocument } from "./render.ts";
import { CODE_COLORS, FONT_MONO, FONT_SANS, INK } from "./theme.ts";

const tokenRules = Object.entries(CODE_COLORS)
  .map(([name, color]) => `.hljs-${name}{color:${color}}`)
  .join("");

/** The page's stylesheet: a light document on screen, and A4 pages with sensible breaks in print (and so in the PDF). */
const STYLE = `
:root{color-scheme:light}
*{box-sizing:border-box}
html{background:#fff}
body{margin:0;color:${INK.soft};font:15px/1.65 "${FONT_SANS}",system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
main{max-width:780px;margin:0 auto;padding:48px 32px}
main>:first-child{margin-top:0}
h1,h2,h3,h4,h5,h6{color:${INK.text};font-weight:600;line-height:1.35;margin:1.5em 0 .6em;break-after:avoid}
h1{font-size:1.75em;padding-bottom:.3em;border-bottom:1px solid ${INK.line}}
h2{font-size:1.35em;padding-bottom:.25em;border-bottom:1px solid ${INK.line}}
h3{font-size:1.15em}
h4,h5{font-size:1em}
h6{font-size:1em;color:${INK.muted}}
p,ul,ol,blockquote,pre,table{margin:0 0 .85em}
strong{color:${INK.text};font-weight:600}
a{color:${INK.link};text-underline-offset:2px;overflow-wrap:anywhere}
ul,ol{padding-left:1.5em}
li+li{margin-top:.25em}
li>ul,li>ol{margin:.25em 0 0}
li::marker{color:${INK.faint}}
.contains-task-list{padding-left:.2em;list-style:none}
.task-list-item input{margin:0 .5em 0 0;vertical-align:-.1em}
blockquote{margin-inline:0;padding-left:.9em;border-left:3px solid ${INK.line};color:${INK.muted}}
hr{margin:1.5em 0;border:0;border-top:1px solid ${INK.line}}
del{color:${INK.faint}}
code{font-family:"${FONT_MONO}",ui-monospace,Menlo,Consolas,monospace;font-size:.88em}
:not(pre)>code{padding:.1em .35em;border-radius:4px;background:${INK.wash};color:${INK.text}}
pre{padding:12px 14px;border:1px solid ${INK.line};border-radius:6px;background:${INK.wash};white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5}
table{border-collapse:collapse;display:block;max-width:100%;overflow-x:auto}
th,td{padding:6px 12px;border:1px solid ${INK.line};text-align:left;vertical-align:top}
th{background:${INK.wash};color:${INK.text};font-weight:600}
tr{break-inside:avoid}
img{max-width:100%;height:auto}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.footnotes{margin-top:2em;font-size:.9em;color:${INK.muted}}
.hljs-comment,.hljs-quote{font-style:italic}
${tokenRules}
@page{size:A4;margin:18mm 16mm}
@media print{main{max-width:none;padding:0}table{display:table}pre,blockquote,img{break-inside:avoid}}
`;

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** One self-contained page: fonts, styles and images inside, no script, nothing fetched. */
export async function documentHtml(doc: RenderedDocument): Promise<string> {
  const fonts = await fontFaces();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="majhi">
<title>${escapeText(doc.title)}</title>
<style>
${fonts}
${STYLE}</style>
</head>
<body>
<main>
${toHtml(doc.tree)}
</main>
</body>
</html>
`;
}
