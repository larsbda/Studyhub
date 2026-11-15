/* ===================================================================
   StudyHub Chinese: Pleco flashcards in sets, look-alike characters side by side, a tap-to-define reader,
   and reading texts built from your weak words (the prompt goes to Claude Code, which writes the text file).
   Loaded before the main script: everything here runs only when called, so it can use the main script's
   globals (P, UI, esc, $, main, go, toast, saveP, saveUI, shuffle, mergeItems, DAY, bumpDay).
   =================================================================== */
const ZH = { deck: null, cards: [], byId: new Map(), bySimp: new Map(), scorePct: new Map(), dict: null, dictP: null,
  fileTexts: [], textsDir: '', live: null, ver: 0, cur: null, sel: new Set(), open: new Set(), pending: null, poll: 0, prompt: '' };
const ZH_INT = [0, 0.5, 1, 3, 7, 16, 35, 80];       // days until the next review, per box (0 = never reviewed here)
const ZH_HAN = /\p{Script=Han}/u;
const ZH_WEAK = 0.35;                                // weakness from which a card counts as weak
const LS_ZHS = 'studyhub.zhsession.v1';
let ZS = null;                                       // running flashcard set (separate from the course `session`)
const zhServed = () => /^https?:$/.test(location.protocol);

/* ---------- progress (synced, inside P) ---------- */
function zhP() { const z = P.zh = P.zh || {}; for (const k of ['cards', 'hard', 'hardW', 'groups', 'texts', 'added']) z[k] = z[k] || {}; return z; }
const zhLive = obj => Object.entries(obj || {}).filter(([, v]) => v && !v.del);
// called from mergeP: every map merged item by item, newest t wins (deletions are kept as {del, t} so they win too)
function zhMerge(a, b) {
  if (!a) return b; if (!b) return a;
  const o = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) o[k] = mergeItems(a[k], b[k], x => x.n || 0);
  return o;
}

/* ---------- deck ---------- */
function zhSetDeck(deck) {
  ZH.deck = deck && deck.cards ? deck : { categories: [], cards: [] };
  const ids = new Set(ZH.deck.cards.map(c => c.id));
  const added = zhLive(zhP().added).filter(([id]) => !ids.has(id)).map(([id, v]) => ({ id, s: v.s, py: v.py || '', def: v.def || '', cats: ['From reader'], user: true }));
  ZH.cards = ZH.deck.cards.concat(added);
  ZH.byId = new Map(ZH.cards.map(c => [c.id, c]));
  ZH.bySimp = new Map(); ZH.cards.forEach(c => { if (!ZH.bySimp.has(c.s)) ZH.bySimp.set(c.s, c); });
  // Pleco scores have no fixed scale: use each card's rank among the reviewed cards
  const sc = ZH.cards.filter(c => c.pl && c.pl.n).map(c => c.pl.score).sort((x, y) => x - y);
  ZH.scorePct = new Map();
  ZH.cards.forEach(c => {
    if (!(c.pl && c.pl.n)) return;
    let lo = 0, hi = sc.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sc[m] < c.pl.score) lo = m + 1; else hi = m; }
    ZH.scorePct.set(c.id, sc.length > 1 ? lo / (sc.length - 1) : 0.5);
  });
}
function zhInit() {
  if (ZH.deck) return;
  const B = window.STUDYHUB_ZH || {};
  zhSetDeck(B.deck); ZH.fileTexts = B.texts || [];
  if (location.protocol === 'file:') ZH.textsDir = decodeURIComponent(location.pathname).replace(/\/[^/]*$/, '') + '/content/_chinese/texts';
}
// when served, read the deck and the texts fresh (new Pleco import or a text Claude Code just wrote, without a rebuild)
function zhLoad(force) {
  if (!zhServed() || (ZH.live && !force)) return ZH.live || Promise.resolve();
  ZH.live = Promise.all([
    fetch('content/_chinese/deck.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch('/zh-api/texts', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null)
  ]).then(([deck, tx]) => {
    let changed = false;
    if (deck && deck.imported !== (ZH.deck && ZH.deck.imported)) { zhSetDeck(deck); changed = true; }
    if (tx) { ZH.textsDir = tx.dir || ZH.textsDir; const ids = t => t.map(x => x.id).join(); if (ids(tx.texts || []) !== ids(ZH.fileTexts)) { ZH.fileTexts = tx.texts || []; changed = true; } }
    if (changed) ZH.ver++;
    ZH.liveDone = true;
    return changed;
  });
  return ZH.live;
}

/* ---------- dictionary (CC-CEDICT, vendor/cedict.tsv, only when served) ---------- */
function zhDict() {
  if (ZH.dict || !zhServed()) return Promise.resolve(ZH.dict);
  return ZH.dictP || (ZH.dictP = fetch('vendor/cedict.tsv').then(r => r.ok ? r.text() : null).then(t => {
    if (!t) return null;
    const m = new Map();
    for (const line of t.split('\n')) {
      if (!line || line[0] === '#') continue;
      const a = line.split('\t'), e = { py: a[2], def: a[3], t: a[1] }, l = m.get(a[0]);
      if (l) l.push(e); else m.set(a[0], [e]);
    }
    ZH.dict = m; return m;
  }).catch(() => null));
}
// dictionary entries for a word, everyday readings before names (capitalised pinyin)
const zhRank = e => (/^[A-Z]/.test(e.py) ? 1 : 0) + (/^(variant of|old variant|see |used in)[^/]*$/i.test(e.def) ? 2 : 0);
const zhDictGet = w => ZH.dict && ZH.dict.get(w) ? ZH.dict.get(w).slice().sort((x, y) => zhRank(x) - zhRank(y)) : [];
/* Pleco definitions: "noun 1 sports referee; judge 他应邀… Tā yìngyāo… He is asked… 2 law judgment …\nverb …".
   Parsed into parts of speech > numbered meanings > examples (characters, pinyin, English). */
const ZH_POS = /^(noun|verb|adjective|idiom|adverb|pronoun|conjunction|measure word|number|numeral|auxiliary|preposition|interjection|affix|particle|onomatopoeia|prefix|suffix|phrase|classifier)\b\s*/i;
const ZH_TAG = /^(sports|law|abbreviation|colloquial|literary|computing|chemistry|physics|medicine|mathematics|biology|music|military|economics|finance|dialect|formal|informal|figurative|derogatory|polite|humble|archaic|botany|zoology|entomology|linguistics|grammar|religion|Buddhism|politics|written|spoken|euphemism|slang|internet|commerce|business|electricity|geography|geology|history|philosophy|psychology|statistics|transport|agriculture|architecture|astronomy|cooking|art|photography|printing|mechanics|engineering|anatomy|physiology|pharmacology|meteorology|education|journalism|sociology|traditional Chinese medicine)\s+/i;
const ZH_TONE = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/i;
const ZH_NEUT = new Set('de le ma ne ba zi men a ya la me ge li tou zhe guo r er wa na'.split(' '));
const zhIsPleco = def => ZH_POS.test(def || '') || /^1\s/.test(def || '');
function zhSenseSplit(t) {            // "1 a 2 b 3 c" -> [a, b, c]; numbers must come in order
  t = t.trim(); if (!/^1\s/.test(t)) return [t];
  const out = []; let cur = t.slice(2), k = 2;
  for (;;) { const m = cur.search(new RegExp('\\s' + k + '\\s')); if (m < 0) { out.push(cur); break; } out.push(cur.slice(0, m)); cur = cur.slice(m + String(k).length + 2); k++; }
  return out.map(x => x.trim()).filter(Boolean);
}
function zhSense(t) {
  const w = t.split(/\s+/).filter(Boolean), isZh = x => ZH_HAN.test(x) || /^[　-〿＀-￯—…]+$/.test(x);
  let depth = 0, k = 0;
  for (; k < w.length; k++) { if (depth === 0 && isZh(w[k])) break; depth += (w[k].match(/[([]/g) || []).length - (w[k].match(/[)\]]/g) || []).length; if (depth < 0) depth = 0; }
  let m = w.slice(0, k).join(' '), tag = '';
  const tm = ZH_TAG.exec(m); if (tm && m.length > tm[0].length) { tag = tm[1]; m = m.slice(tm[0].length); }
  const bare = x => x.replace(/[^\p{L}-]/gu, '').toLowerCase();
  const isPy = (x, nx) => ZH_TONE.test(x) || (ZH_NEUT.has(bare(x)) && (/[.,?!;:]$/.test(x) || !nx || ZH_TONE.test(nx) || ZH_NEUT.has(bare(nx))));
  const ex = []; let e = null, st = '';
  for (let i = k; i < w.length; i++) {
    const x = w[i];
    if (isZh(x) && st !== 'py') { if (st !== 'zh') { e = { zh: [], py: [], en: [] }; ex.push(e); } e.zh.push(x); st = 'zh'; continue; }
    if (isZh(x)) { e = { zh: [x], py: [], en: [] }; ex.push(e); st = 'zh'; continue; }
    if (st === 'zh' || st === 'py') {
      const endPy = st === 'py' && /[.?!]$/.test(e.py[e.py.length - 1] || '');
      if (!endPy && (isPy(x, w[i + 1]) || /^[—–-]+$/.test(x))) { e.py.push(x); st = 'py'; continue; }
      st = 'en';
    }
    e.en.push(x);
  }
  return { m: m.trim(), tag, ex: ex.map(e => ({ zh: e.zh.join(' '), py: e.py.join(' '), en: e.en.join(' ') })) };
}
function zhParseDef(def) {
  return String(def || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const pm = ZH_POS.exec(l), pos = pm ? pm[1] : '';
    return { pos, senses: zhSenseSplit(pm ? l.slice(pm[0].length) : l).map(zhSense) };
  });
}
// short meaning for chips, the sheet and prompts: the first meanings, no examples
function zhGloss(def, n = 2) { return zhParseDef(def).flatMap(b => b.senses.map(x => x.m)).filter(Boolean).slice(0, n).join('; ') || String(def || '').slice(0, 80); }
function zhDefHtml(def) {
  const blocks = zhParseDef(def);
  const sense = (x, i, many) => {
    const ex = x.ex.map(e => `<div class="zh-ex1"><div lang="zh" class="zh-exz">${esc(e.zh)}</div>${e.py ? `<div class="zh-exp">${esc(e.py)}</div>` : ''}${e.en ? `<div class="zh-exe">${esc(e.en)}</div>` : ''}</div>`);
    return `<li class="zh-sense">${many ? `<span class="zh-sn">${i + 1}</span>` : ''}<div>${x.tag ? `<span class="zh-tag">${esc(x.tag)}</span> ` : ''}<b class="zh-m">${esc(x.m)}</b>
      ${ex.length ? `<div class="zh-exs">${ex.slice(0, 2).join('')}${ex.length > 2 ? `<details class="zh-more"><summary>${ex.length - 2} more example${ex.length > 3 ? 's' : ''}</summary>${ex.slice(2).join('')}</details>` : ''}</div>` : ''}</div></li>`;
  };
  const block = b => `<div class="zh-posb">${b.pos ? `<div class="zh-pos">${esc(b.pos)}</div>` : ''}<ol class="zh-senses">${b.senses.slice(0, 6).map((x, i) => sense(x, i, b.senses.length > 1)).join('')}</ol>
    ${b.senses.length > 6 ? `<details class="zh-more"><summary>${b.senses.length - 6} more meaning${b.senses.length > 7 ? 's' : ''}</summary><ol class="zh-senses" start="7">${b.senses.slice(6).map((x, i) => sense(x, i + 6, true)).join('')}</ol></details>` : ''}</div>`;
  return blocks.map(block).join('');
}
function zhShort(def, n = 2) {
  if (zhIsPleco(def)) return zhGloss(def, n);
  const all = String(def || '').split(/\s*\/\s*|\n/).map(s => s.trim()).filter(Boolean);
  const keep = all.filter(s => !/^(surname|variant of|old variant|see |used in|abbr\. for|CL:)/i.test(s));
  return (keep.length ? keep : all).slice(0, n).join('; ');
}
function zhCharInfo(ch) {
  const d = zhDictGet(ch).map(e => ({ py: e.py, def: zhShort(e.def) }));
  if (d.length) return d;
  const c = ZH.bySimp.get(ch); return c ? [{ py: c.py, def: zhShort(c.def) }] : [];
}
const zhWordsWith = (ch, n) => ZH.cards.filter(c => c.s.includes(ch) && c.s !== ch).sort((a, b) => a.s.length - b.s.length || (zhWeak(b) || 0) - (zhWeak(a) || 0)).slice(0, n);

