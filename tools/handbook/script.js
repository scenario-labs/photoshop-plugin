"use strict";
// The handbook page's behaviour: search (/ focuses it), the light and dark
// switch, the contents column following the reader, and pictures that
// enlarge. The page reads fine without it.

const SCRIPT = String.raw`
(function(){
  var root=document.documentElement;
  function store(k,v){try{if(v===undefined)return localStorage.getItem(k);localStorage.setItem(k,v);}catch(e){return null;}}

  // Theme
  var saved=store("handbook-theme");
  if(saved==="light"||saved==="dark")root.setAttribute("data-theme",saved);
  var tb=document.getElementById("theme");
  function current(){var t=root.getAttribute("data-theme");if(t)return t;return window.matchMedia&&matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}
  function label(){if(tb){var c=current();tb.setAttribute("aria-label",c==="dark"?"Switch to light":"Switch to dark");}}
  label();
  if(tb)tb.addEventListener("click",function(){var n=current()==="dark"?"light":"dark";root.setAttribute("data-theme",n);store("handbook-theme",n);label();});

  // Lightbox
  var lb=document.getElementById("lightbox");
  if(lb&&lb.showModal){
    var lbImg=lb.querySelector("img"),lbCap=lb.querySelector(".lb-cap");
    document.addEventListener("click",function(e){
      var b=e.target.closest&&e.target.closest("[data-zoom]");
      if(!b)return;
      var img=b.querySelector("img");
      lbImg.src=img.currentSrc||img.src;lbImg.alt=img.alt;lbCap.textContent=img.alt;
      lb.showModal();
    });
    lb.addEventListener("click",function(e){if(e.target===lb||e.target===lbImg)lb.close();});
  }

  // Contents: mark the section in view, open its sub-list
  var links=[].slice.call(document.querySelectorAll(".toc-list a"));
  var byId={};links.forEach(function(a){byId[a.getAttribute("href").slice(1)]=a;});
  var heads=[].slice.call(document.querySelectorAll(".handbook h2[id], .handbook h3[id]")).filter(function(h){return byId[h.id];});
  var active=null;
  function mark(){
    var y=(parseInt(getComputedStyle(root).scrollPaddingTop,10)||80)+8,cur=null;
    for(var i=0;i<heads.length;i++){if(heads[i].getBoundingClientRect().top<=y)cur=heads[i];else break;}
    var a=cur?byId[cur.id]:null;
    if(a===active)return;
    if(active)active.classList.remove("active");
    links.forEach(function(l){var li=l.parentElement;if(li.parentElement.classList.contains("toc-list"))li.classList.remove("open");});
    active=a;
    if(a){a.classList.add("active");var top=a.closest(".toc-list>li");if(top)top.classList.add("open");
      var side=document.querySelector(".side");if(side&&side.scrollHeight>side.clientHeight){var r=a.getBoundingClientRect(),s=side.getBoundingClientRect();if(r.top<s.top+40||r.bottom>s.bottom-40)side.scrollTop+=r.top-s.top-s.height/3;}}
  }
  var ticking=false;
  window.addEventListener("scroll",function(){if(!ticking){ticking=true;requestAnimationFrame(function(){ticking=false;mark();});}},{passive:true});
  mark();
  var box=document.getElementById("side-box");
  if(box&&window.matchMedia&&matchMedia("(max-width: 900px)").matches)box.removeAttribute("open");

  // Search
  var input=document.getElementById("q"),panel=document.getElementById("q-panel"),list=document.getElementById("q-results"),status=document.getElementById("q-status");
  var data=[];try{data=JSON.parse(document.getElementById("search-index").textContent);}catch(e){}
  data.forEach(function(d){d.lt=d.t.toLowerCase();d.lx=d.x.toLowerCase();});
  var sel=-1,hits=[];
  function escH(s){return s.replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];});}
  // Marks the query words on the raw text, then escapes each piece, so a word
  // such as "amp" or "mark" never matches inside an entity or a tag.
  function hl(s,words){var ws=words.filter(function(w){return w.length>=2;}).map(function(w){return w.replace(/[.*+?^$()|[\]\\{}]/g,"\\$&");});if(!ws.length)return escH(s);return s.split(new RegExp("("+ws.join("|")+")","ig")).map(function(part,i){return i%2?"<mark>"+escH(part)+"</mark>":escH(part);}).join("");}
  function snippet(d,words){var i=-1;for(var k=0;k<words.length&&i<0;k++)i=d.lx.indexOf(words[k]);if(i<0)return d.x.slice(0,140);var s=Math.max(0,i-50);return (s?"\u2026":"")+d.x.slice(s,s+150)+"\u2026";}
  function run(){
    var q=input.value.trim().toLowerCase();
    if(!q){close();return;}
    var words=q.split(/\s+/);
    hits=[];
    data.forEach(function(d){var score=0;for(var k=0;k<words.length;k++){var w=words[k];var t=d.lt.indexOf(w)>=0,x=d.lx.indexOf(w)>=0;if(!t&&!x)return;score+=(t?10:0)+(x?1:0)+(d.lt.indexOf(w)===0?5:0);}hits.push({d:d,s:score});});
    hits.sort(function(a,b){return b.s-a.s;});hits=hits.slice(0,12);sel=hits.length?0:-1;
    list.innerHTML=hits.map(function(h,i){return '<li role="option" id="q-o'+i+'" aria-selected="'+(i===sel)+'"><a href="#'+h.d.id+'">'+(h.d.c?'<span class="s-trail">'+escH(h.d.c)+'</span>':'')+'<span class="s-title">'+hl(h.d.t,words)+'</span><span class="s-snip">'+hl(snippet(h.d,words),words)+'</span></a></li>';}).join("");
    status.textContent=hits.length?(hits.length+(hits.length===1?" section":" sections")+". Enter opens, arrows move, Esc closes."):"No section matches.";
    panel.hidden=false;input.setAttribute("aria-expanded","true");
    if(sel>=0)input.setAttribute("aria-activedescendant","q-o0");
  }
  function close(){panel.hidden=true;input.setAttribute("aria-expanded","false");input.removeAttribute("aria-activedescendant");}
  function move(n){if(!hits.length)return;var items=list.children;if(items[sel])items[sel].setAttribute("aria-selected","false");sel=(sel+n+hits.length)%hits.length;items[sel].setAttribute("aria-selected","true");items[sel].scrollIntoView({block:"nearest"});input.setAttribute("aria-activedescendant","q-o"+sel);}
  function go(id){close();input.blur();var el=document.getElementById(id);if(el){location.hash=id;el.setAttribute("tabindex","-1");el.focus({preventScroll:true});}}
  if(input){
    input.addEventListener("input",run);
    input.addEventListener("focus",function(){if(input.value.trim())run();});
    input.addEventListener("keydown",function(e){
      if(e.key==="ArrowDown"){e.preventDefault();move(1);}
      else if(e.key==="ArrowUp"){e.preventDefault();move(-1);}
      else if(e.key==="Enter"){if(hits[sel]){e.preventDefault();go(hits[sel].d.id);}}
      else if(e.key==="Escape"){if(!panel.hidden){close();}else{input.value="";input.blur();}}
    });
    list.addEventListener("click",function(e){var a=e.target.closest("a");if(a){e.preventDefault();go(a.getAttribute("href").slice(1));}});
    document.addEventListener("click",function(e){if(!e.target.closest(".search"))close();});
    document.addEventListener("keydown",function(e){
      if(e.key!=="/"||e.metaKey||e.ctrlKey||e.altKey)return;
      var t=e.target,tag=t&&t.tagName;
      if(tag==="INPUT"||tag==="TEXTAREA"||(t&&t.isContentEditable))return;
      e.preventDefault();input.focus();input.select();
    });
  }
})();
`;

module.exports = { SCRIPT };
