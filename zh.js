/* ===================================================================
   StudyHub Chinese: Pleco flashcards in sets, look-alike characters side by side, a tap-to-define reader,
   and reading texts built from your weak words (the prompt goes to Claude Code, which writes the text file).
   Loaded before the main script: everything here runs only when called, so it can use the main script's
   globals (P, UI, esc, $, main, go, toast, saveP, saveUI, shuffle, mergeItems, DAY, bumpDay).
   =================================================================== */
const ZH = { deck: null, cards: [], byId: new Map(), bySimp: new Map(), scorePct: new Map(), dict: null, dictP: null,
  fileTexts: [], textsDir: '', ex: new Map(), exKey: '', known: null, knownAt: 0, live: null, ver: 0, cur: null, sel: new Set(), open: new Set(), pending: null, poll: 0, prompt: '' };
const ZH_INT = [0, 0.5, 1, 3, 7, 16, 35, 80];       // days until the next review, per box (0 = never reviewed here)
const ZH_HAN = /\p{Script=Han}/u;
const ZH_WEAK = 0.35;                                // weakness from which a card counts as weak
const LS_ZHS = 'studyhub.zhsession.v1';
let ZS = null;                                       // running flashcard set (separate from the course `session`)
const zhServed = () => /^https?:$/.test(location.protocol);

/* ---------- progress (synced, inside P) ---------- */
function zhP() { const z = P.zh = P.zh || {}; for (const k of ['cards', 'hard', 'hardW', 'groups', 'texts', 'added', 'days', 'lq', 'unk']) z[k] = z[k] || {}; return z; }
const zhLive = obj => Object.entries(obj || {}).filter(([, v]) => v && !v.del);
// called from mergeP: every map merged item by item, newest t wins (deletions are kept as {del, t} so they win too)
function zhMerge(a, b) {
  if (!a) return b; if (!b) return a;
  const o = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) o[k] = k === 'days' ? zhMergeDays(a[k], b[k]) : mergeItems(a[k], b[k], x => x.n || 0);
  return o;
}
// daily counts from two devices: the larger count of each kind wins (they are counted separately on each device)
function zhMergeDays(a = {}, b = {}) {
  const o = Object.assign({}, b);
  for (const d in a) { const x = a[d] || {}, y = o[d] || {}; o[d] = {}; for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) o[d][k] = Math.max(x[k] || 0, y[k] || 0); }
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
// font for the Chinese text: system fonts, so a font the device lacks falls back to the next one (iPhone has no Kai)
const ZH_FONTS = { sans: ['Sans (PingFang)', '"PingFang SC","Hiragino Sans GB","Noto Sans SC","Microsoft YaHei",sans-serif'],
  serif: ['Serif (Song)', '"Songti SC","STSong","Noto Serif SC","Source Han Serif SC","SimSun",serif'],
  kai: ['Kai (brush)', '"Kaiti SC","STKaiti","KaiTi","BiauKai","Songti SC",serif'],
  fang: ['Fangsong', '"STFangsong","FangSong","Songti SC",serif'],
  round: ['Rounded (Yuan)', '"Yuanti SC","STYuanti","Hiragino Maru Gothic ProN","PingFang SC",sans-serif'] };
const zhFontApply = () => document.documentElement.style.setProperty('--zhfont', (ZH_FONTS[UI.zhFont] || ZH_FONTS.sans)[1]);
function zhInit() {
  zhFontApply();
  if (ZH.deck) return;
  const B = window.STUDYHUB_ZH || {};
  zhSetDeck(B.deck); ZH.fileTexts = B.texts || []; zhSetEx(B.examples);
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
    if (tx && tx.examples && zhSetEx(tx.examples)) changed = true;
    if (tx) { ZH.textsDir = tx.dir || ZH.textsDir; const ids = t => t.map(x => x.id).join(); if (ids(tx.texts || []) !== ids(ZH.fileTexts)) { ZH.fileTexts = tx.texts || []; changed = true; } }
    if (changed) ZH.ver++;
    ZH.liveDone = true;
    zhAdoptTexts();
    return changed;
  });
  return ZH.live;
}