/* ---------- weakness and scheduling ---------- */
// 0 = solid ... 1 = weak, null = never reviewed (new). StudyHub reviews count more the more there are.
function zhWeak(c) {
  const r = zhP().cards[c.id], pl = c.pl;
  let sh = null, pw = null;
  if (r && r.n) { const h = r.h || ''; const miss = h ? [...h].filter(x => x === '0').length / h.length : 0; sh = 0.5 * miss + 0.5 * (1 - Math.min(r.b || 0, 5) / 5); }
  if (pl && pl.n) { const miss = pl.bad / Math.max(1, pl.ok + pl.bad); pw = 0.6 * miss + 0.4 * (1 - (ZH.scorePct.has(c.id) ? ZH.scorePct.get(c.id) : 0.5)); }
  if (sh === null) return pw; if (pw === null) return sh;
  const k = Math.min(0.85, 0.4 + 0.1 * r.n); return k * sh + (1 - k) * pw;
}
/* Learned score, like Pleco's: it starts from the Pleco score (0 for a card never reviewed there).
   Good +100, Easy +150, Hard +25; Don't know halves it and always drops it below the line. Learned = score >= UI.zhLearnAt (300). */
const zhLearnAt = () => Math.max(50, Math.round(+UI.zhLearnAt || 300));
function zhScore(c) { const r = zhP().cards[c.id]; return r && r.sc != null ? r.sc : c.pl ? Math.max(0, c.pl.score || 0) : 0; }
const zhLearned = c => zhScore(c) >= zhLearnAt();
const zhNewScore = (sc, lvl) => lvl === 0 ? Math.max(0, Math.min(Math.floor(sc / 2), zhLearnAt() - 100)) : sc + [0, 25, 100, 150][lvl];
function zhStartBox(c) { const w = c.pl && c.pl.n >= 2 ? zhWeak(c) : null; return w === null ? 0 : w < 0.2 ? 3 : w < 0.4 ? 2 : 1; }
// level 0 don't know, 1 hard, 2 good, 3 easy; `again` = second showing in the same set (does not raise the box)
function zhRate(c, lvl, again) {
  const z = zhP(), now = Date.now(), r = Object.assign({ b: zhStartBox(c), n: 0, ok: 0, bad: 0, h: '' }, z.cards[c.id]);
  r.sc = zhNewScore(zhScore(c), lvl);
  if (lvl === 0) { r.b = 1; r.due = now; }
  else if (lvl === 1) { r.b = Math.max(1, Math.min(r.b, 2)); r.due = now + 0.5 * DAY; }
  else if (again) { r.b = Math.max(1, Math.min(r.b, 2)); r.due = now + DAY; }
  else { r.b = Math.min(ZH_INT.length - 1, Math.max(1, r.b) + (lvl === 3 ? 2 : 1)); r.due = now + ZH_INT[r.b] * DAY; }
  r.n++; if (lvl >= 2) r.ok++; else r.bad++;
  r.h = (r.h + (lvl >= 2 ? '1' : '0')).slice(-8); r.t = now;
  z.cards[c.id] = r; bumpDay(); saveP();
}

/* ---------- flags and look-alike groups ---------- */
const zhHard = ch => { const x = zhP().hard[ch]; return !!(x && !x.del); };
const zhHardW = id => { const x = zhP().hardW[id]; return !!(x && !x.del); };
function zhGroupChars() { const s = new Set(); zhLive(zhP().groups).forEach(([, g]) => g.chars.forEach(c => s.add(c))); return s; }
function zhFlagged(c, gc = zhGroupChars()) { return zhHardW(c.id) || [...c.s].some(ch => zhHard(ch) || gc.has(ch)); }
function zhSetHard(ch, on) { zhP().hard[ch] = on ? { t: Date.now() } : { t: Date.now(), del: true }; saveP(); }
function zhGroupSave(gid, chars) {
  const z = zhP(); chars = [...new Set(chars)].filter(c => ZH_HAN.test(c));
  z.groups[gid] = chars.length ? { chars, t: Date.now() } : { t: Date.now(), del: true }; saveP();
}
const zhNewGid = () => 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

/* ---------- choosing cards ---------- */
const zhCatsOf = c => c.cats && c.cats.length ? c.cats : ['(No category)'];
function zhMatches(c, o, gc) {
  const sel = o.cats || [];
  if (sel.length && !sel.some(p => zhCatsOf(c).some(x => x === p || x.startsWith(p + '/')))) return false;
  const f = o.filter || 'all';
  if (f === 'weak') { const w = zhWeak(c); return w !== null && w >= (o.weakMin == null ? ZH_WEAK : o.weakMin); }
  if (f === 'due') { const r = zhP().cards[c.id]; return !!r && (r.due || 0) <= Date.now(); }
  if (f === 'new') return zhWeak(c) === null;
  if (f === 'learning') return !zhLearned(c);
  if (f === 'learned') return zhLearned(c);
  if (f === 'flagged') return zhFlagged(c, gc);
  return true;
}
function zhPool(o) {
  const gc = zhGroupChars();
  let cs = o.ids ? o.ids.map(id => ZH.byId.get(id)).filter(Boolean) : ZH.cards.filter(c => zhMatches(c, o, gc));
  if (o.until) cs = cs.filter(c => !zhLearned(c));      // repeat-until-learned sets only take cards not learned yet
  const ord = o.order || 'weak';
  if (ord === 'random') return shuffle(cs);
  if (ord === 'due') { const z = zhP(), d = c => { const r = z.cards[c.id]; return r ? r.due || 0 : Infinity; }; return shuffle(cs).sort((a, b) => d(a) - d(b)); }
  const w = c => { const x = zhWeak(c); return x === null ? -1 : x; };
  return shuffle(cs).sort((a, b) => w(b) - w(a));      // shuffled first, so equal scores come in a new order each time
}
const zhOpts = () => ({ cats: UI.zhCats || [], filter: UI.zhFilter || 'all', weakMin: UI.zhWeakMin == null ? ZH_WEAK : UI.zhWeakMin, order: UI.zhOrder || 'weak', until: !!UI.zhUntil });
const zhBatch = () => Math.max(1, Math.min(500, Math.round(+UI.zhBatch || 20)));

