/*
 * Game-Aware Composition Notebook — shared overlay MODULE.
 * ---------------------------------------------------------
 * Drop-in for any existing overlay canvas (e.g. viewer-overlay.html). It is fully
 * self-contained: injects its own scoped styles (`nbk-` prefix) + a docked
 * notebook DOM, and exposes a tiny API on `window.NotesOverlay`:
 *
 *   NotesOverlay.attach(ws)        → call inside the host's ws.onopen.
 *                                    Subscribes to the "notes" service and asks
 *                                    for current state. Safe to call on every
 *                                    (re)connect.
 *   NotesOverlay.handle(event,data)→ call for any event whose name starts with
 *                                    "note:". Returns true if it consumed it.
 *
 * It never touches the host overlay's globals. Authoritative state arrives via
 * `note:render`; the module diffs successive renders to drive the animations, so
 * a missed animation event can never desync the display.
 *
 * Default position: docked bottom-left, hidden until `!note on` / `!note show`.
 * Tweak --nbk-scale / placement via the :root vars below or override in the host.
 */
(function () {
  'use strict';
  if (window.NotesOverlay) return; // idempotent if included twice

  // ── Inject fonts (handwriting) — harmless if offline, falls back to cursive ──
  const fontLink = document.createElement('link');
  fontLink.rel = 'stylesheet';
  fontLink.href = 'https://fonts.googleapis.com/css2?family=Caveat:wght@500;600;700&family=Patrick+Hand&display=swap';
  document.head.appendChild(fontLink);

  // ── Scoped styles ────────────────────────────────────────────────────────
  const css = `
  #nbk-stage {
    --nbk-paper:#fcfbf4; --nbk-rule:#9ec3e6; --nbk-margin:#e8836f;
    --nbk-ink:#1f3a63; --nbk-ink-soft:#34507c;
    /* Render at native size — keep scale at 1 for crisp text. A fractional scale
       blurs all text in OBS/CEF (bitmap upscale), so resize via --nbk-w/h instead. */
    --nbk-scale:1;
    --nbk-w:400px; --nbk-h:570px;
    --nbk-t1:#e0584f; --nbk-t2:#e9a23b; --nbk-t3:#57a05a; --nbk-t4:#4f86c6; --nbk-t5:#8e6bbf;
    position: fixed; left: 26px; bottom: 76px; z-index: 60;
    /* NOTE: no transform here on purpose — a transform promotes this to a
       composited layer and CEF bilinear-samples raster images (emotes) inside it,
       making them blurry. Resize via --nbk-w/h, not scale. */
    pointer-events: none; font-family:'Patrick Hand','Comic Sans MS',cursive;
  }
  #nbk-stage * { box-sizing: border-box; }
  .nbk-book {
    position: relative; width: var(--nbk-w); height: var(--nbk-h);
    transform-origin: center bottom;
    transition: transform .5s cubic-bezier(.2,.8,.25,1), opacity .4s ease;
    /* shadow lives on .nbk-cover as a box-shadow — a filter:drop-shadow here would
       rasterize the whole subtree and soften the emote images. */
  }
  /* Swipe in from / out to the left (like the !card overlay). */
  .nbk-book.nbk-off { transform: translateX(-135%); opacity:0; }
  /* Same swipe as .nbk-off, deliberately: a game/chapter change should read as
     "the notebook left and a different one came back". It used to shrink and
     fade in place, which looked like a glitch next to the show/hide swipe.
     Kept as its own class so it can't fight the .nbk-off visibility state. */
  .nbk-book.nbk-closing { transform: translateX(-135%); opacity:0; }
  .nbk-cover {
    position:absolute; inset:-14px; border-radius:9px;
    background:
      radial-gradient(circle at 20% 30%, rgba(255,255,255,.10) 0 2px, transparent 3px),
      radial-gradient(circle at 70% 60%, rgba(255,255,255,.08) 0 2px, transparent 3px),
      repeating-conic-gradient(from 0deg at 50% 50%, #16171b 0deg 6deg, #24262c 6deg 12deg);
    background-size:14px 14px,22px 22px,100% 100%;
    box-shadow: 0 18px 26px rgba(0,0,0,.45), inset 0 0 0 2px rgba(0,0,0,.6);
  }
  /* ── Genre header band — spans the full paper width (color set per-genre by JS
     via --rc1/2/dark). It's the first flex child of the page, so the paper's
     rounded top corners clip it and the heading flows beneath it. ───────────── */
  .nbk-ribbon {
    position:relative; z-index:6; flex:0 0 auto; width:100%;
    --rc1:#3f5d8c; --rc2:#243a5e; --rc-dark:#13233c;
    padding:7px 16px 9px; text-align:center;
    background:linear-gradient(180deg, var(--rc1), var(--rc2));
    border-bottom:2px solid var(--rc-dark);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.35), 0 2px 6px rgba(0,0,0,.3);
  }
  .nbk-ribbon-eyebrow {
    font-family:'Patrick Hand',cursive; font-size:10.5px; letter-spacing:.24em;
    color:rgba(255,255,255,.9); text-transform:uppercase; text-shadow:0 1px 2px rgba(0,0,0,.4);
  }
  .nbk-ribbon-title {
    font-family:'Caveat',cursive; font-weight:700; font-size:27px; line-height:1.05;
    color:#fff; margin-top:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    text-shadow:0 1px 2px rgba(0,0,0,.45), 0 0 1px rgba(0,0,0,.3);
  }
  /* Page padding is vertical only — the ruled lines run the full paper width.
     Horizontal insets are applied to the CONTENT (heading + note rows) instead,
     so text clears the red margin while the rules go edge to edge. */
  .nbk-page {
    position:absolute; inset:0; background:var(--nbk-paper); border-radius:6px;
    padding:0 0 20px 0; overflow:hidden; transform-origin:left center;
    display:flex; flex-direction:column;
  }
  .nbk-page::before { content:''; position:absolute; top:0; bottom:0; left:48px; width:2px; background:var(--nbk-margin); opacity:.7; }
  .nbk-holes { position:absolute; left:16px; top:90px; bottom:24px; width:18px; display:flex; flex-direction:column; justify-content:space-between; z-index:4; }
  .nbk-holes i { width:15px; height:15px; border-radius:50%; background:radial-gradient(circle at 50% 40%, rgba(0,0,0,.55), rgba(0,0,0,.25) 60%, transparent 72%); }
  /* Page turn = the NOTES content slides out and the new page slides in (content
     swapped at the midpoint). Avoids the old rotateY flip, which exposed the cover
     behind the page and distorted. Only the notes move; ribbon/heading stay put. */
  .nbk-notes.nbk-turn { animation: nbkTurn .5s ease both; }
  @keyframes nbkTurn { 0%{opacity:1;transform:translateX(0)} 46%{opacity:0;transform:translateX(-26px)} 54%{opacity:0;transform:translateX(26px)} 100%{opacity:1;transform:translateX(0)} }
  /* top:-10px shifts the heading + underline up WITHOUT reclaiming layout space,
     so the notes below stay exactly where they are. */
  .nbk-head { position:relative; top:-10px; z-index:3; font-family:'Caveat',cursive; font-weight:700; font-size:30px; color:var(--nbk-ink); margin:32px 0 6px; padding:0 30px 0 64px; transform:rotate(-1.2deg); }
  .nbk-head .nbk-ul { display:block; height:3px; width:60%; margin-top:-3px; background:repeating-linear-gradient(90deg,var(--nbk-margin) 0 12px,transparent 12px 18px); border-radius:2px; }
  /* Ruled writing area — the rule grid is anchored to the top of this box and
     uses the SAME 34px period as each note row, so text always lands on a line.
     Rules live only here (never behind the title) and fill down to the page foot. */
  .nbk-notes {
    position:relative; z-index:3; flex:1 1 auto; margin-top:2px;
    /* overflow clipped; when notes exceed the page they're split into auto-cycling
       sub-pages (notes that don't fit are display:none until their page shows). */
    overflow:hidden;
    /* layer 1: one extra rule at the very top; layer 2: the repeating 28px grid */
    background-image:
      linear-gradient(var(--nbk-rule), var(--nbk-rule)),
      repeating-linear-gradient(transparent 0 27px, var(--nbk-rule) 27px 28px);
    background-position:0 0, 0 0;
    background-size:100% 1px, auto;
    background-repeat:no-repeat, repeat;
  }
  /* Block layout (not flex): the box + number are inline at the start, so when the
     text wraps it flows full-width UNDER the marker instead of indenting under the
     text — far less wasted space. Line grid = 28px to match the rules above. */
  /* top drops the text onto the rule line (rules stay put; row height unchanged) */
  .nbk-note { display:block; min-height:28px; line-height:28px; padding:0 26px 0 60px; font-family:'Caveat',cursive; font-weight:600; font-size:18px; color:var(--nbk-ink); position:relative; top:4px; }
  .nbk-note .nbk-box { display:inline-block; width:15px; height:15px; vertical-align:-2px; margin-right:5px; border:2px solid var(--nbk-ink-soft); border-radius:3px; position:relative; transform:rotate(-3deg); }
  .nbk-note .nbk-num { color:var(--nbk-margin); font-weight:700; margin-right:4px; }
  .nbk-note .nbk-body { position:relative; }
  /* Sized to sit proportionate with the 18px note text (not the native 28px,
     which dominates the smaller handwriting font); width:auto keeps aspect ratio.
     image-rendering:auto overrides the host overlay's inherited pixelated mode
     (set for its pixel-art avatars) so the emote downscales SMOOTHLY instead of
     with harsh nearest-neighbor that looks distorted. */
  .nbk-emote { height:21px; width:auto; vertical-align:-5px; margin:0 1px; image-rendering:auto; }
  /* Checkmark: always present but scaled to 0; .nbk-done scales it in (and it
     scales back out on undone) via transition — no rebuild needed. */
  .nbk-note .nbk-box::after { content:''; position:absolute; left:2px; top:-7px; width:7px; height:14px; border:solid #2e7d32; border-width:0 3px 3px 0; transform:rotate(40deg) scale(0); transform-origin:center; opacity:0; transition:transform .28s ease, opacity .2s ease; }
  .nbk-note.nbk-done .nbk-box::after { transform:rotate(40deg) scale(1); opacity:1; }
  .nbk-note.nbk-done .nbk-body { color:#5c6b54; }
  /* Strikethrough drawn as a background line (covers every wrapped line, and its
     vertical position is tunable — unlike text-decoration). It draws left→right on
     done/scratch and retracts on undone. Raise/lower the strike with the +Npx in
     background-position below. */
  .nbk-note .nbk-body { background-image:linear-gradient(var(--nbk-ink),var(--nbk-ink)); background-repeat:no-repeat; background-size:0% 2px; background-position:0 calc(50% + 2px); transition:background-size .3s ease, color .3s ease, opacity .3s ease; }
  .nbk-note.nbk-done .nbk-body, .nbk-note.nbk-scratched .nbk-body { background-size:100% 2px; }
  .nbk-note.nbk-scratched .nbk-body { opacity:.6; }
  /* blinking pen cursor shown while a note is being "written" */
  .nbk-caret { display:inline-block; width:2px; height:.95em; background:var(--nbk-ink); vertical-align:-1px; margin-left:1px; animation:nbkBlink .5s step-end infinite; }
  @keyframes nbkBlink { 50%{opacity:0} }
  .nbk-note.nbk-adding { animation:nbkDrop .3s ease both; }
  @keyframes nbkDrop { from{opacity:0;transform:translateY(-6px)} to{opacity:1;transform:none} }
  .nbk-note.nbk-deleting { animation:nbkCrumple .6s ease forwards; pointer-events:none; }
  @keyframes nbkCrumple { 0%{transform:scale(1) rotate(0);opacity:1} 40%{transform:scale(.8) rotate(-4deg)} 100%{transform:scale(.1) rotate(22deg) translateY(26px);opacity:0;filter:blur(2px)} }
  /* clear all = simple fade (no crumple/skew, no burn) */
  .nbk-note.nbk-fading { animation:nbkFade .45s ease forwards; pointer-events:none; }
  @keyframes nbkFade { to{opacity:0} }
  .nbk-note.nbk-focus { animation:nbkFocus 1.4s ease 2; }
  @keyframes nbkFocus { 0%,100%{background:transparent} 50%{background:rgba(255,225,120,.55);box-shadow:0 0 0 6px rgba(255,225,120,.25)} }
  /* mix-blend-mode lives ONLY on .nbk-go (during the burn) — having it persistently
     forced .nbk-page to rasterize as an isolated group, which softened the raster
     emotes (while leaving vector text crisp). Only blend during the clear-all burn. */
  #nbk-burn { position:absolute; inset:0; pointer-events:none; border-radius:6px; opacity:0; z-index:7;
    background:radial-gradient(circle at 50% 110%, rgba(255,170,40,.9), rgba(255,80,0,.7) 30%, transparent 60%), radial-gradient(circle at 30% 90%, rgba(255,210,80,.8), transparent 40%); }
  #nbk-burn.nbk-go { mix-blend-mode:screen; animation:nbkBurn 1s ease forwards; }
  @keyframes nbkBurn { 0%{opacity:0;transform:translateY(18px) scaleY(.6)} 35%{opacity:1} 100%{opacity:0;transform:translateY(-28px) scaleY(1.2)} }
  .nbk-tabs { position:absolute; top:86px; right:-12px; display:flex; flex-direction:column; gap:8px; z-index:5; }
  .nbk-tab { font-size:13px; color:#fff; padding:6px 10px 6px 12px; border-radius:0 8px 8px 0; box-shadow:2px 3px 6px rgba(0,0,0,.35); white-space:nowrap; max-width:130px; overflow:hidden; text-overflow:ellipsis; border-left:3px solid rgba(0,0,0,.15); transition:transform .2s ease; }
  .nbk-tab.nbk-active { transform:translateX(-8px); font-weight:bold; }
  .nbk-tab .nbk-cnt { opacity:.85; font-size:11px; }
  .nbk-empty { font-family:'Caveat',cursive; font-size:22px; color:#9aa6b8; transform:rotate(-1.5deg); margin-top:8px; padding-left:64px; }
  /* "Page X / Y" indicator — a small dark pill, bottom-right (hidden on single page) */
  .nbk-pageind { position:absolute; right:10px; bottom:7px; z-index:8; display:none; font-family:'Patrick Hand',cursive; font-size:13px; font-weight:bold; letter-spacing:.05em; color:#fff; background:var(--nbk-ink); padding:1px 9px 2px; border-radius:10px; box-shadow:0 1px 3px rgba(0,0,0,.35); opacity:.95; pointer-events:none; }
  `;
  const style = document.createElement('style');
  style.id = 'nbk-styles';
  style.textContent = css;
  document.head.appendChild(style);

  // ── DOM ──────────────────────────────────────────────────────────────────
  const stage = document.createElement('div');
  stage.id = 'nbk-stage';
  stage.innerHTML = `
    <div class="nbk-book nbk-off" id="nbk-book">
      <div class="nbk-cover"></div>
      <div class="nbk-tabs" id="nbk-tabs"></div>
      <div class="nbk-page" id="nbk-page">
        <div class="nbk-ribbon" id="nbk-ribbon">
          <div class="nbk-ribbon-eyebrow" id="nbk-eyebrow">Composition · Notes</div>
          <div class="nbk-ribbon-title" id="nbk-game">—</div>
        </div>
        <div class="nbk-holes" id="nbk-holes"></div>
        <div class="nbk-head" id="nbk-head">General Notes<span class="nbk-ul"></span></div>
        <div class="nbk-notes" id="nbk-notes"></div>
        <div class="nbk-pageind" id="nbk-pageind"></div>
        <div id="nbk-burn"></div>
      </div>
    </div>`;
  // append once DOM is ready
  if (document.body) document.body.appendChild(stage);
  else document.addEventListener('DOMContentLoaded', () => document.body.appendChild(stage));

  const $ = (id) => stage.querySelector('#' + id) || document.getElementById(id);
  const bookEl = $('nbk-book');
  const pageEl = $('nbk-page');
  const notesEl = $('nbk-notes');
  const tabsEl = $('nbk-tabs');
  const gameEl = $('nbk-game');
  const eyebrowEl = $('nbk-eyebrow');
  const ribbonEl = $('nbk-ribbon');
  const headEl = $('nbk-head');
  const burnEl = $('nbk-burn');
  const pageIndEl = $('nbk-pageind');
  (function holes(){ const h = $('nbk-holes'); for (let i=0;i<8;i++) h.appendChild(document.createElement('i')); })();

  const TAB_COLORS = ['var(--nbk-t1)','var(--nbk-t2)','var(--nbk-t3)','var(--nbk-t4)','var(--nbk-t5)'];

  // ── Genre → ribbon palette ────────────────────────────────────────────────
  // Frontend-only inference from the game/category name (the backend only knows
  // the name). Matched genres get a themed color + label; everything else gets a
  // stable hashed color so each game still has its own distinct ribbon.
  const GENRES = {
    romhack:      { label:'ROMHACK',      c:['#5b616b','#34383f','#15171b'] },
    platformer:   { label:'PLATFORMER',   c:['#7ed957','#3fa130','#1f5c18'] },
    horror:       { label:'HORROR',       c:['#d0473b','#8e221a','#480f0b'] },
    rpg:          { label:'RPG',          c:['#8a6cff','#5b3fd6','#2f1f7e'] },
    souls:        { label:'SOULSLIKE',    c:['#caa15f','#8a6a32','#473216'] },
    shooter:      { label:'SHOOTER',      c:['#ef8b35','#b8601a','#6b350d'] },
    racing:       { label:'RACING',       c:['#3a93c9','#1f6391','#103a57'] },
    fighting:     { label:'FIGHTING',     c:['#ec4f9c','#b51e6f','#67093f'] },
    puzzle:       { label:'PUZZLE',       c:['#1fc6a6','#0e8c73','#054236'] },
    metroidvania: { label:'METROIDVANIA', c:['#5fb0e8','#2f7fc0','#163f63'] },
    adventure:    { label:'ADVENTURE',    c:['#f2c14e','#cc9a2b','#7a5c10'] },
    chatting:     { label:'JUST CHATTING',c:['#9b6dd6','#6f43ad','#3c2068'] },
    _default:     { label:null,           c:['#3f5d8c','#243a5e','#13233c'] },
  };
  const GENRE_RULES = [
    [/silent hill|resident evil|outlast|amnesia|phasmo|dead space|fnaf|five nights|fatal frame|cry of fear|horror|dredge|alien isolation/, 'horror'],
    [/elden ring|dark souls|sekiro|bloodborne|lies of p|nioh|lords of the fallen|souls/, 'souls'],
    [/metroid|hollow knight|ori |blasphemous|guacamelee|axiom verge|castlevania|ender lilies/, 'metroidvania'],
    [/mario|kaizo|sonic|celeste|donkey kong|rayman|shovel knight|super meat boy|platformer/, 'platformer'],
    [/final fantasy|persona|dragon quest|elder scrolls|skyrim|witcher|pok[eé]mon|baldur|rpg|diablo|undertale/, 'rpg'],
    [/call of duty|halo|doom|counter-strike|valorant|apex|overwatch|borderlands|fps|shooter|titanfall/, 'shooter'],
    [/forza|gran turismo|mario kart|need for speed|racing|f1 |dirt |trackmania/, 'racing'],
    [/street fighter|tekken|smash|mortal kombat|guilty gear|brawlhalla|fighting/, 'fighting'],
    [/tetris|portal|baba is you|sudoku|picross|puzzle|the witness|talos/, 'puzzle'],
    [/zelda|tunic|outer wilds|adventure|ocarina|a link|okami/, 'adventure'],
    [/just chatting|talk shows|podcast|asmr/, 'chatting'],
  ];
  function genreFor(game, type) {
    if (type === 'smw-hack') return 'romhack';
    const g = (game || '').toLowerCase();
    for (const [re, key] of GENRE_RULES) if (re.test(g)) return key;
    return null;
  }
  function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return Math.abs(h); }
  function applyRibbon(game, type) {
    const key = genreFor(game, type);
    let pal, label;
    if (key) { pal = GENRES[key].c; label = GENRES[key].label; }
    else {
      const keys = Object.keys(GENRES).filter(k => k !== '_default');
      pal = GENRES[keys[hashStr(game || '') % keys.length]].c;
      label = null; // unknown genre → colorful but generic eyebrow
    }
    ribbonEl.style.setProperty('--rc1', pal[0]);
    ribbonEl.style.setProperty('--rc2', pal[1]);
    ribbonEl.style.setProperty('--rc-dark', pal[2]);
    eyebrowEl.textContent = (label ? label : 'Composition') + ' · Notes';
    gameEl.textContent = game || 'No Game';
  }

  let prev = { game:null, currentChapterId:null, notes:[] };
  let focusNum = null;
  let firstRender = true;
  const nodeMap = new Map();   // note id -> <div.nbk-note> (persistent for transitions)

  // ── Visibility state machine ──────────────────────────────────────────────
  // 'hidden'    = swiped off-screen (default; reveals transiently when a note is added)
  // 'pinned'    = permanently shown via !note show
  // 'transient' = shown because a note was just added; auto-hides after 20s
  let mode = 'hidden';
  let hideTimer = null;
  const AUTO_HIDE_MS = 20000;

  // Set while the notebook is swiping off screen for a game/chapter change. The
  // service fires note:notebook and note:render back to back, so without this the
  // notes swap ~immediately and you watch the old book turn into the new one on
  // its way out. Renders that arrive mid-swipe are held and applied once it is
  // actually off screen; only the newest matters, so it's a single slot.
  let swapping = false;
  let pendingRender = null;

  function esc(s){ return String(s).replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m])); }

  function showBook() { clearTimeout(hideTimer); hideTimer = null; bookEl.classList.remove('nbk-off'); }
  function hideBook() { clearTimeout(hideTimer); hideTimer = null; bookEl.classList.add('nbk-off'); }
  function transientShow() {
    showBook();
    hideTimer = setTimeout(() => { hideTimer = null; if (mode === 'transient') { mode = 'hidden'; bookEl.classList.add('nbk-off'); } }, AUTO_HIDE_MS);
  }
  function applyVisibility(state, hasNewNote) {
    if (state.enabled === false) { mode = 'hidden'; hideBook(); return; }
    if (state.visible === true) { mode = 'pinned'; showBook(); return; } // !note show
    if (mode === 'pinned') { mode = 'hidden'; hideBook(); }              // just got unpinned
    if (hasNewNote) { mode = 'transient'; transientShow(); }             // swipe in → 20s → out
    // otherwise leave as-is (hidden stays hidden; a running transient keeps counting)
  }

  // ── Sub-page pagination ────────────────────────────────────────────────────
  // Notes overflow into pages (measured by height). There is NO auto-cycling: the
  // current page stays put until a command (!note page …) moves it, or a newly
  // added note lands on a different page (then we jump to show it being written).
  let pages = [];           // array of arrays of .nbk-note elements
  let curPage = 0;
  let clearingAll = false;  // set by note:animate:clear → removed notes fade (not crumple)

  // Animate a page turn: the notes slide out, swap at the midpoint, slide back in.
  function turnPage(toIdx) {
    notesEl.classList.remove('nbk-turn'); void notesEl.offsetWidth; notesEl.classList.add('nbk-turn');
    setTimeout(() => showPage(toIdx), 250);
  }

  function repaginate(toLast) {
    const notes = Array.from(notesEl.querySelectorAll('.nbk-note')).filter(el => !el.classList.contains('nbk-deleting') && !el.classList.contains('nbk-fading'));
    notes.forEach(el => { el.style.display = ''; });          // un-hide to measure
    const maxH = notesEl.clientHeight || 1;
    pages = [[]];
    let pi = 0, h = 0;
    for (const el of notes) {
      const eh = el.offsetHeight;
      if (h + eh > maxH && pages[pi].length) { pi++; pages[pi] = []; h = 0; }
      pages[pi].push(el);
      h += eh;
    }
    // Jump to the last page only when a new note was just added (to show it written).
    // Otherwise hold the current page (clamped if pages shrank, e.g. after a delete).
    if (toLast) curPage = pages.length - 1;
    curPage = Math.max(0, Math.min(curPage, pages.length - 1));
    showPage(curPage);
  }

  function showPage(idx) {
    if (!pages.length) { pageIndEl.style.display = 'none'; return; }
    curPage = Math.max(0, Math.min(idx, pages.length - 1));
    const show = new Set(pages[curPage]);
    // leave crumpling/fading notes alone so their removal animation stays visible
    notesEl.querySelectorAll('.nbk-note:not(.nbk-deleting):not(.nbk-fading)').forEach(el => { el.style.display = show.has(el) ? '' : 'none'; });
    if (pages.length > 1) { pageIndEl.textContent = (curPage + 1) + ' / ' + pages.length; pageIndEl.style.display = 'block'; }
    else pageIndEl.style.display = 'none';
  }

  // Manual page navigation (from !note page next|prev|<n>). Reveals the notebook
  // if hidden and turns to the page; it then STAYS there until moved again.
  function gotoPage(data) {
    if (pages.length <= 1) return;
    if (mode !== 'pinned') { mode = 'transient'; transientShow(); }
    let next = curPage;
    if (data.dir === 'next') next = (curPage + 1) % pages.length;
    else if (data.dir === 'prev') next = (curPage - 1 + pages.length) % pages.length;
    else if (typeof data.page === 'number') next = data.page - 1; // 1-based
    next = Math.max(0, Math.min(next, pages.length - 1));
    if (next === curPage) return;
    turnPage(next);
  }

  // ── Render (authoritative state; notes are reconciled in place so state
  // changes animate via CSS transitions) ────────────────────────────────────
  function render(state) {
    const gameChanged = state.game !== prev.game;
    const chapterChanged = state.currentChapterId !== prev.currentChapterId;
    const sameContext = !gameChanged && !chapterChanged;

    applyRibbon(state.game, state.type);
    const activeTab = (state.chapters || []).find(c => c.id === state.currentChapterId);
    headEl.innerHTML = (activeTab ? esc(activeTab.title) : 'General Notes') + '<span class="nbk-ul"></span>';
    renderTabs(state);

    if ((gameChanged || chapterChanged) && prev.game !== null) {
      notesEl.classList.remove('nbk-turn'); void notesEl.offsetWidth; notesEl.classList.add('nbk-turn');
    }

    // New game/chapter = fresh page: drop all nodes (no per-note animation).
    if (!sameContext) { nodeMap.forEach(el => el.remove()); nodeMap.clear(); }

    const prevById = new Map((sameContext ? prev.notes : []).map(n => [n.id, n]));
    let hasNewNote = false;
    let newNoteEl = null, newNoteData = null;  // the just-added note, animated AFTER pagination
    const seen = new Set();

    state.notes.forEach(n => {
      seen.add(n.id);
      let el = nodeMap.get(n.id);
      const before = prevById.get(n.id);
      if (!el) {
        el = buildNote(n);
        nodeMap.set(n.id, el);
        notesEl.appendChild(el);
        setBody(el, n);                     // full content first so pagination measures real height
        if (sameContext && !before && !firstRender) {
          hasNewNote = true;
          el.classList.add('nbk-adding');
          newNoteEl = el; newNoteData = n;  // defer the writing animation until it's on its page
        }
      } else {
        // update existing node in place → done/undone/scratch animate via CSS
        if (!before || before.text !== n.text || JSON.stringify(before.emotes) !== JSON.stringify(n.emotes)) setBody(el, n);
        el.classList.toggle('nbk-done', !!n.done);
        el.classList.toggle('nbk-scratched', !!n.scratched);
      }
      if (focusNum != null && n.number === focusNum) { el.classList.remove('nbk-focus'); void el.offsetWidth; el.classList.add('nbk-focus'); }
    });

    // remove notes that are gone (fade on clear-all, crumple on single delete)
    for (const [id, el] of Array.from(nodeMap)) {
      if (!seen.has(id)) {
        nodeMap.delete(id);
        if (sameContext) {
          const fade = clearingAll;
          el.classList.add(fade ? 'nbk-fading' : 'nbk-deleting');
          setTimeout(() => el.remove(), fade ? 450 : 600);
        } else el.remove();
      }
    }

    // keep DOM order in sync with state (appendChild relocates existing nodes)
    state.notes.forEach(n => { const el = nodeMap.get(n.id); if (el) notesEl.appendChild(el); });

    let empty = notesEl.querySelector('.nbk-empty');
    if (!state.notes.length && !empty) { empty = document.createElement('div'); empty.className = 'nbk-empty'; empty.textContent = '( no notes yet — !note <text> )'; notesEl.appendChild(empty); }
    else if (state.notes.length && empty) empty.remove();

    repaginate(hasNewNote);              // recompute sub-pages; jump to newest note's page
    applyVisibility(state, hasNewNote);

    // Now that the new note is measured + placed on a page that fits its FULL size,
    // clear it and type it out — it's the last note on its page so it can grow
    // downward freely without overflowing or shifting other notes.
    if (newNoteEl) typewrite(newNoteEl, newNoteData);

    focusNum = null;
    firstRender = false;
    clearingAll = false;
    prev = { game: state.game, currentChapterId: state.currentChapterId, notes: state.notes.map(x => ({ ...x })) };
  }

  function buildNote(n) {
    const el = document.createElement('div');
    el.className = 'nbk-note';
    el.dataset.id = n.id;
    if (n.done) el.classList.add('nbk-done');
    if (n.scratched) el.classList.add('nbk-scratched');
    const box = document.createElement('span'); box.className = 'nbk-box';
    const num = document.createElement('span'); num.className = 'nbk-num'; num.textContent = n.number + '.';
    const body = document.createElement('span'); body.className = 'nbk-body';
    el.appendChild(box); el.appendChild(num); el.appendChild(body);
    return el;
  }

  // Fill a note body with its content (text + inline emotes). Strikethrough for
  // done/scratch is pure CSS (text-decoration), so no extra element is needed.
  function setBody(el, n) {
    el.querySelector('.nbk-body').innerHTML = buildBodyHtml(n.text, n.emotes);
  }

  // Writing animation — reveal the note one unit at a time (each character, or an
  // emote as a single unit), capped to ~1.1s total so long notes don't crawl.
  function typewrite(el, n) {
    const body = el.querySelector('.nbk-body');
    body.innerHTML = '';
    const caret = document.createElement('span'); caret.className = 'nbk-caret';
    body.appendChild(caret);
    const units = tokenizeUnits(n.text, n.emotes);
    // steady ~55ms/char writing pace; only very long notes speed up to fit ~4.5s
    const CHAR_MS = 55, MAX_MS = 4500;
    const per = Math.min(CHAR_MS, MAX_MS / Math.max(1, units.length));
    let i = 0;
    (function step() {
      if (!body.isConnected) return;
      if (i >= units.length) { caret.remove(); return; } // already paginated at full size before typing
      const u = units[i++];
      const node = u.emote
        ? Object.assign(document.createElement('img'), { className: 'nbk-emote', src: hiResEmote(u.url), alt: u.name, title: u.name })
        : document.createTextNode(u.ch);
      body.insertBefore(node, caret);
      setTimeout(step, per);
    })();
  }

  // Split text into reveal units: each char individually, each emote token as one.
  function tokenizeUnits(text, emotes) {
    emotes = emotes || {};
    const units = [];
    for (const tok of String(text).split(/(\s+)/)) {
      if (Object.prototype.hasOwnProperty.call(emotes, tok)) units.push({ emote: true, url: emotes[tok], name: tok });
      else for (const ch of tok) units.push({ emote: false, ch });
    }
    return units;
  }

  // Streamer.bot hands us the 28px (1.0) emote URL, which is too few pixels to
  // render sharply when scaled — bump Twitch CDN URLs to 3.0 (112px) so they
  // downscale to the display size crisply. Non-Twitch URLs are left untouched.
  function hiResEmote(url) {
    // replace the Twitch scale segment (1.0/2.0 → 3.0), tolerating a trailing
    // slash or query string after it
    return String(url).replace(/\/[12]\.0(?=$|[/?])/, '/3.0');
  }

  // Turn a note's text into HTML, swapping any whitespace-delimited token that
  // matches an emote name for its <img>. Everything else is escaped.
  function buildBodyHtml(text, emotes) {
    emotes = emotes || {};
    return String(text).split(/(\s+)/).map(tok => {
      if (Object.prototype.hasOwnProperty.call(emotes, tok)) {
        // alt shows the emote name if the image ever fails to load
        return `<img class="nbk-emote" src="${esc(hiResEmote(emotes[tok]))}" alt="${esc(tok)}" title="${esc(tok)}">`;
      }
      return esc(tok);
    }).join('');
  }

  function renderTabs(state) {
    tabsEl.innerHTML = '';
    (state.chapters || []).forEach((c, i) => {
      const t = document.createElement('div');
      t.className = 'nbk-tab' + (c.id === state.currentChapterId ? ' nbk-active' : '');
      t.style.background = TAB_COLORS[i % TAB_COLORS.length];
      t.innerHTML = esc(c.title) + ' <span class="nbk-cnt">(' + c.noteCount + ')</span>';
      tabsEl.appendChild(t);
    });
  }

  // ── Flourishes ────────────────────────────────────────────────────────────
  // Swipe fully off to the left, swap contents while it's off screen, swipe back.
  // The 540ms clears the .nbk-book transform transition (.5s) — cutting it short
  // reverses mid-swipe, so the notebook never actually leaves and you see it
  // stall and bounce instead. No .nbk-turn here on purpose: the notes changed
  // off screen, so a page-turn on top of the swipe is invisible noise. (Real
  // sub-page flips still use .nbk-turn — see gotoPage.)
  function onNotebookChange() {
    if (bookEl.classList.contains('nbk-off')) return; // hidden: nothing to swipe
    swapping = true;
    bookEl.classList.add('nbk-closing');
    setTimeout(() => {
      // Off screen now — swap the contents where nobody can see it, then return.
      swapping = false;
      if (pendingRender) { const d = pendingRender; pendingRender = null; render(d); }
      bookEl.classList.remove('nbk-closing');
    }, 540);
  }
  function onClear() { burnEl.classList.remove('nbk-go'); void burnEl.offsetWidth; burnEl.classList.add('nbk-go'); }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.NotesOverlay = {
    /** Call inside host ws.onopen — subscribes + requests state. */
    attach(ws) {
      try {
        ws.send(JSON.stringify({ event: 'subscribe-to-service', service: 'notes' }));
        ws.send(JSON.stringify({ event: 'note:state-request', service: 'notes' }));
      } catch (_) {}
    },
    /** Call for any "note:" event. Returns true if consumed. */
    handle(event, data) {
      data = data || {};
      switch (event) {
        // Held until the swipe-out finishes, so the notes never change on screen.
        case 'note:render':        if (swapping) { pendingRender = data; return true; }
                                   render(data); return true;
        case 'note:notebook':      onNotebookChange(); return true;
        case 'note:page':          gotoPage(data); return true;
        case 'note:animate:clear': clearingAll = true; return true; // next render fades the notes out
        // !note show pins via the next render; here we just capture the focus note.
        case 'note:animate:show':  focusNum = (data.focus != null ? data.focus : null); return true;
        // !note hide / off must hide immediately, even mid-transient.
        case 'note:animate:hide':  mode = 'hidden'; hideBook(); return true;
        // add / done / undone / scratch / delete are realized by the following
        // note:render diff — single source of truth, no double-animation.
        default: return event.indexOf('note:') === 0; // consume any other note:* silently
      }
    }
  };
})();