/* ---------- example sentences at your level ---------- */
// examples Claude Code wrote (content/_chinese/examples/*.json, {card id: [{zh, py, en}]}); true when they changed
function zhSetEx(obj) {
  const key = Object.keys(obj || {}).length + ':' + JSON.stringify(obj || {}).length;
  if (key === ZH.exKey) return false;
  ZH.exKey = key; ZH.ex = new Map(Object.entries(obj || {})); return true;
}
// the words you have learned (score at the line), rebuilt at most every few seconds and after each rating
function zhKnown() {
  if (ZH.known && Date.now() - ZH.knownAt < 5000) return ZH.known;
  ZH.known = new Set(ZH.cards.filter(c => zhLearned(c)).map(c => c.s)); ZH.knownAt = Date.now(); return ZH.known;
}
// words in a sentence that you have not learned yet (the card's own word and its parts do not count)
// split into your deck's words only (a dictionary word that is not in the deck falls apart into characters), so the
// result is the same with or without CC-CEDICT loaded; the card's word is cut out first, so it is never split
const zhSegAround = (zh, c) => { const g = ZH.dict; ZH.dict = null; try { return zh.split(c.s).map(p => zhSegment(p)); } finally { ZH.dict = g; } };
function zhUnknownIn(zh, c) {
  const K = zhKnown();
  return [...new Set(zhSegAround(zh, c).flat().filter((t, i, a) => t.han && !c.s.includes(t.t) && !K.has(t.t) && !(t.t === '儿' && i > 0)).map(t => t.t))];
}
// every example for a card: the ones written for you first, then Pleco's that contain the word in a real sentence
function zhExamples(c) {
  const own = (ZH.ex.get(c.id) || []).map(e => Object.assign({ gen: true }, e));
  const pl = zhIsPleco(c.def) ? zhParseDef(c.def).flatMap(b => b.senses.flatMap(x => x.ex)).filter(e => e.zh.includes(c.s) && e.zh.length > c.s.length + 2 && e.en) : [];
  return own.concat(pl);
}
// the example with the fewest words you have not learned; full sentences before phrases; null when there is none
function zhBestExample(c) {
  let best = null;
  for (const e of zhExamples(c)) {
    const unk = zhUnknownIn(e.zh, c), sent = /[。！？]$/.test(e.zh) ? 0 : 1;
    const k = unk.length * 10 + sent + (e.zh.length > 40 ? 1 : 0);
    if (!best || k < best.k) best = { e, unk, k };
  }
  return best;
}
// a sentence with the card's word marked and the words you have not learned dotted
function zhExHtml(zh, c, unk) {
  const U = new Set(unk || zhUnknownIn(zh, c)), head = `<mark>${esc(zhHead(c))}</mark>`;
  return zhSegAround(zh, c).map(seg => seg.map(t => t.han && U.has(t.t) ? `<span class="zh-unkw" title="Not learned yet">${esc(t.t)}</span>` : esc(t.t)).join('')).join(head);
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
const ZH_TAG = /^(sports|law|abbreviation|colloquial|literary|computing|chemistry|physics|medicine|mathematics|biology|music|military|economics|finance|dialect|formal|informal|figurative|derogatory|polite expression|polite|humble|archaic|botany|zoology|entomology|linguistics|grammar|religion|Buddhism|politics|written|spoken|euphemism|slang|internet|commerce|business|electricity|geography|geology|history|philosophy|psychology|statistics|transport|agriculture|architecture|astronomy|cooking|art|photography|printing|mechanics|engineering|anatomy|physiology|pharmacology|meteorology|education|journalism|sociology|traditional Chinese medicine)\s+/i;
const ZH_TONE = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/i;
const ZH_NEUT = new Set('de le ma ne ba zi men a ya la me ge li tou zhe guo r er wa na shang xia qu lai bu yi zhene jia'.split(' '));
/* labels some Pleco entries put before the part of speech or the "1": "literary pronoun 1 …", "common phrase colloquial …",
   "(shuí) pronoun …", "VARIANT OF 露2 lù verb 1 …", "general name for VARIANT OF 摄影 1 verb …" */
const ZH_LEAD = new RegExp('^(?:(?:common phrase|polite expression|general name for|bound form|transliteration|courteous|usually|usu\\.|classical|meaningful|meaningless|dated|'
  + ZH_TAG.source.slice(2, -4) + '|[(（][^)）\\s]{1,12}[)）]|VARIANT OF \\S+(?:\\s+\\S*' + ZH_TONE.source + '\\S*)?(?:\\s+[IVX]+)?(?:\\s+\\d+(?=\\s+' + ZH_POS.source.slice(1, -5) + '\\b))?)\\s+)+', 'i');
// a line split into its labels and the rest; labels only count when a part of speech, "1" or an example follows them
function zhLead(l) {
  const m = ZH_LEAD.exec(l); if (!m) return { lead: '', rest: l };
  const rest = l.slice(m[0].length);
  if (!ZH_POS.test(rest) && !/^1\s/.test(rest) && !ZH_HAN.test(rest)) return { lead: '', rest: l };
  return { lead: m[0].trim().replace(/VARIANT OF/g, 'variant of'), rest };
}
const zhIsPleco = def => String(def || '').split('\n').some(l => { const r = zhLead(l.trim()).rest; return ZH_POS.test(r) || /^1\s/.test(r); }) || ZH_HAN.test(def || '');
function zhSenseSplit(t) {            // "1 a 2 b 3 c" -> [a, b, c]; numbers must come in order
  t = t.trim(); if (!/^1\s/.test(t)) return [t];
  const out = []; let cur = t.slice(2), k = 2;
  // some Pleco exports glue the number to the word before it ("1 hot2 heat3 popular"): use that only when no spaced number follows
  for (;;) {
    let m = cur.search(new RegExp('\\s' + k + '\\s')), skip = String(k).length + 2;
    if (m < 0) { m = cur.search(new RegExp('(?<=[^\\s\\d])' + k + '\\s(?=[\\p{L}(（])', 'u')); skip = String(k).length + 1; }
    if (m < 0) { out.push(cur); break; }
    out.push(cur.slice(0, m)); cur = cur.slice(m + skip); k++;
  }
  return out.map(x => x.trim()).filter(Boolean);
}
function zhSense(t) {
  const w = t.split(/\s+/).filter(Boolean), isDash = x => /^[—–-]+$/.test(x);
  const isZh = x => ZH_HAN.test(x) || /^[　-〿＀-￯—…]+$/.test(x), isZhStart = x => isZh(x) && !isDash(x);
  // a cross-reference ("See 正音", "= 超级市场", "VARIANT OF 被") stays in the meaning; an example has pinyin after it
  const ref = k => k > 0 && !ZH_TONE.test(w[k + 1] || '') && (/^(see|=|cf\.?|→)$/i.test(w[k - 1].replace(/[:,]$/, '')) || /^(variant|short|same|abbr\.?) (of|for|as)$/i.test((w[k - 2] || '') + ' ' + w[k - 1]));
  let depth = 0, k = 0;
  for (; k < w.length; k++) {
    if (depth === 0 && isZhStart(w[k]) && !ref(k)) break;
    depth += (w[k].match(/[([]/g) || []).length - (w[k].match(/[)\]]/g) || []).length; if (depth < 0) depth = 0;
  }
  let m = w.slice(0, k).join(' '), tags = [], tm;
  while (tags.length < 3 && (tm = ZH_TAG.exec(m)) && m.length > tm[0].length) { tags.push(tm[1]); m = m.slice(tm[0].length); }
  const bare = x => x.replace(/[^\p{L}-]/gu, '').toLowerCase();
  const isPy = (x, nx) => ZH_TONE.test(x) || (ZH_NEUT.has(bare(x)) && (/[.,?!;:？！，。]$/.test(x) || !nx || ZH_TONE.test(nx) || ZH_NEUT.has(bare(nx))));
  const short = x => /^[\d.,:%°]+$/.test(x) || (x.length <= 4 && /^[\dA-Za-z%°.,:]+$/.test(x));   // "36", "P" inside a sentence
  // sentences in the Chinese, so the pinyin of a two-sentence example or a dialogue ("——") is not cut after the first
  const zhEnds = s => (s.match(/[。！？!?][”"’)）]?|——/g) || []).length;
  const pyEnds = a => a.filter(x => /[.?!？！。]["”’)]?$/.test(x) || /^[—–]/.test(x)).length;
  const zhOpen = a => { const t = a.join(' '); return (t.match(/[(（]/g) || []).length > (t.match(/[)）]/g) || []).length; };
  const ex = []; let e = null, st = '';
  for (let i = k; i < w.length; i++) {
    const x = w[i], nx = w[i + 1];
    if (st === 'zh' && (isZh(x) || ((isDash(x) || short(x)) && nx && isZhStart(nx)))) { e.zh.push(x); continue; }
    if (isZhStart(x) && st !== 'en' && st !== 'py') { e = { zh: [x], py: [], en: [] }; ex.push(e); st = 'zh'; continue; }
    if (st === 'zh' || st === 'py') {
      const endPy = st === 'py' && /[.?!？！。]["”’)]?$/.test(e.py[e.py.length - 1] || '');
      const more = pyEnds(e.py) < zhEnds(e.zh.join(''));
      const pyLike = isPy(x, nx) || isDash(x) || (/^[—–]/.test(x) && isPy(x.replace(/^[—–-]+/, ''), nx)) || x === '(or)' || (short(x) && nx && isPy(nx, w[i + 2]));
      const source = st === 'py' && /^[(（]《?\p{Lu}/u.test(x) && ZH_TONE.test(x) && /[)）]/.test(x + ' ' + (nx || '') + ' ' + (w[i + 2] || ''));   // "(Máo Zédōng)" after a quote
      if ((pyLike && (!endPy || more)) || source) { e.py.push(x); st = 'py'; continue; }
      if (isZhStart(x)) { e = { zh: [x], py: [], en: [] }; ex.push(e); st = 'zh'; continue; }
      st = 'en';
    } else if (isZhStart(x) && !(/^[(（]/.test(x) && !/[)）]\p{Script=Han}/u.test(x)) && !zhOpen(e.en)) { e = { zh: [x], py: [], en: [] }; ex.push(e); st = 'zh'; continue; }
    e.en.push(x);
  }
  return { m: m.trim(), tag: tags.join(' · '), ex: ex.map(e => ({ zh: e.zh.join(' '), py: e.py.join(' '), en: e.en.join(' ') })) };
}
function zhParseDef(def) {
  return String(def || '').split('\n').map(l => l.trim()).filter(Boolean).map(l0 => {
    const { lead, rest: l } = zhLead(l0), pm = ZH_POS.exec(l), after = pm ? zhLead(l.slice(pm[0].length)) : { lead: '', rest: l };    // labels can also follow the part of speech
    const pos = [lead, pm ? pm[1] : '', after.lead].filter(Boolean).join(' · ');
    return { pos, senses: zhSenseSplit(after.rest).map(zhSense) };
  });
}
// short meaning for chips, the sheet and prompts: the first meanings, no examples
function zhGloss(def, n = 2) { return zhParseDef(def).flatMap(b => b.senses.map(x => x.m)).filter(Boolean).slice(0, n).join('; ') || String(def || '').slice(0, 80); }
// with a card: its word is marked in the examples and the words you have not learned are dotted
function zhDefHtml(def, card) {
  const blocks = zhParseDef(def);
  const sense = (x, i, many) => {
    const ex = x.ex.map(e => `<div class="zh-ex1"><div lang="zh" class="zh-exz">${card ? zhExHtml(e.zh, card) : esc(e.zh)}</div>${e.py ? `<div class="zh-exp">${esc(e.py)}</div>` : ''}${e.en ? `<div class="zh-exe">${esc(e.en)}</div>` : ''}</div>`);
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
  let w = sh === null ? pw : pw === null ? sh : (() => { const k = Math.min(0.85, 0.4 + 0.1 * r.n); return k * sh + (1 - k) * pw; })();
  // looked up in the reader in the last two weeks: you did not know it in context
  if (r && r.lkT && Date.now() - r.lkT < 14 * DAY) w = Math.min(1, (w === null ? 0.4 : w) + 0.15);
  return w;
}
/* Learned score: Good +100, Easy +150; Hard +25 but it counts as a miss, so it never leaves a card learned;
   Don't know halves it and always drops it below the line. Learned = score >= UI.zhLearnAt (300).
   Pleco's score is on another scale (it multiplies; a failed card sits around 400, and only cards above ~1200 are
   answered right >90% of the time), so it is converted: 400 or less -> 0, 1200 -> the line, log scale between. */
const zhLearnAt = () => Math.max(50, Math.round(+UI.zhLearnAt || 300));
const zhPlBase = c => { const s = c.pl ? c.pl.score || 0 : 0; return s <= 400 ? 0 : Math.round(zhLearnAt() * Math.log(s / 400) / Math.log(3)); };
function zhScore(c) {
  const r = zhP().cards[c.id], b = zhPlBase(c);
  if (!r || r.sc == null) return b;
  if (r.v === 2) return r.sc;
  // a score saved before the conversion was built on Pleco's raw score: rebase it, and a card whose last answer was a miss is not learned
  const raw = c.pl ? Math.max(0, c.pl.score || 0) : 0;
  let sc = Math.max(0, r.sc >= raw ? r.sc - raw + b : Math.min(r.sc, b));
  if (/0$/.test(r.h || '') && sc >= zhLearnAt()) sc = zhLearnAt() - 50;
  return sc;
}
const zhLearned = c => zhScore(c) >= zhLearnAt();
const zhNewScore = (sc, lvl) => lvl === 0 ? Math.max(0, Math.min(Math.floor(sc / 2), zhLearnAt() - 100)) : lvl === 1 ? Math.min(sc + 25, zhLearnAt() - 50) : sc + [0, 25, 100, 150][lvl];
// a StudyHub review record, or null (an undone first rating leaves { n: 0 }, a reader lookup { lk })
function zhRec(c) { const r = zhP().cards[c.id]; return r && (r.n || r.lk) ? r : null; }
// Pleco cards never reviewed here get a review date from their last Pleco review: Pleco's score roughly doubles with each
// right answer, so score / 50 days (100 -> 2 days, 400 -> 8, 3200 -> 64, at most 180)
function zhPlecoDue(c) { const pl = c.pl; return pl && pl.n && pl.last ? pl.last + Math.max(1, Math.min(180, (pl.score || 100) / 50)) * DAY : null; }
function zhDue(c) { const r = zhRec(c); return r ? (r.due || 0) : zhPlecoDue(c); }      // null = new, never reviewed anywhere
function zhStartBox(c) {
  const d = zhPlecoDue(c); if (d === null) return 0;
  const iv = (d - c.pl.last) / DAY; let b = 1; while (b < ZH_INT.length - 1 && ZH_INT[b + 1] <= iv) b++; return b;
}
const zhTomorrow = () => { const d = new Date(); d.setHours(24, 0, 0, 0); return d.getTime(); };
function zhDay() { const d = zhP().days, k = today(); return d[k] = d[k] || { rev: 0, ok: 0, nw: 0, lrn: 0 }; }
// level 0 don't know, 1 hard, 2 good, 3 easy; `again` = second showing in the same set (does not raise the box).
// A card only becomes learned after right answers on two different days (a Pleco review on an earlier day counts as
// one): until then it stops just below the line and comes back tomorrow, so one sitting cannot "learn" a word.
function zhRate(c, lvl, again) {
  const z = zhP(), now = Date.now(), day = today(), at = zhLearnAt();
  const wasLearned = zhLearned(c), isNew = !zhRec(c) && !(c.pl && c.pl.n);
  const r = Object.assign({ b: zhStartBox(c), n: 0, ok: 0, bad: 0, h: '' }, z.cards[c.id]); delete r.u;
  let sc = zhNewScore(zhScore(c), lvl);
  if (lvl >= 2 && r.ld !== day) { r.dd = (r.dd || 0) + 1; r.ld = day; }
  const days = (r.dd || 0) + (c.pl && c.pl.ok && c.pl.last && dayKey(c.pl.last) !== day ? 1 : 0);
  r.cap = !wasLearned && sc >= at && days < 2;
  if (r.cap) sc = at - 1;
  r.sc = sc; r.v = 2;
  if (lvl === 0) { r.b = 1; r.due = now; }
  else if (lvl === 1) { r.b = Math.max(1, Math.min(r.b, 2)); r.due = now + 0.5 * DAY; }
  else if (again) { r.b = Math.max(1, Math.min(r.b, 2)); r.due = now + DAY; }
  else { r.b = Math.min(ZH_INT.length - 1, Math.max(1, r.b) + (lvl === 3 ? 2 : 1)); r.due = now + ZH_INT[r.b] * DAY; }
  if (r.cap) r.due = Math.min(r.due, zhTomorrow());
  r.n++; if (lvl >= 2) r.ok++; else r.bad++;
  r.h = (r.h + (lvl >= 2 ? '1' : '0')).slice(-8); r.t = now;
  z.cards[c.id] = r;
  const D = zhDay(); D.rev++; if (lvl >= 2) D.ok++; if (isNew) D.nw++; if (!wasLearned && sc >= at) D.lrn++;
  bumpDay(); saveP();
}
// a deck word looked up in the reader: a light miss (score -50, back tomorrow, weaker for two weeks)
function zhLookup(c) {
  const z = zhP(), r = Object.assign({ b: zhStartBox(c), n: 0, ok: 0, bad: 0, h: '' }, z.cards[c.id]);
  const d = zhDue(c);
  r.sc = Math.max(0, zhScore(c) - 50); r.v = 2; r.lk = (r.lk || 0) + 1; r.lkT = Date.now(); r.u = Date.now();
  r.due = Math.min(d === null ? Infinity : d, zhTomorrow());
  z.cards[c.id] = r; saveP();
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
  if (f === 'due') { const d = zhDue(c); return d !== null && d <= Date.now(); }
  if (f === 'new') return zhWeak(c) === null;
  if (f === 'learning') return !zhLearned(c);
  if (f === 'learned') return zhLearned(c);
  if (f === 'flagged') return zhFlagged(c, gc);
  if (f === 'unk') return [...c.s].some(zhUnk);
  return true;
}
// answered right today but held just below the line: learned after one more right answer on another day
function zhWaiting(c) { const r = zhRec(c); return !!(r && r.cap && r.ld === today() && !zhLearned(c)); }
// learned and answered right today: done for a repeat-until-learned run over the learned cards
function zhRightToday(c) { const r = zhRec(c); return !!(r && r.ld === today() && zhLearned(c)); }
const zhRefresh = o => !!(o.until && o.filter === 'learned');    // repeat the learned cards until each is answered right again
// what a repeat-until-learned choice still has to do: { left, learned, waiting } over the matching cards
function zhUntilCounts(o) {
  const all = zhPool(Object.assign({}, o, { until: false }));
  let learned = 0, waiting = 0, refresh = 0;      // learned = learned and answered right today; refresh = learned, not yet today
  for (const c of all) { if (zhLearned(c)) { if (zhRightToday(c)) learned++; else refresh++; } else if (zhWaiting(c)) waiting++; }
  return { total: all.length, learned, waiting, refresh, left: all.length - learned - waiting };
}
// repeat-until-learned: cards not learned yet go first, then the learned ones to answer right once
const zhUntilOrder = cs => cs.filter(c => !zhLearned(c)).concat(cs.filter(zhLearned));
function zhPool(o) {
  const gc = zhGroupChars();
  let cs = o.ids ? o.ids.map(id => ZH.byId.get(id)).filter(Boolean) : ZH.cards.filter(c => zhMatches(c, o, gc));
  // repeat-until-learned: only cards still to do today (learned cards until answered right today)
  if (o.until) cs = cs.filter(c => zhLearned(c) ? !zhRightToday(c) : !zhWaiting(c));
  const ord = o.order || 'weak';
  if (ord === 'keep') return cs;
  const fin = o.until ? zhUntilOrder : x => x;
  if (ord === 'random') return fin(shuffle(cs));
  if (ord === 'due') { const d = c => { const x = zhDue(c); return x === null ? Infinity : x; }; return fin(shuffle(cs).sort((a, b) => d(a) - d(b))); }
  const w = c => { const x = zhWeak(c); return x === null ? -1 : x; };
  return fin(shuffle(cs).sort((a, b) => w(b) - w(a)));      // shuffled first, so equal scores come in a new order each time
}
const zhOpts = () => ({ cats: UI.zhCats || [], filter: UI.zhFilter || 'all', weakMin: UI.zhWeakMin == null ? ZH_WEAK : UI.zhWeakMin, order: UI.zhOrder || 'weak', until: !!UI.zhUntil });
const zhBatch = () => Math.max(1, Math.min(500, Math.round(+UI.zhBatch || 20)));
const zhNewPerDay = () => Math.max(0, Math.min(200, Math.round(UI.zhNewPerDay == null ? 10 : +UI.zhNewPerDay)));
const zhMaxRev = () => Math.max(10, Math.min(1000, Math.round(+UI.zhMaxRev || 150)));
const zhInCats = (c, sel = UI.zhCats || []) => !sel.length || sel.some(p => zhCatsOf(c).some(x => x === p || x.startsWith(p + '/')));
/* Today: the reviews that are due (the most overdue for their interval first), up to the daily maximum, with the new
   words of the day mixed in (one after every five reviews) in deck order: Level 1 Set 01 before Set 02 and so on.
   Uses the ticked categories, if any. */
function zhToday() {
  const now = Date.now(), D = zhP().days[today()] || {};
  const order = new Map(ZH.cards.map((c, i) => [c.id, i])), firstCat = c => zhCatsOf(c)[0];
  const due = [];
  for (const c of ZH.cards) {
    if (!zhInCats(c)) continue;
    const d = zhDue(c); if (d === null || d > now) continue;
    const r = zhRec(c), iv = r ? Math.max(0.5, ZH_INT[r.b || 1] || 1) : Math.max(1, (zhPlecoDue(c) - c.pl.last) / DAY);
    due.push([c, (now - d) / DAY / iv]);
  }
  due.sort((a, b) => b[1] - a[1]);
  const revLeft = Math.max(0, zhMaxRev() - Math.max(0, (D.rev || 0) - (D.nw || 0))), newLeft = Math.max(0, zhNewPerDay() - (D.nw || 0));
  const fresh = ZH.cards.filter(c => zhInCats(c) && !zhRec(c) && !(c.pl && c.pl.n))
    .sort((a, b) => firstCat(a).localeCompare(firstCat(b), undefined, { numeric: true }) || order.get(a.id) - order.get(b.id)).slice(0, newLeft);
  const rev = due.slice(0, revLeft).map(([c]) => c), out = [];
  let k = 0;
  rev.forEach((c, i) => { out.push(c); if ((i + 1) % 5 === 0 && k < fresh.length) out.push(fresh[k++]); });
  while (k < fresh.length) out.push(fresh[k++]);
  return { cards: out, due: due.length, rev: rev.length, fresh: fresh.length };
}

/* ---------- sets ---------- */
function zhStart(o, prev) {
  const pool = zhPool(o), seen = new Set(prev && !o.until ? prev.seen : []);
  let rest = pool.filter(c => !seen.has(c.id)), wrapped = false;
  if (!rest.length && pool.length) { rest = pool; seen.clear(); wrapped = true; }
  if (!rest.length) {
    if (zhRefresh(o)) {
      const u = zhUntilCounts(o);
      toast(u.total ? `All ${u.total} learned card${u.total === 1 ? '' : 's'} here answered right today` : 'No learned cards match these choices');
    } else if (o.until) {
      const u = zhUntilCounts(o);
      toast(u.total ? `All ${u.total} card${u.total === 1 ? '' : 's'} here ${u.total === 1 ? 'is' : 'are'} learned${u.waiting ? ` (${u.waiting} waiting for tomorrow - a right answer then makes ${u.waiting === 1 ? 'it' : 'them'} learned)` : ''}` : 'No cards match these choices');
    } else toast('No cards match these choices');
    return false;
  }
  const ids = rest.slice(0, zhBatch()).map(c => c.id);
  ids.forEach(id => seen.add(id));
  ZS = { o, ids, i: 0, flipped: false, good: 0, again: 0, req: [], missed: [], seen: [...seen], setNo: prev ? prev.setNo + 1 : 1, pool: pool.length, wrapped,
    until: !!o.until, total: ids.length, learnedN: 0, capN: 0, rated: [], wasL: ids.filter(id => zhLearned(ZH.byId.get(id))) };
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
  const undo = zhCanUndo() ? '<button class="btn ghost" data-zh="undo" title="Undo the last rating (← or U)">↶ Undo</button>' : '';
  const sug = ZS.flipped && ZS.typed ? ZS.typed.sug : -1;
  return ZS.flipped
    ? `<div class="rate">${[['0', "Don't know", 'bad'], ['1', 'Hard', 'warnbtn'], ['2', 'Good', 'primary'], ['3', 'Easy', 'good']].map(([l, t, k]) => `<button class="btn ${k}${+l === sug ? ' zh-sug' : ''}" data-zh="rate" data-l="${l}">${t} <span class="kbd" style="background:transparent;color:inherit">${+l + 1}</span></button>`).join('')}</div>`
    : `<div class="rate">${undo}<button class="btn primary" data-zh="${UI.zhDir === 'type' ? 'type-check' : 'flip'}">${UI.zhDir === 'type' ? 'Check' : 'Show answer'}</button></div>`;
}
const ZH_MK = { a: 'āáǎà', e: 'ēéěè', i: 'īíǐì', o: 'ōóǒò', u: 'ūúǔù', 'ü': 'ǖǘǚǜ' };
function zhMarks(t) {           // "ni3hao3" -> "nǐhǎo" (same rules as engine/zh_common.py)
  return String(t).replace(/([a-zü:v]+?)([1-5])/gi, (m, syl, tn) => {
    const s = syl.replace(/u:|v/g, 'ü').replace(/U:|V/g, 'Ü'), l = s.toLowerCase(); tn = +tn;
    if (tn === 5) return s;
    let i = l.indexOf('a'); if (i < 0) i = l.indexOf('e'); if (i < 0 && l.includes('ou')) i = l.indexOf('o');
    if (i < 0) i = Math.max(...['i', 'o', 'u', 'ü'].map(v => l.lastIndexOf(v)));
    return i < 0 ? s : s.slice(0, i) + ZH_MK[l[i]][tn - 1] + s.slice(i + 1);
  });
}
const zhPyNorm = t => zhMarks(String(t).toLowerCase().replace(/v/g, 'ü')).normalize('NFC').replace(/[\s'’·\-\/,.]/g, '');
const zhPyBare = t => zhPyNorm(t).normalize('NFD').replace(/[̀-ͯ]/g, '');
// result of typing: ok, tones wrong (syllables right), or wrong; and the rating it suggests
function zhCheckPy(typed, py) {
  const alts = String(py).split(/\s*[;,|]\s*/).filter(Boolean);
  if (!typed.trim()) return { ok: false, tones: false, sug: 0 };
  if (alts.some(a => zhPyNorm(a) === zhPyNorm(typed))) return { ok: true, tones: true, sug: 2 };
  if (alts.some(a => zhPyBare(a) === zhPyBare(typed))) return { ok: false, tones: true, sug: 1 };
  return { ok: false, tones: false, sug: 0 };
}
// example sentence for the front of the card: only one where you have learned every other word
function zhExample(c) { const b = zhBestExample(c); return b && !b.unk.length ? b.e : null; }
function zhCharsHtml(word, big) {
  return [...word].map(ch => ZH_HAN.test(ch) ? `<button class="zh-ch${big ? ' big' : ''}${zhHard(ch) ? ' hard' : ''}${zhUnk(ch) ? ' unk' : ''}" data-zh="char" data-c="${esc(ch)}" data-w="${esc(word)}" title="Flag this character">${esc(ch)}</button>` : esc(ch)).join('');
}
function zhExBox(c) {
  const b = zhBestExample(c); if (!b) return '';
  const e = b.e, n = b.unk.length;
  return `<div class="zh-exbox"><div class="zh-pos">Example <span class="zh-exnote">${n ? `${n} word${n === 1 ? '' : 's'} not learned yet` : 'every word learned'}${e.gen ? ' · written for you' : ''}</span></div>
    <div lang="zh" class="zh-exz">${zhExHtml(e.zh, c, b.unk)} <button class="btn sm ghost" data-zh="speak" data-w="${esc(e.zh)}" title="Listen" aria-label="Listen">🔊</button></div>${e.py ? `<div class="zh-exp">${esc(e.py)}</div>` : ''}${e.en ? `<div class="zh-exe">${esc(e.en)}</div>` : ''}</div>`;
}
function zhBack(c) {
  const chars = [...c.s].filter(ch => ZH_HAN.test(ch));
  const gl = chars.length > 1 ? chars.map(ch => { const i = zhCharInfo(ch)[0]; return `<div class="zh-gl1"><button class="zh-ch" data-zh="char" data-c="${esc(ch)}" lang="zh">${esc(ch)}</button><span>${i ? `${esc(i.py)} · ${esc(i.def)}` : ''}</span></div>`; }).join('') : '';
  const r = zhRec(c), w = zhWeak(c);
  const stats = [c.pl && c.pl.n ? `Pleco ${c.pl.ok}/${c.pl.ok + c.pl.bad} right` : '', r ? `here ${r.ok}/${r.n} right` : '', w === null ? 'new' : w >= ZH_WEAK ? 'weak' : ''].filter(Boolean).join(' · ');
  const sc = zhScore(c), at = zhLearnAt(), T = ZS && ZS.typed && ZS.typed.id === c.id ? ZS.typed : null;
  const typedBox = T ? `<div class="zh-typed ${T.ok ? 'ok' : T.tones ? 'tone' : 'bad'}">${T.ok ? '✓ Right' : T.tones ? '≈ Right syllables, wrong tones' : '✗ Not quite'}${T.ok ? '' : ` - you typed <b>${esc(T.v || '(nothing)')}</b>`}</div>` : '';
  const capNote = r && r.cap && !zhLearned(c) ? ' · learned after one more right answer on another day' : '';
  return `${typedBox}<div class="zh-ahead">
      <div class="zh-hw" lang="zh">${zhCharsHtml(zhHead(c), true)}</div>
      <div class="zh-py">${esc(c.py)} <button class="btn sm ghost" data-zh="speak" data-w="${esc(c.s)}" title="Listen (S)" aria-label="Listen">🔊</button></div>
      <div class="zh-scoreline small muted"><span class="zh-lb wide"><i style="width:${Math.min(100, Math.round(100 * sc / at))}%"></i></span> ${zhLearned(c) ? '<b class="zh-ok">learned</b>' : `score ${sc} / ${at}`}${capNote}${stats ? ' · ' + stats : ''}</div></div>
    ${zhExBox(c)}
    <div class="zh-defs">${zhIsPleco(c.def) ? zhDefHtml(c.def, c) : `<b class="zh-m">${esc(c.def).replace(/\n/g, '<br>')}</b>`}</div>
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
  const c = ZH.byId.get(s.ids[s.i]), r = zhRec(c), dir = UI.zhDir || 'hz', en = dir === 'en';
  const ex = dir === 'hz' && UI.zhExample ? zhExample(c) : null;
  const head = `<div class="zh-hw" lang="zh">${esc(zhHead(c))}</div>${UI.zhPinyin ? `<div class="zh-py">${esc(c.py)}</div>` : ''}`;
  const front = en ? `<div class="zh-def big"><b>${esc(zhShort(c.def, 3))}</b></div>`
    : dir === 'listen' ? `<button class="btn primary zh-listen" data-zh="speak" data-w="${esc(c.s)}">🔊 Listen again</button><div class="small muted" style="margin-top:10px">What does it mean?</div>`
    : dir === 'type' ? `${head}<input id="zh-type" class="zh-in zh-typein" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="pinyin: ni3hao3 or nǐhǎo" aria-label="Type the pinyin">`
    : ex ? `<div class="zh-exfront" lang="zh">${zhExHtml(ex.zh, c, [])}</div><div class="small muted" style="margin-top:8px">What does the marked word mean?</div>`
    : head;
  main.innerHTML = `<div class="deck-wrap zh-play ${s.flipped ? '' : 'front'}">
    <div class="crumbs"><a href="#/zh">← Chinese</a> · Set ${s.setNo}${s.o.title ? ' · ' + esc(s.o.title) : ''}</div>
    <div class="prog-row">${s.until
      ? `<span class="small muted zh-tick"><b>${s.ids.length - s.i}</b> left · <b>${s.learnedN}</b>/${s.total} learned${s.capN ? ` · ${s.capN} for tomorrow` : ''}</span><div class="bar"><i style="width:${Math.round(100 * (s.learnedN + (s.capN || 0)) / s.total)}%"></i></div>`
      : `<span class="small muted">${s.i + 1} / ${s.ids.length}</span><div class="bar"><i style="width:${Math.round(100 * s.i / s.ids.length)}%"></i></div>`}
      <span class="leitner" title="Review box here">${[1, 2, 3, 4, 5, 6, 7].map(i => `<i class="${r && i <= r.b ? 'on' : ''}"></i>`).join('')}</span></div>
    <div class="card zh-card ${s.flipped ? 'flipped' : ''}" ${s.flipped ? '' : 'data-zh="flip" tabindex="0" role="button" aria-label="Show answer"'}>
      ${s.flipped ? zhBack(c) : `<div class="zh-front"><span class="zh-lbl">${({ en: 'Meaning', listen: 'Listen', type: 'Type the pinyin' })[dir] || (ex ? 'In context' : 'Word')}</span>${front}<span class="zh-hint">click or <span class="kbd">Space</span></span></div>`}</div>
    ${zhRateHtml()}
    <p class="muted small zh-keys"><span class="kbd">Space</span> flip · <span class="kbd">1</span>–<span class="kbd">4</span> rate · <span class="kbd">S</span> listen · <span class="kbd">←</span> undo. ${s.until ? `A card leaves the set when its score reaches ${zhLearnAt()} (Good +100, Easy +150, Hard +25 but never learned, Don't know halves it).` : `"Don't know" brings the card back later in this set.`}</p></div>`;
  if (keep && s.flipped) zhToCard(); else window.scrollTo({ top: 0, behavior: 'instant' });
  if (!s.flipped && dir === 'listen' && s.spoken !== s.ids[s.i] + '|' + s.i) { s.spoken = s.ids[s.i] + '|' + s.i; zhSpeak(c.s, true); }
  if (!s.flipped && dir === 'type') { const t = $('#zh-type'); if (t) t.focus({ preventScroll: true }); }
}
// reveal: draw the answer and bring the top of the card into view (long Pleco entries otherwise start off screen)
function zhTypeCheck() {
  const c = ZS && ZH.byId.get(ZS.ids[ZS.i]); if (!c || ZS.flipped) return;
  const v = (($('#zh-type') || {}).value || '').trim();
  ZS.typed = Object.assign({ id: c.id, v }, zhCheckPy(v, c.py));
  ZS.flipped = true; zhSave(); zhPlay(true);
}
function zhFlip() {
  if (!ZS || !$('.zh-play')) return;
  if (!ZS.flipped && UI.zhDir === 'type') return zhTypeCheck();
  ZS.flipped = !ZS.flipped; zhSave(); zhPlay(true);
}
function zhToCard() {
  const el = $('.zh-play .zh-card'); if (!el) return;
  const bar = ($('.topbar') && getComputedStyle($('.topbar')).display !== 'none' && !document.body.classList.contains('top-hidden')) ? $('.topbar').offsetHeight : 0;
  window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + scrollY - bar - 70), behavior: 'instant' });
}
const ZH_UNDO = 20;                                  // ratings that can be undone, one after another
const zhCanUndo = () => !!(ZS && ((ZS.undos && ZS.undos.length) || ZS.undo));
function zhRateCur(l) {
  const s = ZS, c = ZH.byId.get(s.ids[s.i]); if (!c || !s.flipped) return;
  const z = zhP(), stack = (s.undos || []).concat(s.undo ? [s.undo] : []);
  const undo = { id: c.id, rec: z.cards[c.id] ? JSON.parse(JSON.stringify(z.cards[c.id])) : null, day: z.days[today()] ? Object.assign({}, z.days[today()]) : null,
    zs: JSON.stringify(Object.assign({}, s, { undo: null, undos: null })) };
  s.typed = null;
  zhRateDo(c, l);
  ZS.undo = null; ZS.undos = stack.concat([undo]).slice(-ZH_UNDO); ZH.knownAt = 0; zhSave(); zhPlay();
}
// Undo the last rating (again for the one before): the card's record, today's counts and the set go back to just before it (answer showing)
function zhUndo() {
  if (!zhCanUndo()) return;
  const stack = (ZS.undos || []).concat(ZS.undo ? [ZS.undo] : []), u = stack.pop();
  const z = zhP();
  z.cards[u.id] = Object.assign(u.rec || { n: 0 }, { u: Date.now() });
  if (u.day) z.days[today()] = u.day; else delete z.days[today()];
  ZS = JSON.parse(u.zs); ZS.flipped = true; ZS.undo = null; ZS.undos = stack; ZS.typed = null; ZH.knownAt = 0;
  saveP(); zhSave(); zhPlay(true); toast(stack.length ? `Rating undone · ← again for the one before` : 'Last rating undone');
}
function zhRateDo(c, l) {
  const s = ZS;
  if (s.until) {          // the card stays in the set until it is learned, then the set is one smaller
    const again = s.rated.includes(c.id); zhRate(c, l, again); if (!again) s.rated.push(c.id);
    if (l >= 2) s.good++; else { s.again++; if (!s.missed.includes(c.id)) s.missed.push(c.id); }
    s.ids.splice(s.i, 1);
    const r = zhRec(c);
    // a card learned before the set leaves on its first right answer, even if a miss on the way left it weak
    if (zhLearned(c) || (l >= 2 && (s.wasL || []).includes(c.id))) s.learnedN++;         // counted in the bar at the top (no pop-up)
    else if (r && r.cap) s.capN++;          // right today; learned after one more right answer on another day (no pop-up)
    else s.ids.splice(Math.min(s.ids.length, s.i + 4), 0, c.id);
    s.flipped = false; return;
  }
  const again = s.req.includes(c.id);
  zhRate(c, l, again);
  if (l >= 2) s.good++; else { s.again++; if (!s.missed.includes(c.id)) s.missed.push(c.id); }
  if (l === 0 && !again) { s.req.push(c.id); s.ids.splice(Math.min(s.ids.length, s.i + 6), 0, c.id); }
  s.i++; s.flipped = false;
}
function zhEnd() {
  if (!ZS.ghSynced) { ZS.ghSynced = true; zhSave(); if (typeof ghSync === 'function') ghSync(); }    // send the finished set right away
  const s = ZS, left = Math.max(0, s.pool - s.seen.length);
  const miss = s.missed.map(id => ZH.byId.get(id)).filter(Boolean);
  main.innerHTML = `<div class="q-card card zh-end" style="text-align:center">
    <h2>${s.until ? (s.capN ? `${s.learnedN} learned · ${s.capN} for tomorrow` : `All ${s.total} learned`) : s.o.today ? 'Today: set done' : `Set ${s.setNo} done`}</h2>
    <p class="muted">${s.good} right · ${s.again} ${s.until ? 'misses on the way' : 'to revisit'}${s.wrapped ? ' · you had been through every matching card, so this set started over' : ''}</p>
    ${miss.length ? `<details class="zh-missd"><summary>${miss.length} word${miss.length === 1 ? '' : 's'} you missed</summary><div class="zh-misslist">${miss.map(c => `<button class="zh-mrow" data-zh="word" data-w="${esc(c.s)}"><b lang="zh">${esc(zhHead(c))}</b><span class="zh-mpy">${esc(c.py)}</span><span class="zh-mm">${esc(zhShort(c.def, 2))}</span></button>`).join('')}</div></details>` : ''}
    <div class="row" style="justify-content:center;margin-top:14px">
      ${zhCanUndo() ? '<button class="btn ghost" data-zh="undo">↶ Undo last rating <span class="kbd" style="background:transparent;color:inherit">←</span></button>' : ''}
      <button class="btn primary" data-zh="next-set">Next set of ${zhBatch()} <span class="kbd" style="background:transparent;color:inherit">Enter</span></button>
      ${miss.length ? `<button class="btn" data-zh="redo-missed">Again: the ${miss.length} I missed</button>` : ''}
      <a class="btn ghost" href="#/zh">Back</a></div>
    <p class="small muted" style="margin-top:10px">${s.o.today ? (() => { const t = zhToday(); return t.cards.length ? `${t.rev} review${t.rev === 1 ? '' : 's'} and ${t.fresh} new word${t.fresh === 1 ? '' : 's'} left for today.` : 'Nothing more for today.'; })() : s.until ? (() => { const n = zhPool(s.o).length; return n ? `${n} matching card${n === 1 ? '' : 's'} still to ${zhRefresh(s.o) ? 'answer right' : 'learn'} today.` : (() => { const u = zhUntilCounts(s.o); return `All ${u.total} matching cards are learned${u.waiting ? ` or waiting for tomorrow (${u.waiting})` : ''}.`; })(); })()
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
function zhSheetClose() { const el = document.getElementById('zh-sheet'); if (el) el.hidden = true; document.body.classList.remove('zh-sheet-open'); zhSheetMark(null); }
// which word or character the open sheet belongs to, so a second tap on that same one closes it (PC and phone);
// the tapped word stays outlined while its sheet is open
function zhSheetMark(key, el) {
  $$('.zh-on').forEach(x => x.classList.remove('zh-on'));
  ZH.sheetKey = key; ZH.sheetEl = el || null;
  if (el && el.classList) el.classList.add('zh-on');
}
function zhSheetIs(key, el) { const sh = document.getElementById('zh-sheet'); return !!(sh && !sh.hidden && ZH.sheetKey === key && ZH.sheetEl === el); }
function zhCharSheet(ch, anchor, word) {
  if (word !== undefined) ZH.sheetWord = word;
  const z = zhP(), info = zhCharInfo(ch), groups = zhLive(z.groups);
  const mine = groups.filter(([, g]) => g.chars.includes(ch)), other = groups.filter(([, g]) => !g.chars.includes(ch));
  const words = zhWordsWith(ch, 6);
  zhSheet(`<div class="row" style="align-items:flex-start;gap:16px">
      <div class="zh-sbig" lang="zh">${esc(ch)}</div>
      <div style="flex:1;min-width:0">${info.length ? info.slice(0, 3).map(i => `<div><b>${esc(i.py)}</b> <span class="muted">${esc(i.def)}</span></div>`).join('') : '<div class="muted">No dictionary entry here</div>'}
        <div class="row" style="margin-top:8px">
          <button class="btn sm ${zhUnk(ch) ? 'primary' : ''}" data-zh="unk-toggle" data-c="${esc(ch)}" title="Collect it under Characters I don't understand">${zhUnk(ch) ? '✓ Understood now' : "? Don't understand"}</button>
          <button class="btn sm ${zhHard(ch) ? 'warnbtn' : ''}" data-zh="flag-char" data-c="${esc(ch)}" title="A character you mix up with others (Look-alikes)">⚑ ${zhHard(ch) ? 'Flagged - unflag' : 'Flag as hard'}</button>
          <button class="btn sm ghost" data-zh="speak" data-w="${esc(ch)}">🔊</button></div></div></div>
    ${mine.length ? `<div class="small" style="margin-top:10px">In look-alike group${mine.length > 1 ? 's' : ''}: ${mine.map(([gid, g]) => `<a href="#/zh/compare" class="zh-chip" lang="zh">${esc(g.chars.join(' '))}</a>`).join(' ')}</div>` : ''}
    <div class="small" style="margin-top:10px"><b>Looks like…</b> ${other.length ? 'add to ' + other.slice(0, 8).map(([gid, g]) => `<button class="zh-chip" data-zh="group-add" data-g="${gid}" data-c="${esc(ch)}" lang="zh">${esc(g.chars.join(' '))} ＋</button>`).join(' ') + ' or ' : ''}
      <span class="zh-inline"><input id="zh-gnew" class="zh-in" lang="zh" placeholder="characters it looks like, e.g. 己巳" aria-label="Characters it looks like"><button class="btn sm" data-zh="group-new" data-c="${esc(ch)}">New group</button></span></div>
    ${words.length ? `<div class="small" style="margin-top:10px"><b>Your words with ${esc(ch)}:</b> ${words.map(c => `<button class="zh-chip" data-zh="word" data-w="${esc(c.s)}"><span lang="zh">${zhMark(c.s, ch)}</span> <span class="muted">${esc(zhShort(c.def, 1))}</span></button>`).join(' ')}</div>` : ''}`, anchor);
}
const zhMark = (word, ch) => [...word].map(x => x === ch ? `<mark>${esc(x)}</mark>` : esc(x)).join('');
function zhWordSheet(w, anchor) {
  const c0 = ZH.bySimp.get(w), lkKey = ZH.cur && c0 && anchor ? ZH.cur.id + '|' + c0.id : null;   // only a tap on a word in a text
  ZH.looked = ZH.looked || new Set();
  if (lkKey && !ZH.looked.has(lkKey)) { ZH.looked.add(lkKey); zhLookup(c0); }
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
    ${lkKey ? '<div class="small muted" style="margin-top:4px">Looked up while reading: it comes back in tomorrow\'s review.</div>' : ''}
    <div class="row" style="margin-top:10px">
      <button class="btn sm" data-zh="full">Definition</button>
      <button class="btn sm ghost" data-zh="speak" data-w="${esc(w)}">🔊 Listen</button>
      ${c ? `<button class="btn sm ${zhHardW(c.id) ? 'warnbtn' : 'ghost'}" data-zh="flag-word" data-id="${esc(c.id)}">⚑ ${zhHardW(c.id) ? 'Flagged' : 'Flag'}</button>`
        : chars.length ? `<button class="btn sm ghost" data-zh="add-word" data-w="${esc(w)}" data-py="${esc(py)}" data-def="${esc((g && g.en) || (d[0] ? zhShort(d[0].def, 3) : ''))}">＋ Add to deck</button>` : ''}</div>
    <div class="zh-full" hidden>${full}${chars.length > 1 ? `<div style="margin-top:10px" class="small"><b>Characters</b>${chars.map(ch => { const i = zhCharInfo(ch)[0]; return `<div><button class="zh-ch" data-zh="char" data-c="${esc(ch)}">${esc(ch)}</button> ${i ? esc(i.py) + ' · ' + esc(i.def) : ''}</div>`; }).join('')}</div>` : ''}</div>`, anchor);
}

/* ---------- views ---------- */
/* Look-alike quiz: tell the characters of a group apart. Two kinds of question, mixed:
   - one of your words with the character left out (＿经 · yǐjīng · already): pick the right character from the group
   - the character alone: pick its reading and meaning among the group's */
let ZQ = null;
function zhQuizInfo(ch) { const i = zhCharInfo(ch)[0]; return i ? `${i.py} · ${i.def}` : ''; }
function zhQuizStart(gids) {
  const qs = [];
  for (const gid of gids) {
    const g = zhP().groups[gid]; if (!g || g.del || g.chars.length < 2) continue;
    for (const ch of g.chars) {
      const w = shuffle(zhWordsWith(ch, 8))[0];
      if (w || zhQuizInfo(ch)) qs.push({ kind: 'pick', ch, opts: shuffle(g.chars), word: w ? w.id : null });
      if (zhQuizInfo(ch) && g.chars.filter(x => zhQuizInfo(x)).length >= 2) qs.push({ kind: 'mean', ch, opts: shuffle(g.chars.filter(x => zhQuizInfo(x))) });
    }
  }
  if (!qs.length) { toast('Make a group of at least two characters first'); return; }
  ZQ = { qs: shuffle(qs).slice(0, 12), i: 0, right: 0, wrong: [], pick: null, gids };
  go('#/zh/quiz');
}
function zhQuiz() {
  if (!ZQ) { location.hash = '#/zh/compare'; return; }
  const q = ZQ.qs[ZQ.i];
  if (!q) {
    main.innerHTML = `<div class="q-card card" style="text-align:center"><h2>${ZQ.right} / ${ZQ.qs.length} right</h2>
      ${ZQ.wrong.length ? `<p class="muted">Mixed up: <span lang="zh" class="zh-big sm" style="font-size:1.6rem">${[...new Set(ZQ.wrong)].map(esc).join(' ')}</span></p>` : '<p class="muted">No mix-ups.</p>'}
      <div class="row" style="justify-content:center"><button class="btn primary" data-zh="quiz-again">Again</button><a class="btn ghost" href="${ZQ.back || '#/zh/compare'}">${ZQ.back ? 'Back to the characters' : 'Back to look-alikes'}</a></div></div>`;
    return;
  }
  const w = q.word && ZH.byId.get(q.word), done = ZQ.pick !== null;
  const prompt = q.kind === 'pick'
    ? (w ? `<div class="zh-quizw" lang="zh">${[...w.s].map(x => x === q.ch ? '<span class="zh-gap">＿</span>' : esc(x)).join('')}</div><div class="zh-py">${esc(w.py)}</div><div class="muted">${esc(zhShort(w.def, 2))}</div>`
         : `<div class="zh-py">${esc(zhQuizInfo(q.ch))}</div>`) + '<div class="small muted" style="margin-top:8px">Which character?</div>'
    : `<div class="zh-big" lang="zh" style="cursor:default">${esc(q.ch)}</div><div class="small muted">Which reading and meaning?</div>`;
  const opt = (x, k) => {
    const cls = done ? (x === q.ch ? 'good' : x === ZQ.pick ? 'bad' : '') : '';
    const label = q.kind === 'pick' ? `<span lang="zh" class="zh-qbig">${esc(x)}</span>` : esc(zhQuizInfo(x));
    return `<button class="btn zh-qopt ${cls}" data-zh="quiz-pick" data-c="${esc(x)}" ${done ? 'disabled' : ''}>${label}${done && q.kind === 'pick' ? `<span class="small">${esc(zhQuizInfo(x))}</span>` : ''}</button>`;
  };
  main.innerHTML = `<div class="deck-wrap"><div class="crumbs"><a href="${ZQ.back || '#/zh/compare'}">← ${ZQ.back ? 'Characters' : 'Look-alikes'}</a> · Quiz ${ZQ.i + 1} / ${ZQ.qs.length}</div>
    <div class="card zh-quiz" style="text-align:center">${prompt}
      <div class="zh-qopts ${q.kind}">${q.opts.map(opt).join('')}</div>
      ${done ? `<p class="${ZQ.pick === q.ch ? 'zh-ok' : 'zh-bad'}" style="font-weight:600">${ZQ.pick === q.ch ? '✓ Right' : `✗ It was ${esc(q.ch)}`}</p><button class="btn primary" data-zh="quiz-next">Next <span class="kbd" style="background:transparent;color:inherit">Enter</span></button>` : ''}
    </div></div>`;
}
function zhQuizPick(ch) {
  const q = ZQ && ZQ.qs[ZQ.i]; if (!q || ZQ.pick !== null) return;
  ZQ.pick = ch; const right = ch === q.ch, z = zhP(), rec = Object.assign({ ok: 0, bad: 0 }, z.lq[q.ch]);
  if (right) { ZQ.right++; rec.ok++; } else { ZQ.wrong.push(q.ch); rec.bad++; }
  rec.t = Date.now(); z.lq[q.ch] = rec; saveP(); zhQuiz();
}
/* ---------- statistics ---------- */
// one bar chart: one measure, one colour (accent), bars anchored on the baseline; exact numbers on hover/tap and in a table
function zhBars(rows, unit, label) {
  const max = Math.max(1, ...rows.map(r => r.v));
  const bars = rows.map(r => `<span class="zh-bar ${r.now ? 'now' : ''}" tabindex="0" data-tip="${esc(r.label)}: ${r.v} ${unit}" aria-label="${esc(r.label)}: ${r.v} ${unit}">
    <i style="height:${r.v ? Math.max(3, Math.round(100 * r.v / max)) : 0}%"></i></span>`).join('');
  return `<figure class="zh-chart" aria-label="${esc(label)}">
    <div class="zh-chart-max small muted">${max}</div>
    <div class="zh-bars" style="--n:${rows.length}">${bars}</div>
    <div class="zh-chart-x small muted"><span>${esc(rows[0].short || rows[0].label)}</span><span>${esc(rows[rows.length - 1].short || rows[rows.length - 1].label)}</span></div>
    <details class="zh-chart-table"><summary class="small muted">Show as table</summary><table class="small">${rows.map(r => `<tr><td>${esc(r.label)}</td><td>${r.v}</td></tr>`).join('')}</table></details>
  </figure>`;
}
function zhStatsData() {
  const z = zhP(), now = Date.now(), at = zhLearnAt(), cats = new Map();
  const T = { cards: 0, learned: 0, here: 0, pleco: 0, right: 0, all: 0, due: 0 }, hard = [];
  const add = (key, c, x) => { let o = cats.get(key); if (!o) cats.set(key, o = { cards: 0, learned: 0, here: 0, pleco: 0, right: 0, all: 0, due: 0 }); for (const k in x) o[k] += x[k]; };
  for (const c of ZH.cards) {
    const r = zhRec(c), pl = c.pl || {}, d = zhDue(c);
    const x = { cards: 1, learned: zhScore(c) >= at ? 1 : 0, here: r ? r.n || 0 : 0, pleco: pl.n || 0,
      right: (r ? r.ok || 0 : 0) + (pl.ok || 0), all: (r ? (r.ok || 0) + (r.bad || 0) : 0) + (pl.ok || 0) + (pl.bad || 0), due: d !== null && d <= now ? 1 : 0 };
    for (const k in x) T[k] += x[k];
    const paths = new Set();
    zhCatsOf(c).forEach(cat => { const p = cat.split('/'); for (let i = 1; i <= p.length; i++) paths.add(p.slice(0, i).join('/')); });
    paths.forEach(p => add(p, c, x));
    const miss = x.all - x.right;
    if (x.all >= 3 && miss) hard.push([c, miss / x.all, miss, x.all]);
  }
  hard.sort((a, b) => b[1] - a[1] || b[2] - a[2]);
  // streak: days in a row with reviews, counting back from today (or yesterday, if nothing yet today)
  let streak = 0;
  for (let k = (z.days[today()] || {}).rev ? 0 : 1; ; k++) { const d = z.days[dayKey(now - k * DAY)]; if (d && d.rev) streak++; else break; }
  return { T, cats, hard: hard.slice(0, 12), streak };
}
function zhStatsPage() {
  const { T, cats, hard, streak } = zhStatsData(), z = zhP(), pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '-';
  const days = n => Array.from({ length: n }, (_, k) => { const key = dayKey(Date.now() - (n - 1 - k) * DAY); return { key, d: z.days[key] || {} }; });
  const d30 = days(30), fmt = key => new Date(key + 'T12:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const revRows = d30.map(({ key, d }) => ({ label: fmt(key), v: d.rev || 0, now: key === today() }));
  const lrnRows = d30.map(({ key, d }) => ({ label: fmt(key), v: d.lrn || 0, now: key === today() }));
  // reviews coming up: cards whose review date falls on each of the next 14 days
  const ahead = Array.from({ length: 14 }, (_, k) => ({ start: new Date(new Date().setHours(0, 0, 0, 0) + (k + 1) * DAY).getTime(), v: 0 }));
  for (const c of ZH.cards) { const d = zhDue(c); if (d === null) continue; const k = Math.floor((d - ahead[0].start) / DAY); if (k >= 0 && k < 14) ahead[k].v++; }
  const aheadRows = ahead.map(a => ({ label: new Date(a.start).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }), short: new Date(a.start).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), v: a.v }));
  const rev30 = revRows.reduce((n, r) => n + r.v, 0);
  const tile = (n, l, sub) => `<div class="zh-tile"><div class="zh-tile-n">${n}</div><div class="small muted">${l}</div>${sub ? `<div class="small muted">${sub}</div>` : ''}</div>`;
  // the category table: top folder > level > set; levels fold open
  const kids = new Map();
  [...cats.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).forEach(p => { const i = p.lastIndexOf('/'), par = i < 0 ? '' : p.slice(0, i); if (!kids.has(par)) kids.set(par, []); kids.get(par).push(p); });
  const row = (p, depth) => { const o = cats.get(p), name = p.slice(p.lastIndexOf('/') + 1);
    return `<div class="zh-srow d${depth}"><span class="zh-sname">${esc(name)}</span><span>${o.cards}</span>
      <span class="zh-slearn"><span class="zh-lb"><i style="width:${Math.round(100 * o.learned / o.cards)}%"></i></span>${pct(o.learned, o.cards)}</span>
      <span>${o.here + o.pleco}<span class="muted"> (${o.here} here)</span></span><span>${pct(o.right, o.all)}</span><span>${o.due}</span></div>`; };
  const tree = (p, depth) => { const ch = kids.get(p) || [];
    return ch.length ? `<details class="zh-sgroup" ${depth === 0 ? 'open' : ''}><summary>${row(p, depth)}</summary>${ch.map(x => tree(x, depth + 1)).join('')}</details>` : row(p, depth); };
  main.innerHTML = `<div class="crumbs"><a href="#/zh">← Chinese</a></div><h1>Statistics</h1>
    <div class="zh-tiles">
      ${tile(T.here + T.pleco, 'repetitions', `${T.here} here · ${T.pleco} in Pleco`)}
      ${tile(pct(T.right, T.all), 'right', `${T.right} of ${T.all} answers`)}
      ${tile(T.learned, 'learned', `of ${T.cards} cards (${pct(T.learned, T.cards)})`)}
      ${tile(streak, streak === 1 ? 'day in a row' : 'days in a row', `${rev30} reviews in 30 days`)}
      ${tile(T.due, 'due now', '')}
    </div>
    <div class="zh-grid" style="margin-top:16px">
      <div class="card"><h3 style="margin-top:0">Reviews per day</h3><p class="small muted" style="margin-top:-6px">last 30 days, in StudyHub</p>${zhBars(revRows, 'reviews', 'Reviews per day, last 30 days')}</div>
      <div class="card"><h3 style="margin-top:0">Words learned per day</h3><p class="small muted" style="margin-top:-6px">last 30 days</p>${zhBars(lrnRows, 'learned', 'Words learned per day, last 30 days')}</div>
      <div class="card"><h3 style="margin-top:0">Coming up</h3><p class="small muted" style="margin-top:-6px">reviews due on each of the next 14 days (${T.due} due now)</p>${zhBars(aheadRows, 'due', 'Reviews due on each of the next 14 days')}</div>
    </div>
    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">By category</h3>
      <div class="zh-srow zh-shead small muted"><span>Category</span><span>Cards</span><span>Learned</span><span>Repetitions</span><span>Right</span><span>Due</span></div>
      ${(kids.get('') || []).map(p => tree(p, 0)).join('')}</div>
    ${hard.length ? `<div class="card" style="margin-top:16px"><h3 style="margin-top:0">Hardest words</h3><p class="small muted" style="margin-top:-6px">most often wrong (at least 3 answers, here and in Pleco)</p>
      <div class="zh-misslist">${hard.map(([c, , miss, all]) => `<button class="zh-mrow" data-zh="word" data-w="${esc(c.s)}"><b lang="zh">${esc(zhHead(c))}</b><span class="zh-mpy">${esc(c.py)}</span><span class="zh-mm">${all - miss}/${all} right · ${esc(zhShort(c.def, 1))}</span></button>`).join('')}</div>
      <div class="row" style="margin-top:10px"><button class="btn sm" data-zh="drill-hard">Practise these ${hard.length}</button></div></div>` : ''}`;
}
// exact numbers on hover (mouse) or tap (phone) for anything with data-tip
function zhTip(el) {
  let t = document.getElementById('zh-tip');
  if (!el) { if (t) t.hidden = true; return; }
  if (!t) { t = document.createElement('div'); t.id = 'zh-tip'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = el.dataset.tip; t.hidden = false;
  const r = el.getBoundingClientRect(), w = t.offsetWidth;
  t.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
  t.style.top = Math.max(8, r.top - t.offsetHeight - 6) + 'px';
}
document.addEventListener('pointerover', ev => { const el = ev.target.closest && ev.target.closest('[data-tip]'); zhTip(el || null); });
document.addEventListener('focusin', ev => { const el = ev.target.closest && ev.target.closest('[data-tip]'); if (el) zhTip(el); });
document.addEventListener('scroll', () => zhTip(null), true);

/* ---------- characters I don't understand ---------- */
// flagged from a word (tap the character on a card or in the reader): { t, w = the word it was flagged in }
const zhUnk = ch => { const x = zhP().unk[ch]; return !!(x && !x.del); };
function zhSetUnk(ch, on, word) { zhP().unk[ch] = on ? { t: Date.now(), w: word || '' } : { t: Date.now(), del: true }; saveP(); }
const zhUnkList = () => zhLive(zhP().unk).sort((a, b) => (b[1].t || 0) - (a[1].t || 0));
function zhCharsPage() {
  const list = zhUnkList(), chars = list.map(([ch]) => ch);
  const nWords = ZH.cards.filter(c => chars.some(ch => c.s.includes(ch))).length;
  const row = ([ch, x]) => {
    const info = zhCharInfo(ch), words = zhWordsWith(ch, 6), from = x.w && ZH.bySimp.get(x.w), q = zhP().lq[ch];
    return `<div class="card zh-unk">
      <button class="zh-big" data-zh="char" data-c="${esc(ch)}" data-w="${esc(x.w || '')}" lang="zh">${esc(ch)}</button>
      <div class="zh-unk-body">
        ${info.length ? info.slice(0, 3).map(i => `<div><b class="zh-pyc">${esc(i.py)}</b> ${esc(i.def)}</div>`).join('') : '<div class="muted">No dictionary entry here (it loads through Start StudyHub or on the phone app)</div>'}
        ${from ? `<div class="small muted" style="margin-top:6px">Flagged in <button class="zh-chip" data-zh="word" data-w="${esc(from.s)}"><span lang="zh">${zhMark(from.s, ch)}</span> <span>${esc(zhShort(from.def, 1))}</span></button></div>` : ''}
        ${words.length ? `<div class="small" style="margin-top:6px">${words.filter(c => !from || c.id !== from.id).slice(0, 5).map(c => `<button class="zh-chip" data-zh="word" data-w="${esc(c.s)}"><span lang="zh">${zhMark(c.s, ch)}</span> <span class="muted">${esc(zhShort(c.def, 1))}</span></button>`).join(' ')}</div>` : ''}
        <div class="row small" style="margin-top:8px"><button class="btn sm good" data-zh="unk-off" data-c="${esc(ch)}">✓ Understood</button>
          <button class="btn sm ghost" data-zh="speak" data-w="${esc(ch)}">🔊</button>${q && q.ok + q.bad ? `<span class="muted">test ${q.ok}/${q.ok + q.bad}</span>` : ''}</div>
      </div></div>`;
  };
  main.innerHTML = `<div class="crumbs"><a href="#/zh">← Chinese</a></div><h1>Characters I don't understand</h1>
    <p class="muted small" style="margin-top:-6px">Tap a character of a word (on the back of a card, or in a word in the reader) and choose <b>? Don't understand</b>. They collect here until you mark them understood.</p>
    ${list.length ? `<div class="row" style="margin-bottom:14px">
        <button class="btn primary" data-zh="unk-test" ${chars.some(ch => zhQuizInfo(ch)) ? '' : 'disabled'}>Test me (${list.length})</button>
        <button class="btn" data-zh="unk-words" ${nWords ? '' : 'disabled'}>Practise the ${nWords} word${nWords === 1 ? '' : 's'} with these</button></div>
      ${list.map(row).join('')}` : '<div class="card muted">None yet.</div>'}`;
}
// test: see the character, pick its reading and meaning; wrong options are other characters from your words
function zhQuizChars(chars) {
  const known = chars.filter(ch => zhQuizInfo(ch));
  if (!known.length) { toast('No dictionary meanings here for these characters'); return; }
  const pool = [...new Set(ZH.cards.flatMap(c => [...c.s]).filter(ch => ZH_HAN.test(ch) && !known.includes(ch)))];
  const qs = shuffle(known).map(ch => {
    const others = known.filter(x => x !== ch).concat(shuffle(pool).slice(0, 40)).filter(x => zhQuizInfo(x) && zhQuizInfo(x) !== zhQuizInfo(ch));
    return { kind: 'mean', ch, opts: shuffle([ch, ...shuffle([...new Set(others)]).slice(0, 3)]) };
  });
  ZQ = { qs: qs.slice(0, 20), i: 0, right: 0, wrong: [], pick: null, chars, back: '#/zh/chars' };
  go('#/zh/quiz');
}

function viewZh(r) {
  zhInit();
  const sub = r.sub || '';
  document.title = 'StudyHub · Chinese';
  if (sub !== 'read' || !r.arg) ZH.cur = null;
  if (sub === 'play') zhPlay();
  else if (sub === 'compare') zhCompare();
  else if (sub === 'quiz') zhQuiz();
  else if (sub === 'chars') zhCharsPage();
  else if (sub === 'stats') zhStatsPage();
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
  ZH.cards.forEach(c => { const w = zhWeak(c), r = zhRec(c), d = zhDue(c); if (w !== null && w >= ZH_WEAK) weak++; if (r) rev++; if (d !== null && d <= now) due++; if (zhFlagged(c, gc)) fl++; if (zhLearned(c)) learned++; });
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
  if (UI.zhUntil) {
    const u = zhUntilCounts(zhOpts());
    if (zhRefresh(zhOpts())) return u.left ? `${u.left} of ${u.total} learned cards still to answer right today · ${Math.ceil(u.left / zhBatch())} set${Math.ceil(u.left / zhBatch()) === 1 ? '' : 's'} of ${zhBatch()}` : u.total ? `All ${u.total} learned cards answered right today` : 'No cards match';
    if (!u.left) return u.total ? `All ${u.total} learned${u.waiting ? ` · ${u.waiting} waiting for tomorrow` : ''}` : 'No cards match';
    return `${u.left} of ${u.total} still to learn${u.refresh ? ` (${u.refresh} learned, to answer right once)` : ''}${u.waiting ? ` · ${u.waiting} waiting for tomorrow` : ''} · ${Math.ceil(u.left / zhBatch())} set${Math.ceil(u.left / zhBatch()) === 1 ? '' : 's'} of ${zhBatch()}`;
  }
  return `${n} card${n === 1 ? '' : 's'} match${n === 1 ? 'es' : ''}${n ? ` · ${Math.ceil(n / zhBatch())} set${Math.ceil(n / zhBatch()) === 1 ? '' : 's'} of ${zhBatch()}` : ''}`;
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
    ${zhTodayHtml()}
    <div class="small muted" style="margin:-6px 0 16px;line-height:1.6">${st.total} cards · <b>${st.learned} learned</b> · ${st.total - st.learned} not yet · ${st.rev} reviewed here · ${st.weak} weak · ${st.due} due · ${st.fl} flagged</div>
    <div class="zh-grid">
      <div class="card">
        <h3 style="margin-top:0">Flashcard sets</h3>
        <div class="zh-form">
          <label>Cards per set <input type="number" min="1" max="500" value="${zhBatch()}" data-zc="batch" class="zh-in" style="width:80px"></label>
          <label>Cards ${sel('filter', [['all', 'All'], ['learning', 'Not learned yet'], ['learned', 'Learned'], ['weak', 'Weak'], ['due', 'Due for review'], ['new', 'New (never reviewed)'], ['flagged', 'Flagged / look-alikes'], ['unk', "Characters I don't understand"]], o.filter)}</label>
          <label class="zh-weakmin" ${o.filter === 'weak' ? '' : 'hidden'}>Weak from <input type="range" min="0.1" max="0.8" step="0.05" value="${o.weakMin}" data-zc="weakmin"> <span id="zh-wm">${Math.round(o.weakMin * 100)}%</span></label>
          <label>Order ${sel('order', [['weak', 'Weakest first'], ['due', 'Most overdue first'], ['random', 'Random']], o.order)}</label>
          <label>Show ${sel('dir', [['hz', 'Characters → meaning'], ['en', 'Meaning → characters'], ['type', 'Characters → type the pinyin'], ['listen', 'Listen → meaning']], UI.zhDir || 'hz')}</label>
          <label title="Show the word inside one of its example sentences (characters → meaning only)"><input type="checkbox" data-zc="example" ${UI.zhExample ? 'checked' : ''}> Example sentence on the front</label>
          <div class="zh-exgen small muted">Examples use only words you have learned; cards without one show the word alone. <button class="btn sm ghost" data-zh="ex-copy" title="Copies a prompt; paste it into Claude Code, which writes the sentences to content/_chinese/examples">Copy prompt: examples for the next 100 cards</button></div>
          <label title="The set keeps going round; each card leaves when its score reaches the learned line. Learned cards come after the others and leave on a right answer; a miss brings them back in the set and still marks them weak"><input type="checkbox" data-zc="until" ${UI.zhUntil ? 'checked' : ''}> Repeat until learned</label>
          <label title="Good +100, Easy +150, Hard +25 but counts as a miss (never learned), Don't know halves the score. Pleco scores are converted: 1200 in Pleco = the line">Learned at score <input type="number" min="50" step="50" value="${zhLearnAt()}" data-zc="learnat" class="zh-in" style="width:80px"></label>
          <label>Font ${sel('font', Object.entries(ZH_FONTS).map(([k, [t]]) => [k, t]), UI.zhFont || 'sans')} <span lang="zh" class="zh-fontprev">学习汉字</span></label>
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
      <a class="card zh-link" href="#/zh/chars"><h3 style="margin:0">Characters I don't understand</h3><p class="muted small" style="margin:6px 0 0">${zhUnkList().length} character${zhUnkList().length === 1 ? '' : 's'} · tap a character on a card to add it · test yourself</p></a>
      <a class="card zh-link" href="#/zh/stats"><h3 style="margin:0">Statistics</h3><p class="muted small" style="margin:6px 0 0">repetitions, learned and due per set · reviews per day · hardest words</p></a>
      <a class="card zh-link" href="#/zh/read"><h3 style="margin:0">Reader</h3><p class="muted small" style="margin:6px 0 0">${zhTexts().length} text${zhTexts().length === 1 ? '' : 's'} · tap a word for its meaning · new texts from your weak words</p></a>
    </div>
    <details class="card" style="margin-top:16px"><summary style="cursor:pointer;font-weight:700">Update deck from Pleco</summary>
      <p class="small muted">Last import ${ZH.deck.imported ? new Date(ZH.deck.imported).toLocaleString() : '-'}. Importing again replaces the cards; what you reviewed here is kept.</p>
      <div class="row">${zhImportHtml()}</div></details>`;
  zhTreeFix();
}
function zhTodayHtml() {
  const T = zhToday(), D = zhP().days[today()] || {}, days = [];
  for (let k = 13; k >= 0; k--) { const key = dayKey(Date.now() - k * DAY), d = zhP().days[key] || {}; days.push([key, d.rev || 0, d.lrn || 0]); }
  const max = Math.max(10, ...days.map(d => d[1]));
  return `<div class="card zh-today">
    <div class="zh-todayl">
      <h3 style="margin:0">Today</h3>
      <div class="small muted" style="margin:4px 0 10px">${D.rev || 0} reviewed${D.rev ? ` (${D.ok || 0} right)` : ''} · ${D.nw || 0} new · ${D.lrn || 0} learned${(UI.zhCats || []).length ? ' · ticked categories only' : ''}</div>
      <button class="btn primary" data-zh="today" ${T.cards.length ? '' : 'disabled'}>${T.cards.length ? `Start: ${T.rev} review${T.rev === 1 ? '' : 's'} + ${T.fresh} new` : 'Nothing due - done for today'}</button>
      ${T.due > T.rev ? `<div class="small muted" style="margin-top:6px">${T.due - T.rev} more due (over today's maximum)</div>` : ''}
    </div>
    ${days.some(d => d[1]) ? `<div class="zh-strip" title="Reviews per day, last 14 days">${days.map(([k, n, l]) => `<i title="${k}: ${n} reviewed, ${l} learned" style="height:${Math.max(2, Math.round(44 * n / max))}px" class="${k === today() ? 'now' : ''}"></i>`).join('')}</div>` : ''}
    <details class="zh-todayset"><summary class="small muted">Daily limits</summary>
      <label class="small">New words per day <input type="number" min="0" max="200" value="${zhNewPerDay()}" data-zc="newday" class="zh-in" style="width:70px"></label>
      <label class="small">Max reviews per day <input type="number" min="10" max="1000" value="${zhMaxRev()}" data-zc="maxrev" class="zh-in" style="width:80px"></label></details>
  </div>`;
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
      <div class="small">${esc(i[0] ? i[0].def : '')}</div>${(() => { const q = zhP().lq[ch]; return q && q.ok + q.bad ? `<div class="small muted">quiz ${q.ok}/${q.ok + q.bad}</div>` : ''; })()}
      <div class="zh-ex">${ex.map(c => `<button class="zh-chip" data-zh="word" data-w="${esc(c.s)}" lang="zh">${zhMark(c.s, ch)}</button>`).join('')}</div>
      <button class="btn sm ghost" data-zh="group-rm" data-g="${gid}" data-c="${esc(ch)}" title="Remove from this group">Remove</button></div>`;
  };
  const drillN = g => ZH.cards.filter(c => g.chars.some(ch => c.s.includes(ch))).length;
  main.innerHTML = `<div class="crumbs"><a href="#/zh">← Chinese</a></div><h1>Look-alikes</h1>
    <p class="muted small" style="margin-top:-6px">Flag characters you mix up (tap one on a card or in the reader), then group the ones that look alike to see them side by side.</p>
    ${groups.filter(([, g]) => g.chars.length > 1).length > 1 ? `<div class="row" style="margin-bottom:12px"><button class="btn primary" data-zh="quiz-all">Quiz all groups</button></div>` : ''}
    ${groups.length ? groups.map(([gid, g]) => `<div class="card zh-group">
      <div class="zh-cmp">${g.chars.map(ch => col(gid, ch)).join('')}</div>
      <div class="row" style="margin-top:12px">
        <span class="zh-inline"><input class="zh-in" data-zg="${gid}" lang="zh" placeholder="add a character" aria-label="Add a character to this group" style="width:140px"><button class="btn sm" data-zh="group-addin" data-g="${gid}">Add</button></span>
        <button class="btn sm" data-zh="drill-group" data-g="${gid}" ${drillN(g) ? '' : 'disabled'}>Drill ${drillN(g)} word${drillN(g) === 1 ? '' : 's'}</button>
        <button class="btn sm primary" data-zh="quiz-group" data-g="${gid}">Quiz</button>
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
function zhAdoptTexts() {
  if (window.STUDYHUB_STATIC) return;
  const z = zhP(); let n = 0;
  for (const t of ZH.fileTexts) if (t && t.id && Array.isArray(t.paragraphs) && !z.texts[t.id]) { z.texts[t.id] = Object.assign({}, t, { t: Date.now() }); n++; }
  if (n) saveP();
}
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
          <label>Words <select data-zc="gen-source">${opt('weak', 'My weakest words')}${opt('weakcats', 'Weakest in the ticked categories')}${opt('flagged', 'Flagged words and characters')}${opt('unk', "Words with characters I don't understand")}${groups.map(([gid, x]) => opt('g:' + gid, 'Look-alikes ' + esc(x.chars.join(' ')))).join('')}</select></label>
          <label>How many <input type="number" min="3" max="60" value="${g.n}" data-zc="gen-n" class="zh-in" style="width:70px"></label>
          <label>Length <select data-zc="gen-len">${[['short', 'Short (~150 characters)'], ['medium', 'Medium (~350)'], ['long', 'Long (~700)'], ['xlong', 'Very long (~1,200)'], ['xxlong', 'Extra long (~2,000)'], ['huge', 'Huge (~3,000)']].map(([v, t]) => `<option value="${v}" ${g.len === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
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
// The words a new text should practise: a random draw from the weak words, the weaker the likelier (weight = weakness²),
// leaving out words that were targets in the last 5 texts while there are enough others - so each text brings new ones.
const ZH_LENS = { short: 150, medium: 350, long: 700, xlong: 1200, xxlong: 2000, huge: 3000 };
function zhDraw(cands, n) {
  const recent = new Set(zhTexts().slice(0, 5).flatMap(t => t.targets || []));
  let pool = cands.map(c => [c, zhWeak(c)]).filter(([, w]) => w !== null && w >= 0.2);
  if (pool.length < n) pool = cands.map(c => [c, zhWeak(c) ?? 0.3]);               // few weak words: take the others too
  const fresh = pool.filter(([c]) => !recent.has(c.s));
  if (fresh.length >= n) pool = fresh;
  pool = pool.sort((a, b) => b[1] - a[1]).slice(0, Math.max(n * 8, 80));           // the weakest few hundred at most
  const out = [];
  while (out.length < n && pool.length) {
    const total = pool.reduce((t, [, w]) => t + w * w + 0.01, 0);
    let r = Math.random() * total, k = 0;
    for (; k < pool.length - 1; k++) { r -= pool[k][1] * pool[k][1] + 0.01; if (r <= 0) break; }
    out.push(pool.splice(k, 1)[0][0]);
  }
  return out;
}
function zhTargets(g) {
  const n = Math.max(3, Math.min(60, +g.n || 12));
  if (g.source.startsWith('g:')) {
    const grp = zhP().groups[g.source.slice(2)]; if (!grp || grp.del) return { words: [], chars: [] };
    return { words: zhDraw(ZH.cards.filter(c => grp.chars.some(ch => c.s.includes(ch))), n), chars: grp.chars };
  }
  if (g.source === 'flagged') { const gc = zhGroupChars(); return { words: zhDraw(ZH.cards.filter(c => zhFlagged(c, gc)), n), chars: zhLive(zhP().hard).map(([ch]) => ch) }; }
  if (g.source === 'unk') { const u = zhUnkList().map(([ch]) => ch); return { words: zhDraw(ZH.cards.filter(c => u.some(ch => c.s.includes(ch))), n), chars: [] }; }
  const cs = g.source === 'weakcats' ? ZH.cards.filter(c => zhMatches(c, { cats: UI.zhCats || [], filter: 'all' })) : ZH.cards;
  return { words: zhDraw(cs, n), chars: [] };
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
  const len = ZH_LENS[g.len] || 350, big = len >= 1000;
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

Length: about ${len} Chinese characters (count them; do not stop much shorter), in short paragraphs of 60-120 characters${big ? ', as a story with several scenes so it stays interesting' : ''}. Kind: ${kind}. Topic: ${g.topic.trim() || 'your choice, everyday life'}.
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

${big ? 'The glossary must list every word in the text that is NOT in my "Words I know" list, split into words the way a dictionary would (names too, no punctuation); words I know may be left out to keep the file small.' : 'The glossary must list every word in the text, split into words the way a dictionary would (single-character words and names too, no punctuation).'} Before saving, check that every target word appears in the text and that the file parses as JSON. Then reply with one line.`;
  return { id, prompt: p };
}
// cards coming up (today's set, then the ones due within a week) that have no example where you know every other word
function zhExNeed(n) {
  const now = Date.now(), seen = new Set(), out = [];
  const add = c => { if (!seen.has(c.id) && out.length < n) { seen.add(c.id); const b = zhBestExample(c); if (!b || b.unk.length) out.push(c); } };
  zhToday().cards.forEach(add);
  ZH.cards.map(c => [c, zhDue(c)]).filter(([, d]) => d !== null && d < now + 7 * DAY).sort((a, b) => a[1] - b[1]).forEach(([c]) => add(c));
  return out;
}
function zhExPrompt(n = 100) {
  const cards = zhExNeed(n); if (!cards.length) return null;
  const d = new Date(), pad = x => String(x).padStart(2, '0');
  const id = `ex-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const dir = (ZH.textsDir || '<StudyHub folder>/content/_chinese/texts').replace(/texts\/?$/, 'examples');
  const p = `Write Chinese example sentences for my flashcards and save them as a JSON file. Do not ask questions; just write the file.

For each card below write 2 short, natural sentences (8-20 characters each) that use the card's word in its most common meaning. Every other word in a sentence must be from my "Words I know" list (or be a very basic grammar word like 的, 了, 是, 不, 很, 在, 我, 你, 他). No names, no rare words. Simplified characters, ending with 。！ or ？

Cards (id, word, pinyin, meaning):
${cards.map(c => `${c.id}\t${c.s}\t${c.py}\t${zhShort(c.def, 2)}`).join('\n')}

Words I know: ${[...zhKnown()].join(' ')}

Save exactly this JSON shape (UTF-8, valid JSON, the ids exactly as given) to this file:
${dir}/${id}.json

{ "examples": { "<card id>": [ { "zh": "sentence", "py": "pinyin with tone marks, words separated by spaces", "en": "natural English translation" } ] } }

Before saving, check that each sentence contains its card's word and that the file parses as JSON. Then reply with one line.`;
  return { id, prompt: p, n: cards.length };
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
function zhSpeak(text, auto) {
  const ss = window.speechSynthesis; if (!ss) { if (!auto) toast('This browser cannot read aloud'); return; }
  const vs = ss.getVoices(), v = vs.find(x => /^zh[-_](CN|Hans)/i.test(x.lang)) || vs.find(x => /^(zh|cmn)/i.test(x.lang));
  if (!v) { toast(auto ? 'No Chinese voice on this device, so Listen mode cannot play - add one in the system speech settings' : 'No Chinese voice on this device - add one in the system speech settings'); return; }
  ss.cancel(); const u = new SpeechSynthesisUtterance(text); u.voice = v; u.lang = v.lang; u.rate = 0.85; ss.speak(u);
}
if (window.speechSynthesis) try { speechSynthesis.getVoices(); } catch (e) { /* voices load later */ }

/* ---------- events (own listeners: nothing here goes through the course handlers) ---------- */
function zhRedraw() { const y = scrollY; viewZh(parseRoute()); window.scrollTo(0, y); }
/* Words in the reader are plain text (spans): phones send no click for a tap on plain text, so a short tap (finger down
   and up in the same place) is handled here, and the click that may follow it is ignored. Works with a mouse too. */
let zhTap = null, zhTapEl = null, zhTapAt = 0;
document.addEventListener('pointerdown', ev => { const el = ev.isPrimary && ev.target.closest && ev.target.closest('span[data-zh]'); zhTap = el ? { x: ev.clientX, y: ev.clientY, t: Date.now(), el } : null; }, true);
document.addEventListener('pointerup', ev => {
  const s = zhTap; zhTap = null;
  if (!s || Math.hypot(ev.clientX - s.x, ev.clientY - s.y) > 10 || Date.now() - s.t > 600) return;
  const el = ev.target.closest && ev.target.closest('span[data-zh]');
  if (el !== s.el) return;
  zhTapEl = el; zhTapAt = Date.now(); zhAct(el, ev);
}, true);
document.addEventListener('click', ev => {
  const el = ev.target.closest && ev.target.closest('[data-zh]');
  if (!el) return;
  if (el === zhTapEl && Date.now() - zhTapAt < 700) return;      // already handled as a tap
  zhAct(el, ev);
});
function zhAct(el, ev) {
  const a = el.dataset.zh, d = el.dataset;
  switch (a) {
    case 'flip': if (typeof tapFlipAt === 'undefined' || Date.now() - tapFlipAt > 700) zhFlip(); break;   // a tap already flipped it
    case 'rate': zhRateCur(+d.l); break;
    case 'start': zhStart(zhOpts()); break;
    case 'next-set': zhNext(); break;
    case 'undo': zhUndo(); break;
    case 'drill-hard': zhStart({ ids: zhStatsData().hard.map(([c]) => c.id), order: 'keep', title: 'Hardest words' }); break;
    case 'type-check': zhTypeCheck(); break;
    case 'today': { const T = zhToday(); if (!T.cards.length) { toast('Nothing due today'); break; } zhStart({ ids: T.cards.map(c => c.id), order: 'keep', title: 'Today', today: true }); break; }
    case 'quiz-group': zhQuizStart([d.g]); break;
    case 'quiz-all': zhQuizStart(zhLive(zhP().groups).map(([gid]) => gid)); break;
    case 'quiz-again': if (ZQ && ZQ.chars) zhQuizChars(ZQ.chars); else zhQuizStart(ZQ ? ZQ.gids : []); break;
    case 'unk-toggle': { const on = !zhUnk(d.c); zhSetUnk(d.c, on, ZH.sheetWord); $$(`.zh-ch[data-c="${CSS.escape(d.c)}"]`).forEach(b => b.classList.toggle('unk', on));
      toast(on ? `${d.c} added to Characters I don't understand` : `${d.c} marked as understood`); zhCharSheet(d.c); if (/#\/zh\/chars/.test(location.hash)) zhRedraw(); break; }
    case 'unk-off': zhSetUnk(d.c, false); toast(`${d.c} marked as understood`); zhRedraw(); break;
    case 'unk-test': zhQuizChars(zhUnkList().map(([ch]) => ch)); break;
    case 'unk-words': { const cs = zhUnkList().map(([ch]) => ch); zhStart({ ids: ZH.cards.filter(c => cs.some(ch => c.s.includes(ch))).map(c => c.id), order: 'weak', title: 'Characters I don\'t understand' }); break; }
    case 'quiz-pick': zhQuizPick(d.c); break;
    case 'quiz-next': ZQ.i++; ZQ.pick = null; zhQuiz(); window.scrollTo(0, 0); break;
    case 'redo-missed': zhStart({ ids: ZS.missed.slice(), order: 'random', title: 'missed', from: ZS.o.from || { o: ZS.o, seen: ZS.seen, setNo: ZS.setNo } }); break;
    case 'cats-clear': UI.zhCats = []; saveUI(); zhTreeRedraw(); break;
    case 'cat-up': { const add = zhCatUp(d.p, zhCatData().kids), covered = x => add.some(a => x === a || x.startsWith(a + '/'));
      UI.zhCats = (UI.zhCats || []).filter(x => !covered(x)).concat(add); ZH.lastTick = null; saveUI(); zhTreeRedraw(); toast(`Ticked ${zhCatName(d.p)} and up (${add.length} folders)`); break; }
    case 'cat-open': { const o = zhCatOpen(zhCatData().kids); o.has(d.p) ? o.delete(d.p) : o.add(d.p); UI.zhOpen = [...o]; saveUI(); zhTreeRedraw(); break; }
    case 'char': ev.stopPropagation(); if (zhSheetIs('c:' + d.c, el)) zhSheetClose(); else { zhCharSheet(d.c, el, d.w); zhSheetMark('c:' + d.c, el); } break;
    case 'word': if (zhSheetIs('w:' + d.w, el)) zhSheetClose(); else { zhWordSheet(d.w, el); zhSheetMark('w:' + d.w, el); } break;
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
    case 'ex-copy': { const b = zhExPrompt(100); if (!b) { toast('Every card coming up already has an example at your level'); break; }
      zhCopy(b.prompt).then(ok => toast(ok ? `Prompt for ${b.n} cards copied - paste it into Claude Code` : 'Could not copy the prompt')); break; }
    case 'gen-copy': { const b = zhBuildPrompt(); if (!b) { toast('No words to practise yet - review some cards or flag some first'); break; }
      ZH.prompt = b.prompt; const ta = $('#zh-prompt'); if (ta) { ta.value = b.prompt; ta.hidden = false; }
      zhCopy(b.prompt).then(ok => { toast(ok ? 'Prompt copied - paste it into Claude Code' : 'Select the prompt below and copy it'); });
      zhWatch(b.id); const st = $('#zh-gen-status'); if (st) st.textContent = zhServed() ? 'Waiting for Claude Code to write the text… it opens here by itself.' : 'When Claude Code is done, run python3 build.py and reload.'; break; }
    case 'paste-open': zhPasteOpen(); break;
  }
}
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
    case 'example': UI.zhExample = el.checked; break;
    case 'newday': UI.zhNewPerDay = Math.max(0, Math.min(200, Math.round(+el.value || 0))); saveUI(); zhRedraw(); return;
    case 'maxrev': UI.zhMaxRev = Math.max(10, Math.min(1000, Math.round(+el.value || 150))); saveUI(); zhRedraw(); return;
    case 'learnat': UI.zhLearnAt = Math.max(50, Math.round(+el.value || 300)); el.value = UI.zhLearnAt; saveUI(); zhRedraw(); return;
    case 'font': UI.zhFont = el.value; zhFontApply(); break;
    case 'trad': UI.zhScript = el.checked ? 'trad' : 'simp'; break;
    case 'cat': { const v = el.value; let sel = (UI.zhCats || []).filter(x => x !== v);
      ZH.lastTick = el.checked ? v : null;          // only the folder just ticked offers "and up"
      if (el.checked) sel = sel.filter(x => !x.startsWith(v + '/')).concat(v);      // a ticked folder already covers what is inside it
      UI.zhCats = sel; saveUI(); zhTreeRedraw(); return; }
    case 'ruby': UI.zhRuby = el.checked; saveUI(); zhRedraw(); return;
    case 'showen': UI.zhShowEn = el.checked; saveUI(); zhRedraw(); return;
    case 'import': zhImport(el.files[0]); return;
    case 'gen-source': gen('source', el.value); return;
    case 'gen-n': gen('n', Math.max(3, Math.min(60, +el.value || 12))); return;
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
  if (ev.key === 'Enter' && ev.target.id === 'zh-type') { ev.preventDefault(); zhTypeCheck(); return; }
  if (ZQ && /^#\/zh\/quiz/.test(location.hash) && ev.key === 'Enter' && ZQ.pick !== null) { ev.preventDefault(); ZQ.i++; ZQ.pick = null; zhQuiz(); return; }
  if (ev.key === 'Enter' && ev.target.id === 'zh-gnew') { const b = $('#zh-sheet [data-zh="group-new"]'); if (b) b.click(); return; }
  if (ev.key === 'Enter' && ev.target.dataset && ev.target.dataset.zg) { const b = $(`[data-zh="group-addin"][data-g="${ev.target.dataset.zg}"]`); if (b) b.click(); return; }
  if (!ZS || !/^#\/zh\/play/.test(location.hash)) return;
  const tag = (ev.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const undoKey = ev.key === 'ArrowLeft' || ev.key.toLowerCase() === 'u';
  if (ZS.i >= ZS.ids.length) { if (ev.key === 'Enter') { ev.preventDefault(); zhNext(); } else if (undoKey && zhCanUndo()) { ev.preventDefault(); zhUndo(); } return; }
  if (ev.key === 'Enter' && ZS.flipped && ZS.typed) { ev.preventDefault(); zhRateCur(ZS.typed.sug); }    // typed: Enter takes the suggested rating
  else if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); zhFlip(); }
  else if (ZS.flipped && /^[1-4]$/.test(ev.key)) { ev.preventDefault(); zhRateCur(+ev.key - 1); }
  else if (undoKey && zhCanUndo()) { ev.preventDefault(); zhUndo(); }
  else if (ev.key.toLowerCase() === 's') { const c = ZH.byId.get(ZS.ids[ZS.i]); if (c) zhSpeak(c.s); }
});
window.addEventListener('hashchange', () => zhSheetClose());
// on the Mac: pick up new reading texts soon after StudyHub opens, so they sync to the phone without visiting the Reader
window.addEventListener('load', () => setTimeout(() => { if (zhServed() && !window.STUDYHUB_STATIC) { zhInit(); zhLoad(); } }, 4000));

/* ---------- styles ---------- */
(() => {
  const s = document.createElement('style'); s.id = 'zh-css';
  s.textContent = `
[lang=zh],.zh-hw,.zh-sbig,.zh-big,.zh-ch{font-family:var(--zhfont,"PingFang SC","Hiragino Sans GB","Noto Sans SC","Microsoft YaHei",sans-serif)}
.zh-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
.zh-form{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center}.zh-form label{display:inline-flex;gap:6px;align-items:center}.zh-form [hidden]{display:none}.zh-form label{max-width:100%;flex-wrap:wrap}.zh-form select{max-width:100%;min-width:0;background-color:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:6px 8px}
.zh-in{border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:8px;padding:6px 8px;font:inherit}
.zh-tree{max-height:440px;overflow:auto;margin-top:8px}.zh-cat{display:flex;align-items:center;gap:6px;padding:3px 0}
.zh-tw{width:24px;height:24px;flex:none;border:0;background:none;color:var(--text);cursor:pointer;padding:0;font-size:1rem;border-radius:6px}.zh-tw:hover{background:var(--surface2)}
.zh-cn{border:0;background:none;color:inherit;font:inherit;cursor:pointer;padding:0;text-align:left}button.zh-cn{font-weight:600}.zh-cat.inh .zh-cn{color:var(--muted)}
.zh-up{border:1px solid var(--border);background:var(--surface);color:var(--muted);font:inherit;font-size:.72rem;border-radius:999px;padding:1px 7px;cursor:pointer;margin-left:6px;}
.zh-up:hover{color:var(--accent);border-color:var(--accent)}
.zh-lb{flex:0 0 46px;height:5px;border-radius:3px;background:var(--border);overflow:hidden;margin-left:auto}.zh-lb i{display:block;height:100%;background:var(--good)}.zh-lbn{flex:0 0 34px;text-align:right}
.zh-tick b{color:var(--text)}.zh-fontprev{font-size:1.15rem;margin-left:6px}

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
.zh-ch.unk{text-decoration:underline dotted var(--accent) 2px;text-underline-offset:6px}
.zh-unk{display:flex;gap:18px;align-items:flex-start;margin-bottom:12px}.zh-unk .zh-big{flex:none;font-size:clamp(3.2rem,12vw,4.6rem)}.zh-unk-body{flex:1;min-width:0}.zh-pyc{color:var(--accent)}
.zh-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.zh-tile{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px}.zh-tile-n{font-size:1.8rem;font-weight:700;line-height:1.1}
.zh-chart{margin:0;position:relative}.zh-chart-max{position:absolute;top:-2px;left:0}
.zh-bars{display:grid;grid-template-columns:repeat(var(--n),1fr);gap:2px;height:120px;align-items:end;border-bottom:1px solid var(--border);padding-top:16px}
.zh-bar{height:100%;display:flex;align-items:flex-end;cursor:default;outline:none}.zh-bar i{display:block;width:100%;background:var(--accent);border-radius:4px 4px 0 0;opacity:.85}
.zh-bar.now i{opacity:1}.zh-bar:hover i,.zh-bar:focus i{opacity:1;box-shadow:0 0 0 2px var(--surface),0 0 0 3px var(--accent)}
.zh-chart-x{display:flex;justify-content:space-between;margin-top:4px}
.zh-chart-table summary{cursor:pointer;margin-top:6px}.zh-chart-table table{border-collapse:collapse;margin-top:4px}.zh-chart-table td{padding:2px 12px 2px 0}
#zh-tip{position:fixed;z-index:90;background:var(--text);color:var(--bg);font-size:.8rem;padding:4px 8px;border-radius:6px;pointer-events:none;white-space:nowrap}#zh-tip[hidden]{display:none}
.zh-srow{display:grid;grid-template-columns:minmax(0,2fr) 60px minmax(110px,1.2fr) minmax(0,1.3fr) 60px 50px;gap:10px;align-items:center;padding:6px 0;border-top:1px solid var(--border);font-size:.9rem}
.zh-shead{border-top:0}.zh-srow.d1 .zh-sname{padding-left:18px}.zh-srow.d2 .zh-sname{padding-left:36px}.zh-srow.d0{font-weight:700}
.zh-sgroup>summary{list-style:none;cursor:pointer}.zh-sgroup>summary::-webkit-details-marker{display:none}
.zh-sgroup>summary .zh-sname::before{content:'▸ ';color:var(--muted)}.zh-sgroup[open]>summary .zh-sname::before{content:'▾ '}
.zh-slearn{display:flex;gap:8px;align-items:center}.zh-slearn .zh-lb{margin:0;flex:1 1 40px}
@media (max-width:640px){.zh-srow{grid-template-columns:minmax(0,1.6fr) minmax(80px,1fr) 44px 40px;font-size:.85rem}.zh-srow>span:nth-child(2),.zh-srow>span:nth-child(4){display:none}}
.zh-today{display:grid;grid-template-columns:1fr auto;gap:10px 20px;align-items:end;margin-bottom:14px}
.zh-strip{display:flex;gap:3px;align-items:flex-end;height:46px}.zh-strip i{width:9px;border-radius:3px 3px 0 0;background:var(--accent-soft)}.zh-strip i.now{background:var(--accent)}
.zh-todayset{grid-column:1/-1}.zh-todayset label{display:inline-flex;gap:6px;align-items:center;margin:6px 14px 0 0}
.zh-typein{display:block;margin:14px auto 0;width:min(320px,90%);font-size:18px;text-align:center}
.zh-typed{text-align:center;font-weight:600;padding:8px 10px;border-radius:10px;margin-bottom:10px}.zh-typed.ok{background:var(--good-soft);color:var(--good)}.zh-typed.tone{background:color-mix(in srgb,var(--warn) 15%,transparent);color:var(--warn)}.zh-typed.bad{background:var(--bad-soft);color:var(--bad)}
.rate .btn.zh-sug{outline:3px solid var(--text);outline-offset:2px}
.zh-listen{font-size:1.2rem;padding:16px 26px}
.zh-exfront{font-size:clamp(1.4rem,5vw,2rem);line-height:1.6}.zh-exfront mark{background:var(--accent-soft);color:inherit;border-radius:4px;padding:0 2px}
.zh-quiz .zh-big{font-size:clamp(4rem,14vw,6rem)}.zh-quizw{font-size:clamp(2.4rem,9vw,3.6rem)}.zh-gap{color:var(--accent);padding:0 4px}
.zh-qopts{display:grid;gap:10px;margin:18px auto 10px;max-width:520px}.zh-qopts.pick{grid-template-columns:repeat(auto-fit,minmax(90px,1fr))}
.zh-qopt{flex-direction:column;justify-content:center;padding:12px}.zh-qbig{font-size:2.4rem;line-height:1.1}
@media (max-width:600px){.zh-today{grid-template-columns:1fr}.zh-strip{order:3}}
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
.zh-exbox{margin:14px 0 4px;padding:10px 12px;border-radius:10px;background:var(--accent-soft)}.zh-exbox .zh-exz{font-size:1.25em}.zh-exnote{font-weight:400;text-transform:none;letter-spacing:0;opacity:.75;margin-left:6px}
.zh-exz mark{background:var(--accent-soft);color:var(--accent);border-radius:3px;padding:0 1px}.zh-exbox mark{background:transparent;font-weight:700}
.zh-unkw{text-decoration:underline dotted;text-decoration-thickness:2px;text-underline-offset:4px;text-decoration-color:var(--warn,#c80)}
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
.zw.zh-on,.zh-ch.zh-on{outline:2px solid var(--accent);outline-offset:1px;border-radius:4px}
.zh-en{display:none;font-size:.95rem;line-height:1.5;color:var(--muted);margin-top:4px!important}.zh-en.on{display:block}.zh-enb{font-size:.75rem}
.zh-read{max-width:860px}.zh-bad{color:var(--bad)}.zh-weak{color:var(--bad)}.zh-tgtp{background:var(--accent-soft)}
.zh-prompt{width:100%;min-height:150px;margin-top:10px;font-family:var(--mono);font-size:.78rem}
.zh-texts{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
@media (max-width:600px){.zh-text{font-size:1.3rem}.zh-sheet{max-height:62vh}}`;
  document.head.appendChild(s);
})();