/* ---------- sets ---------- */
function zhStart(o, prev) {
  const pool = zhPool(o), seen = new Set(prev && !o.until ? prev.seen : []);
  let rest = pool.filter(c => !seen.has(c.id)), wrapped = false;
  if (!rest.length && pool.length) { rest = pool; seen.clear(); wrapped = true; }
  if (!rest.length) { toast('No cards match these choices'); return false; }
  const ids = rest.slice(0, zhBatch()).map(c => c.id);
  ids.forEach(id => seen.add(id));
  ZS = { o, ids, i: 0, flipped: false, good: 0, again: 0, req: [], missed: [], seen: [...seen], setNo: prev ? prev.setNo + 1 : 1, pool: pool.length, wrapped,
    until: !!o.until, total: ids.length, learnedN: 0, rated: [] };
  zhSave(); go('#/zh/play'); return true;
}
// Next set: new cards from the same run. After a round of just the missed cards, go back to the run it came from
// (its own pool is only those cards, so it would repeat them forever).
function zhNext() {
  const f = ZS.o.from;
  if (f) zhStart(f.o, { seen: f.seen, setNo: ZS.setNo }); else zhStart(ZS.o, ZS);
}
function zhSave() { try { if (ZS) sessionStorage.setItem(LS_ZHS, JSON.stringify(ZS)); else sessionStorage.removeItem(LS_ZHS); } catch (e) { /* the set just won't survive a reload */ } }
function zhRestore() { try { ZS = JSON.parse(sessionStorage.getItem(LS_ZHS) || 'null'); } catch (e) { ZS = null; } return !!ZS; }
const zhHead = c => UI.zhScript === 'trad' && c.t ? c.t : c.s;
function zhRateHtml() {
  return ZS.flipped
    ? `<div class="rate">${[['0', "Don't know", 'bad'], ['1', 'Hard', 'warnbtn'], ['2', 'Good', 'primary'], ['3', 'Easy', 'good']].map(([l, t, k]) => `<button class="btn ${k}" data-zh="rate" data-l="${l}">${t} <span class="kbd" style="background:transparent;color:inherit">${+l + 1}</span></button>`).join('')}</div>`
    : `<div class="rate"><button class="btn primary" data-zh="flip">Show answer</button></div>`;
}
function zhCharsHtml(word, big) {
  return [...word].map(ch => ZH_HAN.test(ch) ? `<button class="zh-ch${big ? ' big' : ''}${zhHard(ch) ? ' hard' : ''}" data-zh="char" data-c="${esc(ch)}" title="Flag or group this character">${esc(ch)}</button>` : esc(ch)).join('');
}
function zhBack(c) {
  const chars = [...c.s].filter(ch => ZH_HAN.test(ch));
  const gl = chars.length > 1 ? chars.map(ch => { const i = zhCharInfo(ch)[0]; return `<div class="zh-gl1"><button class="zh-ch" data-zh="char" data-c="${esc(ch)}" lang="zh">${esc(ch)}</button><span>${i ? `${esc(i.py)} · ${esc(i.def)}` : ''}</span></div>`; }).join('') : '';
  const r = zhP().cards[c.id], w = zhWeak(c);
  const stats = [c.pl && c.pl.n ? `Pleco ${c.pl.ok}/${c.pl.ok + c.pl.bad} right` : '', r ? `here ${r.ok}/${r.n} right` : '', w === null ? 'new' : w >= ZH_WEAK ? 'weak' : ''].filter(Boolean).join(' · ');
  const sc = zhScore(c), at = zhLearnAt();
  return `<div class="zh-ahead">
      <div class="zh-hw" lang="zh">${zhCharsHtml(zhHead(c), true)}</div>
      <div class="zh-py">${esc(c.py)} <button class="btn sm ghost" data-zh="speak" data-w="${esc(c.s)}" title="Listen (S)" aria-label="Listen">🔊</button></div>
      <div class="zh-scoreline small muted"><span class="zh-lb wide"><i style="width:${Math.min(100, Math.round(100 * sc / at))}%"></i></span> ${zhLearned(c) ? '<b class="zh-ok">learned</b>' : `score ${sc} / ${at}`}${stats ? ' · ' + stats : ''}</div></div>
    <div class="zh-defs">${zhIsPleco(c.def) ? zhDefHtml(c.def) : `<b class="zh-m">${esc(c.def).replace(/\n/g, '<br>')}</b>`}</div>
    ${gl ? `<div class="zh-gl"><div class="zh-pos">Characters</div>${gl}</div>` : ''}
    <div class="zh-afoot small muted">
      <button class="btn sm ${zhHardW(c.id) ? 'warnbtn' : 'ghost'}" data-zh="flag-word" data-id="${esc(c.id)}" title="Flag this word as hard">⚑ ${zhHardW(c.id) ? 'Flagged' : 'Flag word'}</button>
      <span>${esc(zhCatsOf(c).map(x => x.split('/').slice(-2).join(' › ')).join(', '))}</span>
      <span>Tap a character to flag it or group it with look-alikes</span></div>`;
}
function zhPlay(keep) {
  zhInit();
  if (!ZS && !zhRestore()) { location.hash = '#/zh'; return; }
  const s = ZS;
  // a card that is not in the deck yet may still arrive with the fresh deck from the server: wait for it before dropping it
  if (s.ids.slice(s.i).some(id => !ZH.byId.get(id)) && zhServed() && !ZH.liveDone) { main.innerHTML = '<p class="muted">Loading your deck…</p>'; zhLoad().then(() => { if (/^#\/zh\/play/.test(location.hash)) zhPlay(); }); return; }
  while (s.i < s.ids.length && !ZH.byId.get(s.ids[s.i])) s.ids.splice(s.i, 1);
  if (s.i >= s.ids.length) return zhEnd();
  const c = ZH.byId.get(s.ids[s.i]), r = zhP().cards[c.id], en = UI.zhDir === 'en';
  const front = en ? `<div class="zh-def big"><b>${esc(zhShort(c.def, 3))}</b></div>`
    : `<div class="zh-hw" lang="zh">${esc(zhHead(c))}</div>${UI.zhPinyin ? `<div class="zh-py">${esc(c.py)}</div>` : ''}`;
  main.innerHTML = `<div class="deck-wrap zh-play ${s.flipped ? '' : 'front'}">
    <div class="crumbs"><a href="#/zh">← Chinese</a> · Set ${s.setNo}${s.o.title ? ' · ' + esc(s.o.title) : ''}</div>
    <div class="prog-row">${s.until
      ? `<span class="small muted zh-tick"><b>${s.ids.length - s.i}</b> left · <b>${s.learnedN}</b>/${s.total} learned</span><div class="bar"><i style="width:${Math.round(100 * s.learnedN / s.total)}%"></i></div>`
      : `<span class="small muted">${s.i + 1} / ${s.ids.length}</span><div class="bar"><i style="width:${Math.round(100 * s.i / s.ids.length)}%"></i></div>`}
      <span class="leitner" title="Review box here">${[1, 2, 3, 4, 5, 6, 7].map(i => `<i class="${r && i <= r.b ? 'on' : ''}"></i>`).join('')}</span></div>
    <div class="card zh-card ${s.flipped ? 'flipped' : ''}" ${s.flipped ? '' : 'data-zh="flip" tabindex="0" role="button" aria-label="Show answer"'}>
      ${s.flipped ? zhBack(c) : `<div class="zh-front"><span class="zh-lbl">${en ? 'Meaning' : 'Word'}</span>${front}<span class="zh-hint">click or <span class="kbd">Space</span></span></div>`}</div>
    ${zhRateHtml()}
    <p class="muted small zh-keys"><span class="kbd">Space</span> flip · <span class="kbd">1</span>–<span class="kbd">4</span> rate · <span class="kbd">S</span> listen. ${s.until ? `A card leaves the set when its score reaches ${zhLearnAt()} (Good +100, Easy +150, Hard +25, Don't know halves it).` : `"Don't know" brings the card back later in this set.`}</p></div>`;
  if (keep && s.flipped) zhToCard(); else window.scrollTo({ top: 0, behavior: 'instant' });
}
// reveal: draw the answer and bring the top of the card into view (long Pleco entries otherwise start off screen)
function zhFlip() {
  if (!ZS || !$('.zh-play')) return;
  ZS.flipped = !ZS.flipped; zhSave(); zhPlay(true);
}
function zhToCard() {
  const el = $('.zh-play .zh-card'); if (!el) return;
  const bar = ($('.topbar') && getComputedStyle($('.topbar')).display !== 'none' && !document.body.classList.contains('top-hidden')) ? $('.topbar').offsetHeight : 0;
  window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + scrollY - bar - 70), behavior: 'instant' });
}
function zhRateCur(l) {
  const s = ZS, c = ZH.byId.get(s.ids[s.i]); if (!c || !s.flipped) return;
  if (s.until) {          // the card stays in the set until it is learned, then the set is one smaller
    const again = s.rated.includes(c.id); zhRate(c, l, again); if (!again) s.rated.push(c.id);
    if (l >= 2) s.good++; else { s.again++; if (!s.missed.includes(c.id)) s.missed.push(c.id); }
    s.ids.splice(s.i, 1);
    if (zhLearned(c)) { s.learnedN++; toast(`Learned: ${c.s}`); } else s.ids.splice(Math.min(s.ids.length, s.i + 4), 0, c.id);
    s.flipped = false; zhSave(); zhPlay(); return;
  }
  const again = s.req.includes(c.id);
  zhRate(c, l, again);
  if (l >= 2) s.good++; else { s.again++; if (!s.missed.includes(c.id)) s.missed.push(c.id); }
  if (l === 0 && !again) { s.req.push(c.id); s.ids.splice(Math.min(s.ids.length, s.i + 6), 0, c.id); }
  s.i++; s.flipped = false; zhSave(); zhPlay();
}
function zhEnd() {
  const s = ZS, left = Math.max(0, s.pool - s.seen.length);
  const miss = s.missed.map(id => ZH.byId.get(id)).filter(Boolean);
  main.innerHTML = `<div class="q-card card zh-end" style="text-align:center">
    <h2>${s.until ? `All ${s.total} learned` : `Set ${s.setNo} done`}</h2>
    <p class="muted">${s.good} right · ${s.again} ${s.until ? 'misses on the way' : 'to revisit'}${s.wrapped ? ' · you had been through every matching card, so this set started over' : ''}</p>
    ${miss.length ? `<details class="zh-missd"><summary>${miss.length} word${miss.length === 1 ? '' : 's'} you missed</summary><div class="zh-misslist">${miss.map(c => `<button class="zh-mrow" data-zh="word" data-w="${esc(c.s)}"><b lang="zh">${esc(zhHead(c))}</b><span class="zh-mpy">${esc(c.py)}</span><span class="zh-mm">${esc(zhShort(c.def, 2))}</span></button>`).join('')}</div></details>` : ''}
    <div class="row" style="justify-content:center;margin-top:14px">
      <button class="btn primary" data-zh="next-set">Next set of ${zhBatch()} <span class="kbd" style="background:transparent;color:inherit">Enter</span></button>
      ${miss.length ? `<button class="btn" data-zh="redo-missed">Again: the ${miss.length} I missed</button>` : ''}
      <a class="btn ghost" href="#/zh">Back</a></div>
    <p class="small muted" style="margin-top:10px">${s.until ? (() => { const n = zhPool(s.o).length; return n ? `${n} matching card${n === 1 ? '' : 's'} not learned yet.` : 'Every matching card is learned.'; })()
      : left ? `${left} matching card${left === 1 ? '' : 's'} not yet in this run.` : 'Every matching card has been in a set; the next set starts over.'}</p></div>`;
}

/* ---------- bottom sheet (character and word details) ---------- */
function zhSheet(html, anchor) {
  let el = document.getElementById('zh-sheet');
  if (!el) { el = document.createElement('div'); el.id = 'zh-sheet'; el.className = 'zh-sheet'; el.setAttribute('role', 'dialog'); document.body.appendChild(el); }
  el.innerHTML = `<button class="btn sm ghost zh-x" data-zh="sheet-close" aria-label="Close">✕</button><div class="zh-sheet-in">${html}</div>`;
  el.hidden = false; document.body.classList.add('zh-sheet-open');
  if (anchor && anchor.getBoundingClientRect) {     // keep the tapped word visible above the sheet
    const b = anchor.getBoundingClientRect().bottom, lim = innerHeight - el.offsetHeight - 12;
    if (b > lim) window.scrollBy({ top: b - lim, behavior: 'smooth' });
  }
}
function zhSheetClose() { const el = document.getElementById('zh-sheet'); if (el) el.hidden = true; document.body.classList.remove('zh-sheet-open'); }
function zhCharSheet(ch, anchor) {
  const z = zhP(), info = zhCharInfo(ch), groups = zhLive(z.groups);
  const mine = groups.filter(([, g]) => g.chars.includes(ch)), other = groups.filter(([, g]) => !g.chars.includes(ch));
  const words = zhWordsWith(ch, 6);
  zhSheet(`<div class="row" style="align-items:flex-start;gap:16px">
      <div class="zh-sbig" lang="zh">${esc(ch)}</div>
      <div style="flex:1;min-width:0">${info.length ? info.slice(0, 3).map(i => `<div><b>${esc(i.py)}</b> <span class="muted">${esc(i.def)}</span></div>`).join('') : '<div class="muted">No dictionary entry here</div>'}
        <div class="row" style="margin-top:8px">
          <button class="btn sm ${zhHard(ch) ? 'warnbtn' : ''}" data-zh="flag-char" data-c="${esc(ch)}">⚑ ${zhHard(ch) ? 'Flagged - unflag' : 'Flag as hard'}</button>
          <button class="btn sm ghost" data-zh="speak" data-w="${esc(ch)}">🔊</button></div></div></div>
    ${mine.length ? `<div class="small" style="margin-top:10px">In look-alike group${mine.length > 1 ? 's' : ''}: ${mine.map(([gid, g]) => `<a href="#/zh/compare" class="zh-chip" lang="zh">${esc(g.chars.join(' '))}</a>`).join(' ')}</div>` : ''}
    <div class="small" style="margin-top:10px"><b>Looks like…</b> ${other.length ? 'add to ' + other.slice(0, 8).map(([gid, g]) => `<button class="zh-chip" data-zh="group-add" data-g="${gid}" data-c="${esc(ch)}" lang="zh">${esc(g.chars.join(' '))} ＋</button>`).join(' ') + ' or ' : ''}
      <span class="zh-inline"><input id="zh-gnew" class="zh-in" lang="zh" placeholder="characters it looks like, e.g. 己巳" aria-label="Characters it looks like"><button class="btn sm" data-zh="group-new" data-c="${esc(ch)}">New group</button></span></div>
    ${words.length ? `<div class="small" style="margin-top:10px"><b>Your words with ${esc(ch)}:</b> ${words.map(c => `<button class="zh-chip" data-zh="word" data-w="${esc(c.s)}"><span lang="zh">${zhMark(c.s, ch)}</span> <span class="muted">${esc(zhShort(c.def, 1))}</span></button>`).join(' ')}</div>` : ''}`, anchor);
}
const zhMark = (word, ch) => [...word].map(x => x === ch ? `<mark>${esc(x)}</mark>` : esc(x)).join('');
function zhWordSheet(w, anchor) {
  const c = ZH.bySimp.get(w), g = ZH.cur && ZH.cur.glossary ? ZH.cur.glossary[w] : null, d = zhDictGet(w);
  const py = (c && c.py) || (g && g.py) || (d[0] && d[0].py) || '';
  const wk = c ? zhWeak(c) : null, tgt = ZH.cur && (ZH.cur.targets || []).includes(w);
  const lines = [g && g.en ? `<div><span class="muted small">Here:</span> ${esc(g.en)}</div>` : '', c ? `<div><span class="muted small">Your card:</span> ${esc(zhShort(c.def, 3))}</div>` : '',
    !c && !g && d[0] ? `<div>${esc(zhShort(d[0].def, 3))}</div>` : ''].join('');
  const full = d.length ? d.map(e => `<div style="margin-top:6px"><b>${esc(e.py)}</b>${e.t ? ` <span lang="zh" class="muted">${esc(e.t)}</span>` : ''}<div class="small">${esc(e.def).replace(/ \/ /g, '<br>')}</div></div>`).join('') : '<div class="muted small">No dictionary entry (the dictionary loads only when StudyHub runs through Start StudyHub).</div>';
  const chars = [...w].filter(x => ZH_HAN.test(x));
  zhSheet(`<div class="row" style="align-items:baseline;gap:14px"><div class="zh-sbig" lang="zh">${zhCharsHtml(w)}</div><div class="zh-py">${esc(py)}</div>
      <div class="row small">${c ? '<span class="pill">in your deck</span>' : ''}${wk !== null && wk >= ZH_WEAK ? '<span class="pill zh-weak">weak</span>' : ''}${tgt ? '<span class="pill zh-tgtp">target</span>' : ''}${c && zhHardW(c.id) ? '<span class="pill">flagged</span>' : ''}</div></div>
    <div style="margin-top:6px">${lines || '<span class="muted">Not in your deck or the dictionary</span>'}</div>
    <div class="row" style="margin-top:10px">
      <button class="btn sm" data-zh="full">Definition</button>
      <button class="btn sm ghost" data-zh="speak" data-w="${esc(w)}">🔊 Listen</button>
      ${c ? `<button class="btn sm ${zhHardW(c.id) ? 'warnbtn' : 'ghost'}" data-zh="flag-word" data-id="${esc(c.id)}">⚑ ${zhHardW(c.id) ? 'Flagged' : 'Flag'}</button>`
        : chars.length ? `<button class="btn sm ghost" data-zh="add-word" data-w="${esc(w)}" data-py="${esc(py)}" data-def="${esc((g && g.en) || (d[0] ? zhShort(d[0].def, 3) : ''))}">＋ Add to deck</button>` : ''}</div>
    <div class="zh-full" hidden>${full}${chars.length > 1 ? `<div style="margin-top:10px" class="small"><b>Characters</b>${chars.map(ch => { const i = zhCharInfo(ch)[0]; return `<div><button class="zh-ch" data-zh="char" data-c="${esc(ch)}">${esc(ch)}</button> ${i ? esc(i.py) + ' · ' + esc(i.def) : ''}</div>`; }).join('')}</div>` : ''}</div>`, anchor);
}

/* ---------- views ---------- */
function viewZh(r) {
  zhInit();
  const sub = r.sub || '';
  document.title = 'StudyHub · Chinese';
  if (sub !== 'read' || !r.arg) ZH.cur = null;
  if (sub === 'play') zhPlay();
  else if (sub === 'compare') zhCompare();
  else if (sub === 'read' && r.arg) zhReadText(r.arg);
  else if (sub === 'read') zhReader();
  else zhHome();
  // fresh deck / texts and the dictionary arrive after the first draw: redraw the same page in place
  const h = location.hash, v0 = ZH.ver, d0 = !!ZH.dict;
  Promise.all([zhLoad(), zhDict()]).then(() => {
    if (location.hash !== h || sub === 'play') return;
    if (ZH.ver !== v0 || !!ZH.dict !== d0) { const y = scrollY; viewZh(r); window.scrollTo(0, y); }
  });
}
function zhStats() {
  const z = zhP(), now = Date.now(), gc = zhGroupChars();
  let weak = 0, rev = 0, due = 0, fl = 0, learned = 0;
  ZH.cards.forEach(c => { const w = zhWeak(c), r = z.cards[c.id]; if (w !== null && w >= ZH_WEAK) weak++; if (r) { rev++; if ((r.due || 0) <= now) due++; } if (zhFlagged(c, gc)) fl++; if (zhLearned(c)) learned++; });
  return { total: ZH.cards.length, weak, rev, due, fl, learned, groups: zhLive(z.groups).length };
}
// Pleco categories nest with "/" (HSK 3.0 (2026)/Level 4/Set 27): shown as folders. Ticking a folder includes everything in it.
function zhCatData() {
  const counts = new Map(), learned = new Map();
  ZH.cards.forEach(c => { const s = new Set(), l = zhLearned(c); zhCatsOf(c).forEach(cat => { const p = cat.split('/'); for (let i = 1; i <= p.length; i++) s.add(p.slice(0, i).join('/')); }); s.forEach(p => { counts.set(p, (counts.get(p) || 0) + 1); if (l) learned.set(p, (learned.get(p) || 0) + 1); }); });
  const kids = new Map();
  [...counts.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).forEach(p => { const i = p.lastIndexOf('/'), par = i < 0 ? '' : p.slice(0, i); if (!kids.has(par)) kids.set(par, []); kids.get(par).push(p); });
  return { counts, kids, learned };
}
const zhCatOpen = kids => new Set(UI.zhOpen || kids.get('') || []);       // top-level folders start open
const zhCatName = p => p.slice(p.lastIndexOf('/') + 1);
function zhCatTree() {
  const { counts, kids, learned } = zhCatData(), sel = new Set(UI.zhCats || []), open = zhCatOpen(kids);
  let n = 0;
  const node = (p, inherited) => {
    const ch = kids.get(p) || [], name = zhCatName(p), isOpen = open.has(p), on = sel.has(p) || inherited;
    const part = on ? 0 : [...sel].filter(x => x.startsWith(p + '/')).length, id = 'zc' + n++;
    return `<div class="zh-cat${inherited ? ' inh' : ''}">${ch.length ? `<button class="zh-tw" data-zh="cat-open" data-p="${esc(p)}" aria-expanded="${isOpen}" aria-label="${isOpen ? 'Close' : 'Open'} ${esc(name)}">${isOpen ? '▾' : '▸'}</button>` : '<span class="zh-tw"></span>'}
      <input type="checkbox" id="${id}" data-zc="cat" value="${esc(p)}" ${on ? 'checked' : ''} ${inherited ? 'disabled title="Included: the folder above is ticked"' : ''} ${part ? 'data-part="1"' : ''}>
      ${ch.length ? `<button class="zh-cn" data-zh="cat-open" data-p="${esc(p)}">${esc(name)}</button>` : `<label class="zh-cn" for="${id}">${esc(name)}</label>`}
      <span class="muted small">${counts.get(p)}${part && !isOpen ? ` · ${part} ticked inside` : ''}</span>${p === ZH.lastTick && sel.has(p) && p.includes('/') && zhCatUp(p, kids).length > 1 ? `<button class="zh-up" data-zh="cat-up" data-p="${esc(p)}" title="Tick ${esc(name)} and everything before it">↑ and up</button>` : ''}${zhLearnBar(learned.get(p) || 0, counts.get(p))}</div>
      ${ch.length ? `<div class="zh-catk${isOpen ? ' open' : ''}">${ch.map(x => node(x, on)).join('')}</div>` : ''}`;
  };
  return (kids.get('') || []).map(x => node(x, false)).join('');
}
const zhLearnBar = (l, n) => `<span class="zh-lb" title="${l} of ${n} learned"><i style="width:${Math.round(100 * l / n)}%"></i></span><span class="small muted zh-lbn">${l === n ? '✓' : Math.round(100 * l / n) + '%'}</span>`;
// "and up": this folder and everything before it, at every level inside the same top folder.
// Set 10 in Level 5 -> Set 01 ... Set 10 of Level 5, and Levels 1-4.
function zhCatUp(p, kids) {
  const out = []; let cur = p;
  while (cur.includes('/')) {
    const par = cur.slice(0, cur.lastIndexOf('/')), sib = kids.get(par) || [];
    out.push(...sib.slice(0, sib.indexOf(cur) + (cur === p ? 1 : 0)));
    cur = par;
  }
  return out;
}
function zhCatHead() { return (UI.zhCats || []).length ? '<button class="btn sm ghost" data-zh="cats-clear">Clear</button>' : ''; }
// after the tree is drawn: half-ticked folders (something inside is ticked) get the dash
function zhTreeFix() { $$('.zh-tree input[data-part]').forEach(i => { i.indeterminate = true; }); }
function zhTreeRedraw() {
  const t = $('.zh-tree'); if (!t) return;
  const y = t.scrollTop; t.innerHTML = zhCatTree(); zhTreeFix(); t.scrollTop = y;
  const h = $('#zh-cat-head'); if (h) h.innerHTML = zhCatHead();
  zhRefreshCount();
}
function zhCountLine() {
  const n = zhPool(zhOpts()).length;
  return `${n} card${n === 1 ? '' : 's'}${UI.zhUntil ? ' not learned yet' : ''} match${n === 1 ? 'es' : ''}${n ? ` · ${Math.ceil(n / zhBatch())} set${Math.ceil(n / zhBatch()) === 1 ? '' : 's'} of ${zhBatch()}` : ''}`;
}
function zhImportHtml() {
  return zhServed()
    ? `<label class="btn sm">Import Pleco export… <input type="file" accept=".xml,.txt" data-zc="import" hidden></label>
       <span class="small muted">In Pleco: Flashcards › Import/Export › Export Cards, XML, with categories and scores.</span>`
    : `<span class="small muted">Open StudyHub with Start StudyHub to import here, or run <code>python3 engine/pleco_import.py export.xml</code> and then <code>python3 build.py</code>.</span>`;
}
function zhHome() {
  const st = zhStats(), o = zhOpts();
  if (!st.total) {
    main.innerHTML = `<h1>中文 Chinese</h1><div class="card"><h3 style="margin-top:0">Import your Pleco flashcards</h3>
      <p>Export from Pleco (Flashcards › Import/Export › Export Cards, XML format, include categories and scores), move the file to this computer and import it here.</p>
      <div class="row">${zhImportHtml()}</div>
      <p class="small muted" style="margin-top:14px">You can still use the <a href="#/zh/read">reader</a> with pasted text before importing.</p></div>`;
    return;
  }
  const sel = (k, opts, v) => `<select data-zc="${k}">${opts.map(([val, t]) => `<option value="${val}" ${String(v) === val ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
  main.innerHTML = `<h1>中文 Chinese</h1>
    <div class="row small muted" style="margin:-6px 0 16px">${st.total} cards · <b>${st.learned} learned</b> · ${st.total - st.learned} not yet · ${st.rev} reviewed here · ${st.weak} weak · ${st.due} due · ${st.fl} flagged</div>
    <div class="zh-grid">
      <div class="card">
        <h3 style="margin-top:0">Flashcard sets</h3>
        <div class="zh-form">
          <label>Cards per set <input type="number" min="1" max="500" value="${zhBatch()}" data-zc="batch" class="zh-in" style="width:80px"></label>
          <label>Cards ${sel('filter', [['all', 'All'], ['learning', 'Not learned yet'], ['learned', 'Learned'], ['weak', 'Weak'], ['due', 'Due for review'], ['new', 'New (never reviewed)'], ['flagged', 'Flagged / look-alikes']], o.filter)}</label>
          <label class="zh-weakmin" ${o.filter === 'weak' ? '' : 'hidden'}>Weak from <input type="range" min="0.1" max="0.8" step="0.05" value="${o.weakMin}" data-zc="weakmin"> <span id="zh-wm">${Math.round(o.weakMin * 100)}%</span></label>
          <label>Order ${sel('order', [['weak', 'Weakest first'], ['due', 'Most overdue first'], ['random', 'Random']], o.order)}</label>
          <label>Show ${sel('dir', [['hz', 'Characters → meaning'], ['en', 'Meaning → characters']], UI.zhDir || 'hz')}</label>
          <label title="The set keeps going round; each card leaves when its score reaches the learned line"><input type="checkbox" data-zc="until" ${UI.zhUntil ? 'checked' : ''}> Repeat until learned</label>
          <label title="Like Pleco: Good +100, Easy +150, Hard +25, Don't know halves the score">Learned at score <input type="number" min="50" step="50" value="${zhLearnAt()}" data-zc="learnat" class="zh-in" style="width:80px"></label>
          <label><input type="checkbox" data-zc="pinyin" ${UI.zhPinyin ? 'checked' : ''}> Pinyin on the front</label>
          ${ZH.cards.some(c => c.t) ? `<label><input type="checkbox" data-zc="trad" ${UI.zhScript === 'trad' ? 'checked' : ''}> Traditional characters</label>` : ''}
        </div>
        <div class="row" style="margin-top:14px"><button class="btn primary" data-zh="start">Start set</button><span class="small muted" id="zh-count">${zhCountLine()}</span></div>
      </div>
      <div class="card">
        <div class="row" style="justify-content:space-between;min-height:32px"><h3 style="margin:0">Categories</h3><span id="zh-cat-head">${zhCatHead()}</span></div>
        <div class="zh-tree">${zhCatTree()}</div>
      </div>
    </div>
    <div class="zh-grid" style="margin-top:16px">
      <a class="card zh-link" href="#/zh/compare"><h3 style="margin:0">Look-alikes</h3><p class="muted small" style="margin:6px 0 0">${st.groups} group${st.groups === 1 ? '' : 's'} · flagged characters side by side</p></a>
      <a class="card zh-link" href="#/zh/read"><h3 style="margin:0">Reader</h3><p class="muted small" style="margin:6px 0 0">${zhTexts().length} text${zhTexts().length === 1 ? '' : 's'} · tap a word for its meaning · new texts from your weak words</p></a>
    </div>
    <details class="card" style="margin-top:16px"><summary style="cursor:pointer;font-weight:700">Update deck from Pleco</summary>
      <p class="small muted">Last import ${ZH.deck.imported ? new Date(ZH.deck.imported).toLocaleString() : '-'}. Importing again replaces the cards; what you reviewed here is kept.</p>
      <div class="row">${zhImportHtml()}</div></details>`;
  zhTreeFix();
}
function zhRefreshCount() { const el = $('#zh-count'); if (el) el.textContent = zhCountLine(); }

function zhCompare() {
  const z = zhP(), groups = zhLive(z.groups).sort((a, b) => (b[1].t || 0) - (a[1].t || 0)), gc = zhGroupChars();
  const tray = zhLive(z.hard).map(([ch]) => ch).filter(ch => !gc.has(ch));
  const words = zhLive(z.hardW).map(([id]) => ZH.byId.get(id)).filter(Boolean);
  const col = (gid, ch) => {
    const i = zhCharInfo(ch), ex = zhWordsWith(ch, 5);
    return `<div class="zh-cmpc"><button class="zh-big" data-zh="char" data-c="${esc(ch)}" lang="zh">${esc(ch)}</button>
      <div class="zh-py">${esc(i.map(x => x.py).filter((v, k, a) => a.indexOf(v) === k).slice(0, 2).join(', '))}</div>
      <div class="small">${esc(i[0] ? i[0].def : '')}</div>
      <div class="zh-ex">${ex.map(c => `<button class="zh-chip" data-zh="word" data-w="${esc(c.s)}" lang="zh">${zhMark(c.s, ch)}</button>`).join('')}</div>
      <button class="btn sm ghost" data-zh="group-rm" data-g="${gid}" data-c="${esc(ch)}" title="Remove from this group">Remove</button></div>`;
  };
  const drillN = g => ZH.cards.filter(c => g.chars.some(ch => c.s.includes(ch))).length;
  main.innerHTML = `<div class="crumbs"><a href="#/zh">← Chinese</a></div><h1>Look-alikes</h1>
    <p class="muted small" style="margin-top:-6px">Flag characters you mix up (tap one on a card or in the reader), then group the ones that look alike to see them side by side.</p>
    ${groups.length ? groups.map(([gid, g]) => `<div class="card zh-group">
      <div class="zh-cmp">${g.chars.map(ch => col(gid, ch)).join('')}</div>
      <div class="row" style="margin-top:12px">
        <span class="zh-inline"><input class="zh-in" data-zg="${gid}" lang="zh" placeholder="add a character" aria-label="Add a character to this group" style="width:140px"><button class="btn sm" data-zh="group-addin" data-g="${gid}">Add</button></span>
        <button class="btn sm primary" data-zh="drill-group" data-g="${gid}" ${drillN(g) ? '' : 'disabled'}>Drill ${drillN(g)} word${drillN(g) === 1 ? '' : 's'}</button>
        <button class="btn sm" data-zh="text-group" data-g="${gid}">Reading text with these</button>
        <button class="btn sm ghost" data-zh="group-del" data-g="${gid}">Delete group</button></div></div>`).join('')
      : '<div class="card muted">No groups yet.</div>'}
    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">Flagged characters not in a group</h3>
      ${tray.length ? `<div class="zh-tray">${tray.map(ch => `<button class="zh-big sm ${ZH.sel.has(ch) ? 'on' : ''}" data-zh="tray" data-c="${esc(ch)}" lang="zh" aria-pressed="${ZH.sel.has(ch)}">${esc(ch)}</button>`).join('')}</div>
        <div class="row" style="margin-top:10px"><button class="btn sm primary" data-zh="tray-group" id="zh-tray-go" ${ZH.sel.size >= 2 ? '' : 'disabled'}>Group selected</button><button class="btn sm ghost" data-zh="tray-unflag" ${ZH.sel.size ? '' : 'disabled'} id="zh-tray-un">Unflag selected</button><span class="small muted">select two or more</span></div>`
      : '<p class="muted small">None.</p>'}
      <div class="row" style="margin-top:12px"><span class="zh-inline"><input id="zh-flagin" class="zh-in" lang="zh" placeholder="type or paste characters to flag"><button class="btn sm" data-zh="flag-in">Flag</button></span></div></div>
    ${words.length ? `<div class="card" style="margin-top:16px"><h3 style="margin-top:0">Flagged words</h3><div class="zh-miss">${words.map(c => `<button class="zh-chip" data-zh="word" data-w="${esc(c.s)}"><b lang="zh">${esc(zhHead(c))}</b> <span class="muted small">${esc(c.py)}</span></button>`).join('')}</div>
      <p class="small muted">Practise them with the "Flagged / look-alikes" choice in Flashcard sets.</p></div>` : ''}`;
}

/* ---------- reader ---------- */
function zhTexts() {
  const z = zhP(), out = new Map();
  ZH.fileTexts.forEach(t => { if (t && t.id && Array.isArray(t.paragraphs)) out.set(t.id, Object.assign({ src: 'file' }, t)); });
  for (const [id, v] of Object.entries(z.texts)) { if (v.del) out.delete(id); else if (!out.has(id) && Array.isArray(v.paragraphs)) out.set(id, Object.assign({ src: 'saved', id }, v)); }
  return [...out.values()].sort((a, b) => (b.created || 0) - (a.created || 0));
}
function zhSegment(text, gloss) {
  const ch = [...text], out = [];
  const known = s => ZH.bySimp.has(s) || (gloss && gloss[s]) || (ZH.dict && ZH.dict.has(s));
  for (let i = 0; i < ch.length;) {
    if (!ZH_HAN.test(ch[i])) { let j = i; while (j < ch.length && !ZH_HAN.test(ch[j])) j++; out.push({ t: ch.slice(i, j).join(''), han: false }); i = j; continue; }
    let len = 1;
    for (let n = Math.min(6, ch.length - i); n > 1; n--) { const s = ch.slice(i, i + n); if (s.every(x => ZH_HAN.test(x)) && known(s.join(''))) { len = n; break; } }
    out.push({ t: ch.slice(i, i + len).join(''), han: true }); i += len;
  }
  return out;
}
function zhPy(w, gloss) { const c = ZH.bySimp.get(w), g = gloss && gloss[w], d = zhDictGet(w)[0]; return (c && c.py) || (g && g.py) || (d && d.py) || ''; }
function zhReadText(id) {
  const t = zhTexts().find(x => x.id === id);
  if (!t) { main.innerHTML = `<div class="crumbs"><a href="#/zh/read">← Reader</a></div><div class="card">That text is not here${zhServed() ? '' : ' - texts written by Claude Code show up when StudyHub runs through Start StudyHub, or after python3 build.py'}.</div>`; return; }
  ZH.cur = t;
  const gloss = t.glossary || {}, targets = new Set(t.targets || []), all = t.paragraphs.map(p => p.zh).join('');
  const missing = [...targets].filter(w => !all.includes(w));
  const deckTargets = [...targets].map(w => ZH.bySimp.get(w)).filter(Boolean);
  const para = (p, i) => {
    const toks = zhSegment(p.zh || '', gloss).map(k => {
      if (!k.han) return esc(k.t);
      const c = ZH.bySimp.get(k.t), cls = ['zw', targets.has(k.t) ? 'tgt' : '', c ? 'indeck' : '', c && zhWeak(c) !== null && zhWeak(c) >= ZH_WEAK ? 'weak' : ''].filter(Boolean).join(' ');
      const py = UI.zhRuby ? zhPy(k.t, gloss) : '';
      return `<span class="${cls}" data-zh="word" data-w="${esc(k.t)}">${py ? `<ruby>${esc(k.t)}<rt>${esc(py)}</rt></ruby>` : esc(k.t)}</span>`;
    }).join('');
    return `<div class="zh-para"><p lang="zh">${toks}</p>${p.en ? `<p class="zh-en ${UI.zhShowEn ? 'on' : ''}" id="zh-en-${i}">${esc(p.en)}</p><button class="btn sm ghost zh-enb" data-zh="para-en" data-i="${i}">${UI.zhShowEn ? 'Hide' : 'English'}</button>` : ''}</div>`;
  };
  main.innerHTML = `<div class="crumbs"><a href="#/zh/read">← Reader</a></div>
    <div class="zh-read">
      <h1 lang="zh" style="margin-bottom:4px">${esc(t.title || 'Text')}</h1>${t.titleEn ? `<div class="muted">${esc(t.titleEn)}</div>` : ''}
      <div class="row small" style="margin:12px 0">
        <label><input type="checkbox" data-zc="ruby" ${UI.zhRuby ? 'checked' : ''}> Pinyin</label>
        <label><input type="checkbox" data-zc="showen" ${UI.zhShowEn ? 'checked' : ''}> English</label>
        ${deckTargets.length ? `<button class="btn sm primary" data-zh="drill-text">Drill the ${deckTargets.length} target word${deckTargets.length === 1 ? '' : 's'}</button>` : ''}
        <button class="btn sm ghost" data-zh="text-del" data-id="${esc(t.id)}">Delete text</button></div>
      ${targets.size ? `<div class="small muted" style="margin-bottom:10px">Target words (highlighted): <span lang="zh">${[...targets].map(esc).join(' ')}</span>${missing.length ? ` · <span class="zh-bad">not in the text: <span lang="zh">${missing.map(esc).join(' ')}</span></span>` : ''}</div>` : ''}
      <div class="card zh-text">${t.paragraphs.map(para).join('')}</div>
      <p class="small muted">Tap any word for pinyin and meaning. Underlined words are in your deck${ZH.dict ? '' : '; other words get a meaning once the dictionary is loaded (Start StudyHub)'}.</p></div>`;
}
function zhReader() {
  const g = Object.assign({ source: 'weak', n: 12, len: 'medium', style: 'story', topic: '' }, UI.zhGen || {});
  const groups = zhLive(zhP().groups);
  const texts = zhTexts();
  const opt = (v, t) => `<option value="${v}" ${g.source === v ? 'selected' : ''}>${t}</option>`;
  main.innerHTML = `<div class="crumbs"><a href="#/zh">← Chinese</a></div><h1>Reader</h1>
    <div class="zh-grid">
      <div class="card"><h3 style="margin-top:0">New text from my words</h3>
        <p class="small muted" style="margin-top:-4px">Copies a prompt for Claude Code (uses your plan, not the API). Paste it into a Claude Code window; it writes the text where StudyHub finds it.</p>
        <div class="zh-form">
          <label>Words <select data-zc="gen-source">${opt('weak', 'My weakest words')}${opt('weakcats', 'Weakest in the ticked categories')}${opt('flagged', 'Flagged words and characters')}${groups.map(([gid, x]) => opt('g:' + gid, 'Look-alikes ' + esc(x.chars.join(' ')))).join('')}</select></label>
          <label>How many <input type="number" min="3" max="40" value="${g.n}" data-zc="gen-n" class="zh-in" style="width:70px"></label>
          <label>Length <select data-zc="gen-len">${[['short', 'Short (~150 characters)'], ['medium', 'Medium (~350)'], ['long', 'Long (~700)']].map(([v, t]) => `<option value="${v}" ${g.len === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label>Kind <select data-zc="gen-style">${[['story', 'Short story'], ['dialogue', 'Dialogue'], ['diary', 'Diary entry'], ['news', 'News-style report']].map(([v, t]) => `<option value="${v}" ${g.style === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label style="flex:1 1 220px">Topic <input class="zh-in" data-zc="gen-topic" value="${esc(g.topic)}" placeholder="optional, e.g. studying in Shanghai" style="width:100%"></label>
        </div>
        <div class="row" style="margin-top:12px"><button class="btn primary" data-zh="gen-copy">Copy prompt for Claude Code</button><span class="small muted" id="zh-gen-status">${ZH.pending ? 'Waiting for Claude Code to write the text…' : ''}</span></div>
        <textarea id="zh-prompt" class="zh-in zh-prompt" readonly ${ZH.prompt ? '' : 'hidden'}>${esc(ZH.prompt)}</textarea>
      </div>
      <div class="card"><h3 style="margin-top:0">Paste a text</h3>
        <p class="small muted" style="margin-top:-4px">Any Chinese text, or the JSON Claude replied with.</p>
        <textarea id="zh-paste" class="zh-in" lang="zh" rows="6" style="width:100%" placeholder="粘贴中文…"></textarea>
        <div class="row" style="margin-top:8px"><button class="btn" data-zh="paste-open">Open in reader</button></div></div>
    </div>
    <h3 style="margin-top:22px">Texts</h3>
    ${texts.length ? `<div class="zh-texts">${texts.map(t => `<a class="card zh-link" href="#/zh/read/${encodeURIComponent(t.id)}"><b lang="zh">${esc(t.title || 'Text')}</b>${t.titleEn ? ` <span class="muted small">${esc(t.titleEn)}</span>` : ''}<div class="small muted">${t.created ? new Date(t.created).toLocaleDateString() : ''}${(t.targets || []).length ? ` · ${t.targets.length} target words` : ''}</div></a>`).join('')}</div>` : '<p class="muted">No texts yet.</p>'}`;
}
// the words a new text should practise
function zhTargets(g) {
  const n = Math.max(3, Math.min(40, +g.n || 12)), byWeak = cs => cs.map(c => [c, zhWeak(c)]).filter(([, w]) => w !== null).sort((a, b) => b[1] - a[1]).map(([c]) => c);
  if (g.source.startsWith('g:')) {
    const grp = zhP().groups[g.source.slice(2)]; if (!grp || grp.del) return { words: [], chars: [] };
    const ws = ZH.cards.filter(c => grp.chars.some(ch => c.s.includes(ch)));
    return { words: byWeak(ws).concat(ws.filter(c => zhWeak(c) === null)).slice(0, n), chars: grp.chars };
  }
  if (g.source === 'flagged') { const gc = zhGroupChars(); return { words: byWeak(ZH.cards.filter(c => zhFlagged(c, gc))).slice(0, n), chars: zhLive(zhP().hard).map(([ch]) => ch) }; }
  const cs = g.source === 'weakcats' ? ZH.cards.filter(c => zhMatches(c, { cats: UI.zhCats || [], filter: 'all' })) : ZH.cards;
  return { words: byWeak(cs).slice(0, n), chars: [] };
}
function zhBuildPrompt() {
  const g = Object.assign({ source: 'weak', n: 12, len: 'medium', style: 'story', topic: '' }, UI.zhGen || {});
  const { words, chars } = zhTargets(g);
  if (!words.length && !chars.length) return null;
  const tset = new Set(words.map(c => c.id));
  const known = ZH.cards.filter(c => !tset.has(c.id)).map(c => [c, zhLearned(c) ? 0 : 1, zhWeak(c)]).sort((a, b) => a[1] - b[1] || (a[2] === null ? 0.5 : a[2]) - (b[2] === null ? 0.5 : b[2])).slice(0, 250).map(([c]) => c.s);
  const cats = [...new Set(ZH.cards.flatMap(c => zhCatsOf(c).map(x => x.split('/')[0])))].slice(0, 15);
  const d = new Date(), pad = x => String(x).padStart(2, '0');
  const id = `zh-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = ZH.textsDir || '<StudyHub folder>/content/_chinese/texts';
  const len = { short: 150, medium: 350, long: 700 }[g.len] || 350;
  const kind = { story: 'a short story (some dialogue is fine)', dialogue: 'a dialogue between two or three people', diary: 'a diary entry', news: 'a short news-style report' }[g.style] || 'a short story';
  const p = `Write a Chinese reading text for me (I am learning Mandarin) and save it as a JSON file. Do not ask questions; just write the file.

${words.length ? `Target words. Use every one at least once, ideally twice, in a natural way:
${words.map(c => `- ${c.s} (${c.py}) ${zhShort(c.def, 2)}`).join('\n')}
` : ''}${chars.length ? `
These characters look alike and I mix them up: ${chars.join(' ')}. Use words with them close to each other so I have to tell them apart.
` : ''}
Keep the rest of the vocabulary simple: mostly words from my list below and very common words.
My flashcard categories (to judge my level): ${cats.join(', ') || 'unknown'}
Words I know: ${known.join(' ')}

Length: about ${len} Chinese characters, in short paragraphs. Kind: ${kind}. Topic: ${g.topic.trim() || 'your choice, everyday life'}.
Simplified characters only. No pinyin inside the Chinese text.

Save exactly this JSON shape (UTF-8, valid JSON) to this file:
${dir}/${id}.json

{
  "id": "${id}",
  "title": "short Chinese title",
  "titleEn": "English title",
  "created": ${Date.now()},
  "targets": ${JSON.stringify(words.map(c => c.s))},
  "paragraphs": [ { "zh": "one paragraph in Chinese", "en": "natural English translation of it" } ],
  "glossary": { "词语": { "py": "pinyin with tone marks", "en": "meaning as used in this text" } }
}

The glossary must list every word in the text, split into words the way a dictionary would (single-character words and names too, no punctuation). Before saving, check that every target word appears in the text and that the file parses as JSON. Then reply with one line.`;
  return { id, prompt: p };
}
async function zhCopy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall back below */ }
  const ta = $('#zh-prompt'); if (!ta) return false;
  ta.hidden = false; ta.select(); try { return document.execCommand('copy'); } catch (e) { return false; }
}
function zhWatch(id) {
  ZH.pending = id; clearInterval(ZH.poll);
  if (!zhServed()) return;
  const t0 = Date.now();
  ZH.poll = setInterval(async () => {
    if (Date.now() - t0 > 20 * 60000) { clearInterval(ZH.poll); ZH.pending = null; return; }
    await zhLoad(true);
    if (ZH.fileTexts.some(t => t.id === id)) {
      clearInterval(ZH.poll); ZH.pending = null; ZH.prompt = '';
      toast('New text ready');
      if (/^#\/zh\/read\/?$/.test(location.hash)) go('#/zh/read/' + encodeURIComponent(id));
    }
  }, 4000);
}
function zhPasteOpen() {
  const raw = ($('#zh-paste') || {}).value || ''; if (!raw.trim()) { toast('Paste a text first'); return; }
  let t = null;
  const m = /\{[\s\S]*\}/.exec(raw);
  if (m && raw.trim().startsWith('{')) { try { t = JSON.parse(m[0]); } catch (e) { toast('That JSON does not parse'); return; } }
  if (!t || !Array.isArray(t.paragraphs)) {
    const ps = raw.split(/\n\s*\n|\n/).map(s => s.trim()).filter(Boolean);
    t = { title: [...ps[0]].slice(0, 12).join(''), paragraphs: ps.map(zh => ({ zh })) };
  }
  t.id = t.id || 'p-' + Date.now().toString(36); t.created = t.created || Date.now();
  const z = zhP(); z.texts[t.id] = Object.assign({}, t, { t: Date.now() });
  // keep at most 30 pasted texts in the synced progress
  zhLive(z.texts).sort((a, b) => (b[1].t || 0) - (a[1].t || 0)).slice(30).forEach(([id]) => { z.texts[id] = { t: Date.now(), del: true }; });
  saveP(); go('#/zh/read/' + encodeURIComponent(t.id));
}
async function zhImport(file) {
  if (!file) return;
  const text = await file.text();
  try {
    const r = await fetch('/zh-api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    zhSetDeck(j.deck); const s = j.summary;
    toast(`Imported ${s.cards} cards in ${s.categories} categories (${s.withScores} with Pleco scores)`); render();
  } catch (e) { toast('Import failed: ' + e.message); }
}
function zhSpeak(text) {
  const ss = window.speechSynthesis; if (!ss) { toast('This browser cannot read aloud'); return; }
  const vs = ss.getVoices(), v = vs.find(x => /^zh[-_](CN|Hans)/i.test(x.lang)) || vs.find(x => /^(zh|cmn)/i.test(x.lang));
  if (!v) { toast('No Chinese voice on this device - add one in the system speech settings'); return; }
  ss.cancel(); const u = new SpeechSynthesisUtterance(text); u.voice = v; u.lang = v.lang; u.rate = 0.85; ss.speak(u);
}
if (window.speechSynthesis) try { speechSynthesis.getVoices(); } catch (e) { /* voices load later */ }

/* ---------- events (own listeners: nothing here goes through the course handlers) ---------- */
function zhRedraw() { const y = scrollY; viewZh(parseRoute()); window.scrollTo(0, y); }
document.addEventListener('click', ev => {
  const el = ev.target.closest && ev.target.closest('[data-zh]');
  if (!el) return;
  const a = el.dataset.zh, d = el.dataset;
  switch (a) {
    case 'flip': if (typeof tapFlipAt === 'undefined' || Date.now() - tapFlipAt > 700) zhFlip(); break;   // a tap already flipped it
    case 'rate': zhRateCur(+d.l); break;
    case 'start': zhStart(zhOpts()); break;
    case 'next-set': zhNext(); break;
    case 'redo-missed': zhStart({ ids: ZS.missed.slice(), order: 'random', title: 'missed', from: ZS.o.from || { o: ZS.o, seen: ZS.seen, setNo: ZS.setNo } }); break;
    case 'cats-clear': UI.zhCats = []; saveUI(); zhTreeRedraw(); break;
    case 'cat-up': { const add = zhCatUp(d.p, zhCatData().kids), covered = x => add.some(a => x === a || x.startsWith(a + '/'));
      UI.zhCats = (UI.zhCats || []).filter(x => !covered(x)).concat(add); ZH.lastTick = null; saveUI(); zhTreeRedraw(); toast(`Ticked ${zhCatName(d.p)} and up (${add.length} folders)`); break; }
    case 'cat-open': { const o = zhCatOpen(zhCatData().kids); o.has(d.p) ? o.delete(d.p) : o.add(d.p); UI.zhOpen = [...o]; saveUI(); zhTreeRedraw(); break; }
    case 'char': ev.stopPropagation(); zhCharSheet(d.c, el); break;
    case 'word': zhWordSheet(d.w, el); break;
    case 'sheet-close': zhSheetClose(); break;
    case 'speak': ev.stopPropagation(); zhSpeak(d.w); break;
    case 'full': { const f = $('#zh-sheet .zh-full'); if (f) { f.hidden = !f.hidden; el.textContent = f.hidden ? 'Definition' : 'Less'; } break; }
    case 'flag-word': { ev.stopPropagation(); const on = !zhHardW(d.id); zhP().hardW[d.id] = on ? { t: Date.now() } : { t: Date.now(), del: true }; saveP();
      el.classList.toggle('warnbtn', on); el.classList.toggle('ghost', !on); el.textContent = on ? '⚑ Flagged' : '⚑ Flag' + (el.closest('.zh-card') ? ' word' : ''); toast(on ? 'Word flagged' : 'Flag removed'); break; }
    case 'flag-char': { const on = !zhHard(d.c); zhSetHard(d.c, on); $$(`.zh-ch[data-c="${CSS.escape(d.c)}"]`).forEach(b => b.classList.toggle('hard', on)); zhCharSheet(d.c); if (/compare/.test(location.hash)) zhRedraw(); break; }
    case 'group-new': { const extra = [...(($('#zh-gnew') || {}).value || '')].filter(x => ZH_HAN.test(x) && x !== d.c); zhGroupSave(zhNewGid(), [d.c, ...extra]); zhSetHard(d.c, true); toast(extra.length ? 'Look-alike group made - see Look-alikes' : 'Group made with one character - add the look-alikes on the Look-alikes page'); zhCharSheet(d.c); if (/compare/.test(location.hash)) zhRedraw(); break; }
    case 'group-add': { const g = zhP().groups[d.g]; zhGroupSave(d.g, g.chars.concat(d.c)); toast('Added to the group'); zhCharSheet(d.c); if (/compare/.test(location.hash)) zhRedraw(); break; }
    case 'group-addin': { const inp = $(`[data-zg="${d.g}"]`), g = zhP().groups[d.g]; const add = [...(inp ? inp.value : '')].filter(x => ZH_HAN.test(x)); if (!add.length) { toast('Type a character'); break; } zhGroupSave(d.g, g.chars.concat(add)); zhRedraw(); break; }
    case 'group-rm': { const g = zhP().groups[d.g]; zhGroupSave(d.g, g.chars.filter(x => x !== d.c)); zhRedraw(); break; }
    case 'group-del': zhGroupSave(d.g, []); zhRedraw(); break;
    case 'drill-group': { const g = zhP().groups[d.g]; zhStart({ ids: ZH.cards.filter(c => g.chars.some(ch => c.s.includes(ch))).map(c => c.id), order: 'weak', title: g.chars.join(' ') }); break; }
    case 'text-group': UI.zhGen = Object.assign({}, UI.zhGen, { source: 'g:' + d.g }); saveUI(); go('#/zh/read'); break;
    case 'tray': { const c = d.c; ZH.sel.has(c) ? ZH.sel.delete(c) : ZH.sel.add(c); el.classList.toggle('on', ZH.sel.has(c)); el.setAttribute('aria-pressed', ZH.sel.has(c)); const go_ = $('#zh-tray-go'), un = $('#zh-tray-un'); if (go_) go_.disabled = ZH.sel.size < 2; if (un) un.disabled = !ZH.sel.size; break; }
    case 'tray-group': zhGroupSave(zhNewGid(), [...ZH.sel]); ZH.sel.clear(); zhRedraw(); break;
    case 'tray-unflag': ZH.sel.forEach(c => zhSetHard(c, false)); ZH.sel.clear(); zhRedraw(); break;
    case 'flag-in': { const cs = [...(($('#zh-flagin') || {}).value || '')].filter(x => ZH_HAN.test(x)); if (!cs.length) { toast('Type or paste Chinese characters'); break; } [...new Set(cs)].forEach(c => zhSetHard(c, true)); zhRedraw(); break; }
    case 'para-en': { const p = $('#zh-en-' + d.i); if (p) { p.classList.toggle('on'); el.textContent = p.classList.contains('on') ? 'Hide' : 'English'; } break; }
    case 'drill-text': { const t = ZH.cur; if (t) zhStart({ ids: (t.targets || []).map(w => ZH.bySimp.get(w)).filter(Boolean).map(c => c.id), order: 'weak', title: t.title }); break; }
    case 'text-del': { if (!confirm('Delete this text?')) break; zhP().texts[d.id] = { t: Date.now(), del: true }; saveP(); go('#/zh/read'); break; }
    case 'add-word': { const id = d.w + '|' + (d.py || '').replace(/\s/g, '').toLowerCase(); zhP().added[id] = { s: d.w, py: d.py, def: d.def, t: Date.now() }; saveP(); zhSetDeck(ZH.deck); toast('Added to your deck (category "From reader")'); zhWordSheet(d.w); break; }
    case 'gen-copy': { const b = zhBuildPrompt(); if (!b) { toast('No words to practise yet - review some cards or flag some first'); break; }
      ZH.prompt = b.prompt; const ta = $('#zh-prompt'); if (ta) { ta.value = b.prompt; ta.hidden = false; }
      zhCopy(b.prompt).then(ok => { toast(ok ? 'Prompt copied - paste it into Claude Code' : 'Select the prompt below and copy it'); });
      zhWatch(b.id); const st = $('#zh-gen-status'); if (st) st.textContent = zhServed() ? 'Waiting for Claude Code to write the text… it opens here by itself.' : 'When Claude Code is done, run python3 build.py and reload.'; break; }
    case 'paste-open': zhPasteOpen(); break;
  }
});
document.addEventListener('change', ev => {
  const el = ev.target, k = el.dataset && el.dataset.zc; if (!k) return;
  const gen = (f, v) => { UI.zhGen = Object.assign({ source: 'weak', n: 12, len: 'medium', style: 'story', topic: '' }, UI.zhGen, { [f]: v }); saveUI(); };
  switch (k) {
    case 'batch': UI.zhBatch = Math.max(1, Math.min(500, Math.round(+el.value || 20))); el.value = UI.zhBatch; break;
    case 'filter': UI.zhFilter = el.value; { const w = $('.zh-weakmin'); if (w) w.hidden = el.value !== 'weak'; } break;
    case 'weakmin': UI.zhWeakMin = +el.value; break;
    case 'order': UI.zhOrder = el.value; break;
    case 'dir': UI.zhDir = el.value; break;
    case 'pinyin': UI.zhPinyin = el.checked; break;
    case 'until': UI.zhUntil = el.checked; break;
    case 'learnat': UI.zhLearnAt = Math.max(50, Math.round(+el.value || 300)); el.value = UI.zhLearnAt; saveUI(); zhRedraw(); return;
    case 'trad': UI.zhScript = el.checked ? 'trad' : 'simp'; break;
    case 'cat': { const v = el.value; let sel = (UI.zhCats || []).filter(x => x !== v);
      ZH.lastTick = el.checked ? v : null;          // only the folder just ticked offers "and up"
      if (el.checked) sel = sel.filter(x => !x.startsWith(v + '/')).concat(v);      // a ticked folder already covers what is inside it
      UI.zhCats = sel; saveUI(); zhTreeRedraw(); return; }
    case 'ruby': UI.zhRuby = el.checked; saveUI(); zhRedraw(); return;
    case 'showen': UI.zhShowEn = el.checked; saveUI(); zhRedraw(); return;
    case 'import': zhImport(el.files[0]); return;
    case 'gen-source': gen('source', el.value); return;
    case 'gen-n': gen('n', Math.max(3, Math.min(40, +el.value || 12))); return;
    case 'gen-len': gen('len', el.value); return;
    case 'gen-style': gen('style', el.value); return;
    case 'gen-topic': gen('topic', el.value); return;
  }
  saveUI(); zhRefreshCount();
});
document.addEventListener('input', ev => { const el = ev.target; if (el.dataset && el.dataset.zc === 'weakmin') { const s = $('#zh-wm'); if (s) s.textContent = Math.round(el.value * 100) + '%'; } });
document.addEventListener('keydown', ev => {
  const sh = document.getElementById('zh-sheet');
  if (ev.key === 'Escape' && sh && !sh.hidden) { zhSheetClose(); return; }
  if (ev.key === 'Enter' && ev.target.id === 'zh-gnew') { const b = $('#zh-sheet [data-zh="group-new"]'); if (b) b.click(); return; }
  if (ev.key === 'Enter' && ev.target.dataset && ev.target.dataset.zg) { const b = $(`[data-zh="group-addin"][data-g="${ev.target.dataset.zg}"]`); if (b) b.click(); return; }
  if (!ZS || !/^#\/zh\/play/.test(location.hash)) return;
  const tag = (ev.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ZS.i >= ZS.ids.length) { if (ev.key === 'Enter') { ev.preventDefault(); zhNext(); } return; }
  if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); zhFlip(); }
  else if (ZS.flipped && /^[1-4]$/.test(ev.key)) { ev.preventDefault(); zhRateCur(+ev.key - 1); }
  else if (ev.key.toLowerCase() === 's') { const c = ZH.byId.get(ZS.ids[ZS.i]); if (c) zhSpeak(c.s); }
});
window.addEventListener('hashchange', () => zhSheetClose());

/* ---------- styles ---------- */
(() => {
  const s = document.createElement('style'); s.id = 'zh-css';
  s.textContent = `
[lang=zh],.zh-hw,.zh-sbig,.zh-big,.zh-ch{font-family:"PingFang SC","Hiragino Sans GB","Noto Sans SC","Microsoft YaHei",sans-serif}
.zh-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
.zh-form{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center}.zh-form label{display:inline-flex;gap:6px;align-items:center}.zh-form [hidden]{display:none}
.zh-in{border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:8px;padding:6px 8px;font:inherit}
.zh-tree{max-height:440px;overflow:auto;margin-top:8px}.zh-cat{display:flex;align-items:center;gap:6px;padding:3px 0}
.zh-tw{width:24px;height:24px;flex:none;border:0;background:none;color:var(--text);cursor:pointer;padding:0;font-size:1rem;border-radius:6px}.zh-tw:hover{background:var(--surface2)}
.zh-cn{border:0;background:none;color:inherit;font:inherit;cursor:pointer;padding:0;text-align:left}button.zh-cn{font-weight:600}.zh-cat.inh .zh-cn{color:var(--muted)}
.zh-up{border:1px solid var(--border);background:var(--surface);color:var(--muted);font:inherit;font-size:.72rem;border-radius:999px;padding:1px 7px;cursor:pointer;margin-left:6px;}
.zh-up:hover{color:var(--accent);border-color:var(--accent)}
.zh-lb{flex:0 0 46px;height:5px;border-radius:3px;background:var(--border);overflow:hidden;margin-left:auto}.zh-lb i{display:block;height:100%;background:var(--good)}.zh-lbn{flex:0 0 34px;text-align:right}
.zh-tick b{color:var(--text)}

.zh-catk{display:none;padding-left:22px;border-left:1px solid var(--border);margin-left:11px}.zh-catk.open{display:block}
.zh-link{display:block;color:inherit;text-decoration:none}.zh-link:hover{border-color:var(--accent)}
.zh-card{margin:16px 0;padding:24px 28px}.zh-card[data-zh=flip]{cursor:pointer}
.zh-front{position:relative;min-height:260px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
.zh-lbl{position:absolute;top:-6px;left:0;font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}.zh-hint{position:absolute;bottom:-8px;right:0;font-size:.78rem;color:var(--muted)}
.zh-card.flipped{background:color-mix(in srgb,var(--accent) 4%,var(--surface))}
.zh-ahead{text-align:center;padding-bottom:14px;border-bottom:1px solid var(--border)}
.zh-scoreline{display:flex;gap:8px;justify-content:center;align-items:center;flex-wrap:wrap;margin-top:6px}.zh-lb.wide{flex:0 0 90px;margin:0}.zh-ok{color:var(--good)}
.zh-defs{margin-top:14px}.zh-posb+.zh-posb{margin-top:14px}
.zh-pos{font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:700;margin-bottom:6px}
.zh-senses{list-style:none;margin:0;padding:0}.zh-sense{display:flex;gap:10px;margin:0 0 10px}
.zh-sn{flex:none;width:22px;height:22px;border-radius:50%;background:var(--surface2);border:1px solid var(--border);font-size:.75rem;display:inline-flex;align-items:center;justify-content:center;margin-top:2px}
.zh-m{font-size:1.12rem;font-weight:700}.zh-tag{font-size:.75rem;font-style:italic;color:var(--muted);border:1px solid var(--border);border-radius:6px;padding:0 5px}
.zh-exs{margin-top:6px;display:grid;gap:8px}.zh-ex1{border-left:3px solid var(--accent-soft);padding-left:10px}
.zh-exz{font-size:1.1rem}.zh-exp{color:var(--accent);font-size:.88rem}.zh-exe{color:var(--muted);font-size:.9rem}
.zh-more summary{cursor:pointer;color:var(--muted);font-size:.85rem;margin:4px 0}
.zh-gl{margin-top:14px;padding-top:12px;border-top:1px solid var(--border);display:grid;gap:4px}.zh-gl1{display:flex;gap:10px;align-items:baseline;color:var(--muted);font-size:.92rem}.zh-gl1 .zh-ch{font-size:1.2rem;color:var(--text)}
.zh-afoot{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:14px;padding-top:12px;border-top:1px solid var(--border)}
@media (min-width:701px){.zh-play .rate{position:sticky;bottom:0;z-index:5;padding:10px 0;background:linear-gradient(transparent,var(--bg) 30%)}}
.zh-keys{text-align:center;margin-top:12px}
.zh-missd{text-align:left;margin:14px auto 0;max-width:640px;border:1px solid var(--border);border-radius:10px;padding:8px 12px}.zh-missd summary{cursor:pointer;font-weight:600}
.zh-misslist{display:grid;margin-top:8px}.zh-mrow{display:grid;grid-template-columns:auto auto 1fr;gap:10px;align-items:baseline;text-align:left;border:0;border-top:1px solid var(--border);background:none;color:inherit;font:inherit;padding:7px 2px;cursor:pointer}
.zh-mrow:hover{background:var(--surface2)}.zh-mpy{color:var(--accent);font-size:.9rem}.zh-mm{color:var(--muted);font-size:.9rem;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.zh-hw{font-size:clamp(2.6rem,9vw,4.4rem);line-height:1.2;letter-spacing:.04em}
.zh-py{font-size:1.25rem;color:var(--accent);margin-top:4px}.zh-def{margin-top:10px;font-size:1.05rem}.zh-def.big{font-size:1.5rem}
.zh-ahead .zh-hw{font-size:clamp(2.4rem,8vw,3.8rem)}
.zh-gl{display:flex;flex-wrap:wrap;gap:6px 16px;justify-content:center;margin-top:10px;color:var(--muted)}
.zh-ch{border:1px solid transparent;background:none;color:inherit;font:inherit;cursor:pointer;border-radius:8px;padding:0 2px}
.zh-ch:hover{border-color:var(--border);background:var(--surface2)}.zh-ch.hard{color:var(--bad);border-bottom:2px solid var(--bad)}
.zh-chip{display:inline-flex;align-items:baseline;gap:6px;border:1px solid var(--border);background:var(--surface2);color:inherit;border-radius:999px;padding:4px 10px;margin:3px 2px;cursor:pointer;font:inherit;text-decoration:none}
.zh-chip mark,.zh-ex mark{background:var(--accent-soft);color:var(--accent);border-radius:3px}
.zh-miss{display:flex;flex-wrap:wrap;justify-content:center;gap:4px;margin-top:8px}
.zh-sheet{position:fixed;left:50%;transform:translateX(-50%);bottom:0;width:min(680px,100%);max-height:55vh;overflow:auto;z-index:60;background:var(--surface);border:1px solid var(--border);border-bottom:0;border-radius:16px 16px 0 0;box-shadow:0 -8px 30px rgba(0,0,0,.18);padding:18px 20px 22px}
.zh-sheet[hidden]{display:none}.zh-x{position:absolute;top:8px;right:8px}.zh-sheet-in{padding-right:28px}
body.zh-sheet-open #main{padding-bottom:50vh}
.zh-sbig{font-size:2.6rem;line-height:1.1}.zh-sbig .zh-ch{font-size:inherit}
.zh-inline{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap}
.zh-cmp{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px}
.zh-cmpc{text-align:center;border:1px solid var(--border);border-radius:12px;padding:12px;background:var(--surface2);min-width:0}
.zh-big{font-size:clamp(3.4rem,11vw,5.6rem);line-height:1.1;border:0;background:none;color:inherit;cursor:pointer;padding:0 6px;border-radius:10px}
.zh-big.sm{font-size:2.2rem;border:2px solid var(--border);margin:3px;background:var(--surface)}.zh-big.sm.on{border-color:var(--accent);background:var(--accent-soft)}
.zh-ex{margin:8px 0}.zh-tray{display:flex;flex-wrap:wrap}
.zh-group{margin-bottom:14px}
.zh-text{font-size:1.45rem;line-height:2.1}.zh-text p{margin:0}.zh-para{margin-bottom:18px}
.zh-text ruby rt{font-size:.5em;color:var(--muted)}
.zw{cursor:pointer;border-radius:4px;padding:0 1px}.zw:hover{background:var(--surface2)}
.zw.indeck{text-decoration:underline dotted var(--muted);text-underline-offset:6px}.zw.weak{text-decoration-color:var(--bad)}
.zw.tgt{background:var(--accent-soft)}
.zh-en{display:none;font-size:.95rem;line-height:1.5;color:var(--muted);margin-top:4px!important}.zh-en.on{display:block}.zh-enb{font-size:.75rem}
.zh-read{max-width:860px}.zh-bad{color:var(--bad)}.zh-weak{color:var(--bad)}.zh-tgtp{background:var(--accent-soft)}
.zh-prompt{width:100%;min-height:150px;margin-top:10px;font-family:var(--mono);font-size:.78rem}
.zh-texts{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
@media (max-width:600px){.zh-text{font-size:1.3rem}.zh-sheet{max-height:62vh}}`;
  document.head.appendChild(s);
})();
