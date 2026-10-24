"use strict";
// The handbook's look: neutral grays that sit next to Photoshop's dark UI,
// one accent (the blue of the panel's priced button), IBM Plex type, a
// 65-character text column, light and dark themes, and an A4 print sheet.

const CSS = String.raw`
:root{
  --bg:#f6f6f5; --paper:#ffffff; --ink:#151515; --ink-2:#383838; --muted:#5e5e60;
  --line:#e0e0de; --line-2:#cfcfcc; --soft:#efefed; --code:#f0f0ee;
  --accent:#1662d6; --accent-ink:#ffffff; --accent-soft:#e7effc; --accent-line:#b8cff3;
  --shot-bg:#2b2b2b; --shadow:0 1px 2px rgba(0,0,0,.06),0 18px 40px -22px rgba(0,0,0,.28);
  --sans:"IBM Plex Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"Helvetica Neue",Arial,sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  --top:60px; --measure:65ch; --r:6px;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --bg:#1b1b1b; --paper:#232323; --ink:#ececea; --ink-2:#cfcfcc; --muted:#a2a2a0;
    --line:#353535; --line-2:#474747; --soft:#2b2b2b; --code:#2a2a2a;
    --accent:#5b9dff; --accent-ink:#0d1626; --accent-soft:#1b2a42; --accent-line:#2f4f80;
    --shot-bg:#141414; --shadow:0 1px 2px rgba(0,0,0,.3),0 18px 40px -22px rgba(0,0,0,.7);
    color-scheme:dark;
  }
}
:root[data-theme="dark"]{
  --bg:#1b1b1b; --paper:#232323; --ink:#ececea; --ink-2:#cfcfcc; --muted:#a2a2a0;
  --line:#353535; --line-2:#474747; --soft:#2b2b2b; --code:#2a2a2a;
  --accent:#5b9dff; --accent-ink:#0d1626; --accent-soft:#1b2a42; --accent-line:#2f4f80;
  --shot-bg:#141414; --shadow:0 1px 2px rgba(0,0,0,.3),0 18px 40px -22px rgba(0,0,0,.7);
  color-scheme:dark;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:calc(var(--top) + 16px);-webkit-text-size-adjust:100%}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
body{margin:0;background:var(--bg);color:var(--ink);font:16.5px/1.62 var(--sans);-webkit-font-smoothing:antialiased;overflow-x:hidden}
a{color:var(--accent);text-decoration:underline;text-decoration-color:var(--accent-line);text-underline-offset:3px;text-decoration-thickness:1px}
a:hover{text-decoration-color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}
code,kbd,pre{font-family:var(--mono);font-variant-ligatures:none}
code{font-size:.86em;background:var(--code);border:1px solid var(--line);border-radius:4px;padding:.05em .32em;overflow-wrap:anywhere}
pre{background:var(--code);border:1px solid var(--line);border-radius:var(--r);padding:.9rem 1rem;overflow-x:auto;line-height:1.5;max-width:100%}
pre code{background:none;border:0;padding:0;font-size:.8rem;overflow-wrap:normal;white-space:pre}
kbd{font-size:.75em;border:1px solid var(--line-2);border-bottom-width:2px;border-radius:4px;padding:0 .35em;background:var(--paper);color:var(--muted)}
strong{font-weight:600}
mark{background:var(--accent-soft);color:inherit;border-radius:2px}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.skip{position:absolute;left:-10000px;top:8px}
.skip:focus{left:12px;z-index:50;background:var(--paper);padding:.5rem .8rem;border:1px solid var(--line)}
.print-only{display:none}
.eyebrow{font:500 .72rem/1.2 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:0 0 .9rem}
.eyebrow .dot{display:inline-block;width:5px;height:5px;border-radius:50%;background:var(--accent);vertical-align:middle;margin:0 .45rem}

/* Top bar */
.topbar{position:sticky;top:0;z-index:30;background:color-mix(in srgb,var(--bg) 86%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
.bar{max-width:1360px;margin:0 auto;height:var(--top);padding:0 24px;display:flex;align-items:center;gap:14px}
.brand{display:flex;align-items:center;gap:8px;color:var(--ink);text-decoration:none;flex-shrink:0}
.brand svg{width:98px;height:auto;display:block}
.brand .product{font-weight:500;font-size:.95rem;letter-spacing:-.01em;white-space:nowrap}
.version{font:500 .68rem/1 var(--mono);color:var(--muted);border:1px solid var(--line-2);border-radius:999px;padding:.3rem .5rem;white-space:nowrap}
.nav{display:flex;align-items:center;gap:18px;margin-left:auto;font-size:.88rem}
.nav a{color:var(--ink-2);text-decoration:none}
.nav a:hover{color:var(--ink)}
.button{display:inline-flex;align-items:center;gap:.4rem;background:var(--accent);color:var(--accent-ink)!important;font-weight:500;font-size:.92rem;text-decoration:none;padding:.55rem 1rem;border-radius:var(--r);border:1px solid var(--accent);white-space:nowrap}
.button:hover{filter:brightness(1.08)}
.button.small{padding:.38rem .75rem;font-size:.84rem}
.button.quiet{background:transparent;color:var(--ink)!important;border-color:var(--line-2)}
.theme{width:32px;height:32px;border-radius:50%;border:1px solid var(--line-2);background:transparent;cursor:pointer;display:grid;place-items:center;padding:0;flex-shrink:0}
.theme span{width:14px;height:14px;border-radius:50%;background:linear-gradient(90deg,var(--ink) 50%,transparent 50%);border:1.5px solid var(--ink)}

/* Search */
.search{position:relative;flex:0 1 260px;min-width:0;margin-left:12px}
.search input{width:100%;font:inherit;font-size:.88rem;color:var(--ink);background:var(--paper);border:1px solid var(--line-2);border-radius:var(--r);padding:.42rem 2rem .42rem .7rem;outline:none;-webkit-appearance:none;appearance:none}
.search input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.search input::-webkit-search-cancel-button{display:none}
.search-key{position:absolute;right:.5rem;top:50%;transform:translateY(-50%);pointer-events:none}
.search input:focus + .search-key{display:none}
.search-panel{position:absolute;top:calc(100% + 8px);left:0;width:min(520px,calc(100vw - 32px));background:var(--paper);border:1px solid var(--line-2);border-radius:8px;box-shadow:var(--shadow);overflow:hidden}
.search-panel[hidden]{display:none}
.search-panel ul{list-style:none;margin:0;padding:6px;max-height:min(440px,62vh);overflow-y:auto}
.search-panel ul:empty{display:none}
.search-panel li a{display:block;padding:.55rem .7rem;border-radius:5px;color:var(--ink);text-decoration:none}
.search-panel li[aria-selected="true"] a,.search-panel li a:hover{background:var(--soft)}
.s-trail{display:block;font:500 .64rem/1.3 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.s-title{display:block;font-weight:600;font-size:.95rem}
.s-snip{display:block;font-size:.82rem;line-height:1.45;color:var(--muted)}
.search-status{margin:0;padding:.5rem .9rem;font-size:.78rem;color:var(--muted);border-top:1px solid var(--line)}
.search-status:empty{display:none}

/* Layout */
.layout{max-width:1360px;margin:0 auto;display:grid;grid-template-columns:250px minmax(0,1fr);gap:56px;padding:0 24px}
.side{position:sticky;top:var(--top);align-self:start;max-height:calc(100vh - var(--top));overflow-y:auto;padding:28px 0 40px;font-size:.86rem;scrollbar-width:thin}
.side summary{font:500 .7rem/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--muted);cursor:pointer;list-style:none;margin-bottom:12px}
.side summary::-webkit-details-marker{display:none}
.toc-list,.toc-list ol{list-style:none;margin:0;padding:0}
.toc-list>li{margin:1px 0}
.toc-list a{display:block;color:var(--ink-2);text-decoration:none;padding:3px 10px;border-left:2px solid transparent;line-height:1.35}
.toc-list a:hover{color:var(--ink)}
.toc-list a.active{color:var(--ink);border-left-color:var(--accent);font-weight:500}
.toc-list ol{display:none;margin:2px 0 6px}
.toc-list li.open>ol{display:block}
.toc-list ol a{padding-left:22px;font-size:.82rem;color:var(--muted)}
main{min-width:0;padding:40px 0 80px;outline:none}
.handbook,.hero,.foot{max-width:820px}
.handbook p,.handbook li,.handbook h3,.handbook h4,.hero .lede,.notes p,.callout{max-width:var(--measure)}

/* Hero */
.hero h1{font-size:clamp(2.3rem,5.2vw,3.7rem);line-height:1.02;letter-spacing:-.035em;font-weight:600;margin:0 0 1.1rem}
.lede{font-size:1.18rem;line-height:1.5;color:var(--ink-2);margin:0 0 1.4rem}
.hero-cta{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 2rem}
.fig-hero{margin:0 0 2.2rem}
.fig-hero .zoom{border-radius:10px;box-shadow:var(--shadow)}
.notes{margin:2rem 0 0;color:var(--ink-2);font-size:.95rem}
.legend{display:flex;flex-wrap:wrap;gap:.4rem 1.2rem;font-size:.88rem;color:var(--muted)}

/* Flow diagram: what goes in, the actions, where results land */
.flow{display:grid;grid-template-columns:1fr 1.15fr 1fr;gap:0;border:1px solid var(--line-2);border-radius:10px;background:var(--paper);overflow:hidden;margin:0 0 1rem}
.flow-col{padding:18px 18px 16px;position:relative}
.flow-col+.flow-col{border-left:1px solid var(--line)}
.flow-col+.flow-col::before{content:"";position:absolute;left:-7px;top:24px;width:12px;height:12px;background:var(--paper);border-top:1px solid var(--line-2);border-right:1px solid var(--line-2);transform:rotate(45deg)}
.flow-label{font:500 .68rem/1.2 var(--mono);letter-spacing:.13em;text-transform:uppercase;color:var(--muted);margin:0 0 .7rem}
.flow ul{list-style:none;margin:0;padding:0;font-size:.88rem;line-height:1.4}
.flow-in li,.flow-out li{padding:.32rem 0;border-top:1px solid var(--line)}
.flow-in li:first-child,.flow-out li:first-child{border-top:0;padding-top:0}
.flow a{color:var(--ink);text-decoration:none}
.flow a:hover{color:var(--accent)}
.flow-mid{background:var(--soft)}
.flow-actions{display:flex;flex-wrap:wrap;gap:6px}
.flow-actions a{display:inline-block;font-size:.8rem;border:1px solid var(--line-2);background:var(--paper);border-radius:999px;padding:.2rem .6rem}
.flow-actions a:hover{border-color:var(--accent)}
.flow-price{font-size:.82rem;color:var(--muted);margin:.9rem 0 0;line-height:1.45}
.flow-price a{color:var(--accent);text-decoration:underline;text-decoration-color:var(--accent-line)}
.flow-agents{grid-column:1/-1;margin:0;padding:12px 18px;border-top:1px solid var(--line);font-size:.86rem;color:var(--ink-2)}
.flow-agents a{font:500 .68rem/1 var(--mono);letter-spacing:.13em;text-transform:uppercase;color:var(--accent);margin-right:.5rem}

/* Content */
.chapter{padding-top:12px}
.handbook h2{font-size:1.85rem;letter-spacing:-.025em;line-height:1.15;font-weight:600;margin:3.6rem 0 1rem;padding-top:1.4rem;border-top:1px solid var(--line);display:flex;align-items:baseline;gap:.7rem}
.handbook h2 .num{font:500 .78rem/1 var(--mono);color:var(--accent);letter-spacing:.04em}
.handbook h3{font-size:1.22rem;letter-spacing:-.012em;line-height:1.3;font-weight:600;margin:2.3rem 0 .6rem}
.handbook h4{font-size:1rem;font-weight:600;margin:1.6rem 0 .4rem}
.anchor{margin-left:.4rem;color:var(--line-2);text-decoration:none;font-weight:400;opacity:0;transition:opacity .15s}
h2:hover .anchor,h3:hover .anchor,h4:hover .anchor,.anchor:focus{opacity:1}
.handbook p{margin:0 0 1rem}
.handbook ul,.handbook ol{padding-left:1.3rem;margin:0 0 1.1rem}
.handbook li{margin:.3rem 0}
.handbook li>p{margin:.4rem 0}
.handbook li::marker{color:var(--muted)}
.callout{border:1px solid var(--accent-line);background:var(--accent-soft);border-radius:var(--r);padding:.8rem 1rem;margin:1.2rem 0;font-size:.95rem}
.callout p{margin:.3rem 0}
.callout pre{background:var(--paper)}
em.claim{font-style:normal;font:500 .74em/1 var(--mono);letter-spacing:.02em;white-space:nowrap;border-radius:999px;padding:.18em .55em .2em;border:1px solid var(--line-2);color:var(--ink-2);vertical-align:.08em}
em.claim::before{content:"";display:inline-block;width:.62em;height:.62em;border-radius:50%;margin-right:.38em;vertical-align:-.02em;border:1.5px solid currentColor}
em.claim-live{border-color:var(--accent-line);color:var(--accent);background:var(--accent-soft)}
em.claim-live::before{background:currentColor}
em.claim-auto::before{background:linear-gradient(90deg,currentColor 50%,transparent 50%)}
em.claim-none{color:var(--muted);border-style:dashed}
.table-wrap{overflow-x:auto;margin:1.2rem 0 1.4rem;border:1px solid var(--line);border-radius:var(--r);background:var(--paper)}
table{border-collapse:collapse;width:100%;font-size:.88rem;line-height:1.45}
th,td{text-align:left;vertical-align:top;padding:.6rem .8rem;border-top:1px solid var(--line)}
thead th{border-top:0;font:500 .7rem/1.3 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);background:var(--soft)}
tbody th{font-weight:500;color:var(--ink)}
table.kv thead{display:none}
table.kv tbody tr:first-child th,table.kv tbody tr:first-child td{border-top:0}
td code,th code{font-size:.82em}

/* Pictures */
.zoom{display:block;width:100%;padding:0;border:0;background:none;cursor:zoom-in;border-radius:8px;overflow:hidden;line-height:0}
.zoom img{display:block;width:100%;height:auto}
.fig{margin:1.6rem 0 1.8rem}
.fig figcaption{font-size:.84rem;line-height:1.45;color:var(--muted);margin-top:.6rem;max-width:var(--measure)}
.fig-label{font:500 .66rem/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-2);margin-right:.35rem}
.fig-ba .zoom{border:1px solid var(--line);box-shadow:var(--shadow)}
.fig-clip .zoom{border:1px solid var(--line);max-width:720px}
.fig-note{font-size:.84rem;color:var(--muted);margin:.35rem 0 0!important}
.shots{display:flex;flex-wrap:wrap;gap:20px;margin:1.4rem 0 1.8rem}
.shot{margin:0;flex:0 1 280px;display:flex;flex-direction:column;gap:.6rem}
.shots.n1 .shot{flex-basis:100%;flex-direction:row;align-items:flex-start;gap:20px}
.shots.n1 .zoom{width:260px;flex-shrink:0}
.shot .zoom{background:var(--shot-bg);border:1px solid var(--line-2);padding:0;border-radius:8px}
.shot figcaption{font-size:.84rem;line-height:1.45;color:var(--muted);max-width:42ch}
.shots .fig-note{flex-basis:100%}
.gallery{margin:2.4rem 0 0}
.ba-grid{list-style:none;margin:0!important;padding:0!important;display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px}
.ba-card{margin:0!important}
.ba-card a{display:flex;flex-direction:column;height:100%;color:var(--ink);text-decoration:none;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--paper);transition:border-color .15s,transform .15s}
.ba-card a:hover{border-color:var(--accent);transform:translateY(-2px)}
.ba-img{display:block;aspect-ratio:16/10;overflow:hidden;background:var(--soft)}
.ba-img img{width:100%;height:100%;object-fit:cover;display:block}
.ba-title{display:block;font-weight:600;padding:.75rem .9rem .2rem}
.ba-text{display:block;font-size:.8rem;line-height:1.4;color:var(--muted);padding:0 .9rem .9rem}
.build-note{font-size:.88rem;color:var(--muted)}
.foot{margin-top:4rem;padding-top:1.2rem;border-top:1px solid var(--line);font-size:.82rem;color:var(--muted)}
.foot p{margin:.3rem 0}

/* Lightbox */
.lightbox{border:0;padding:0;background:transparent;max-width:96vw;max-height:96vh;overflow:visible}
.lightbox::backdrop{background:rgba(10,10,10,.86)}
.lightbox img{display:block;max-width:94vw;max-height:86vh;width:auto;height:auto;border-radius:6px;margin:0 auto}
.lb-cap{color:#d8d8d6;font-size:.86rem;text-align:center;max-width:70ch;margin:.7rem auto 0}
.lb-close{position:fixed;top:14px;right:16px;font:500 .8rem var(--mono);color:#fff;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.3);border-radius:999px;padding:.4rem .8rem;cursor:pointer}

/* Narrow screens */
@media (max-width:1100px){
  .nav .opt{display:none}
}
@media (max-width:900px){
  .layout{grid-template-columns:minmax(0,1fr);gap:0;padding:0 16px}
  .side{position:static;max-height:none;padding:16px 0 0}
  .side-box{border:1px solid var(--line);border-radius:var(--r);padding:10px 12px;background:var(--paper)}
  .side summary{margin:0}
  .side-box[open] summary{margin-bottom:10px}
  .toc-list ol{display:none!important}
  main{padding-top:20px}
  .flow{grid-template-columns:1fr}
  .flow-col+.flow-col{border-left:0;border-top:1px solid var(--line)}
  .flow-col+.flow-col::before{left:28px;top:-7px;transform:rotate(135deg)}
}
@media (max-width:640px){
  body{font-size:16px}
  .bar{padding:0 16px;gap:10px}
  .brand svg{width:84px}
  .brand .product{display:none}
  .version{display:none}
  .search{margin-left:auto;flex:1 1 auto}
  .search-key{display:none}
  .nav{margin-left:0;gap:8px}
  .nav .button.small{padding:.36rem .6rem}
  .shots.n1 .shot{flex-direction:column}
  .shots.n1 .zoom,.shot{width:100%;max-width:300px}
  .shot{flex-basis:100%}
  .handbook h2{font-size:1.5rem}
  .lede{font-size:1.06rem}
}

/* Print: A4, cover, contents with page numbers, no sidebar */
@page{size:A4;margin:16mm 16mm 18mm;
  @bottom-left{content:"Scenario for Photoshop handbook";font:8pt "IBM Plex Mono",monospace;color:#777}
  @bottom-right{content:counter(page);font:8pt "IBM Plex Mono",monospace;color:#777}}
@page:first{margin:0;@bottom-left{content:none}@bottom-right{content:none}}
@media print{
  :root{--bg:#fff;--paper:#fff;--ink:#141414;--ink-2:#333;--muted:#5a5a5a;--line:#dcdcda;--line-2:#c8c8c6;--soft:#f3f3f1;--code:#f3f3f1;--accent:#1458c4;--accent-soft:#edf3fd;--accent-line:#b8cff3;--shadow:none;color-scheme:light}
  html{scroll-padding-top:0}
  body{font-size:9.6pt;line-height:1.5;background:#fff;overflow:visible}
  .topbar,.side,.anchor,.skip,.lightbox,.screen-only,.hero-cta,.foot,.hero .eyebrow,.hero h1,.hero .lede,.fig-hero{display:none!important}
  .print-only{display:block}
  .layout{display:block;padding:0;max-width:none}
  main{padding:0}
  .handbook,.hero{max-width:none}
  a{color:inherit;text-decoration-color:#bbb}
  .cover{height:297mm;width:210mm;padding:22mm 20mm 18mm;display:flex!important;flex-direction:column;break-after:page;position:relative}
  .cover-logo svg{width:44mm;height:auto;color:#111;display:block}
  .cover-main{margin-top:30mm}
  .cover-title{font-size:38pt;line-height:1;letter-spacing:-.035em;font-weight:600;margin:0 0 6mm}
  .cover-sub{font-size:12pt;line-height:1.45;color:#333;max-width:140mm;margin:0}
  .cover-img{width:100%;height:auto;border-radius:3mm;margin-top:14mm}
  .cover-meta{margin:auto 0 0;display:flex;gap:12mm;font-size:9pt}
  .cover-meta dt{font:500 7pt "IBM Plex Mono",monospace;letter-spacing:.12em;text-transform:uppercase;color:#666;margin-bottom:1.5mm}
  .cover-meta dd{margin:0}
  .print-toc{break-after:page}
  .print-toc-title{font-size:20pt;font-weight:600;letter-spacing:-.02em;margin:0 0 8mm}
  .print-toc ol{list-style:none;margin:0;padding:0}
  .print-toc li a{display:flex;align-items:baseline;gap:3mm;text-decoration:none;padding:1.6mm 0;border-bottom:.2mm solid #e4e4e2;font-size:10.5pt}
  .pt-num{font:500 8pt "IBM Plex Mono",monospace;color:#1458c4;width:8mm}
  .pt-dots{flex:1}
  .pt-page{font:500 9pt "IBM Plex Mono",monospace}
  .hero{padding:0;margin:0 0 4mm}
  .notes{margin:0;font-size:9.4pt}
  .flow{break-inside:avoid;margin:0 0 6mm}
  .flow-col{padding:4mm}
  .chapter.new-page{break-before:page}
  .handbook h2{font-size:17pt;margin:8mm 0 3mm;padding-top:0;border-top:0;break-after:avoid}
  .chapter.new-page h2{margin-top:0}
  .handbook h3{font-size:12pt;margin:6mm 0 2mm;break-after:avoid}
  .handbook h4{break-after:avoid}
  .handbook p,.handbook li,.callout{max-width:none;orphans:3;widows:3}
  pre,blockquote,.callout,tr,.fig,.shot{break-inside:avoid}
  pre{white-space:pre-wrap;word-break:break-all}
  pre code{white-space:pre-wrap}
  .table-wrap{overflow:visible;border-color:#ddd}
  thead{display:table-header-group}
  .fig{margin:4mm 0}
  .fig .zoom{max-width:150mm;box-shadow:none}
  .fig-clip .zoom{max-width:110mm}
  .shots{gap:5mm;margin:3mm 0 5mm}
  .shot{flex:0 0 42mm}
  .shots.n1 .shot{flex:1 1 100%}
  .shots.n1 .zoom{width:36mm}
  .shot figcaption,.fig figcaption{font-size:8.4pt}
  em.claim{font-size:7.4pt}
}
`;

module.exports = { CSS };
