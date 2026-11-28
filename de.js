/* ===================================================================
   StudyHub German: the Goethe word lists (A1, A2, B1) and a B2 frequency list (DeReWo) as flashcards in sets, built like the Chinese module:
   Today (due reviews + new words), set builder with the Level > Set tree, repeat until learned, an article drill
   (der/die/das), type the word, a tap-to-define reader and reading texts from your weak words (the prompt goes to
   Claude Code, which writes the text file). Meanings in Norwegian first, English second.
   Loaded before the main script; everything runs only when called, so it can use the main script's globals
   (P, UI, esc, $, $$, main, go, toast, saveP, saveUI, shuffle, mergeItems, DAY, today, dayKey, bumpDay) and
   zh.js's styles and helpers (zh-* classes, zhBars, zhTip, zhCopy, zhMergeDays).
   Deck: engine/goethe_import.py -> content/_german/deck.json. Texts: content/_german/texts/*.json.
   =================================================================== */
const DE = { deck: null, cards: [], byId: new Map(), forms: new Map(), fileTexts: [], textsDir: '', live: null, liveDone: false, ver: 0,
  cur: null, pending: null, poll: 0, prompt: '', known: null, knownAt: 0 };
const DE_INT = [0, 0.5, 1, 3, 7, 16, 35, 80];        // days until the next review, per box
const DE_WEAK = 0.35;
const LS_DES = 'studyhub.desession.v1';
let DS = null;                                       // running flashcard set
const deServed = () => /^https?:$/.test(location.protocol) && !window.STUDYHUB_STATIC;   // the phone copy has no server behind it

/* ---------- progress (synced, inside P.de) ---------- */
function deP() { const z = P.de = P.de || {}; for (const k of ['cards', 'hardW', 'texts', 'added', 'days']) z[k] = z[k] || {}; return z; }
const deLive = obj => Object.entries(obj || {}).filter(([, v]) => v && !v.del);
// called from mergeP: every map item by item, newest t wins; daily counts take the larger number
function deMerge(a, b) {
  if (!a) return b; if (!b) return a;
  const o = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) o[k] = k === 'days' ? zhMergeDays(a[k], b[k]) : mergeItems(a[k], b[k], x => x.n || 0);
  return o;
}

/* ---------- deck ---------- */
const deBare = s => String(s || '').replace(/\((sich|Pl\.|Sg\.)\)/g, ' ').replace(/^sich /, '').replace(/[()]/g, '').replace(/-$/, '').replace(/\s+/g, ' ').trim();
function deSetDeck(deck) {
  DE.deck = deck && deck.cards ? deck : { categories: [], cards: [] };
  const ids = new Set(DE.deck.cards.map(c => c.id));
  const added = deLive(deP().added).filter(([id]) => !ids.has(id)).map(([id, v]) => ({ id, w: v.w, lemma: v.lemma || v.w, art: v.art, no: v.no || '', en: v.en || '', ex: [], lv: 'Reader', cats: ['From reader'], user: true }));
  DE.cards = DE.deck.cards.concat(added);
  DE.byId = new Map(DE.cards.map(c => [c.id, c]));
  // word forms -> card, for the reader: lemmas first, then plurals, then verb forms (the first card to claim a form keeps it)
  const F = new Map(), put = (f, c) => { f = String(f || '').toLowerCase().trim(); if (f && !F.has(f)) F.set(f, c); };
  DE.cards.forEach(c => { put(deBare(c.lemma), c); deAlts(c).forEach(a => put(deBare(a).replace(/^(der|die|das) /, ''), c)); });
  DE.cards.forEach(c => { if (c.pl) put(c.pl, c); });
  DE.cards.forEach(c => String(c.forms || '').split(/[,/()]/).forEach(p => p.trim().split(/\s+/).filter(t => !/^(hat|ist|sind|es|sich|als|modalverb|jdn\.)$/i.test(t)).forEach(t => put(t, c))));
  DE.forms = F; DE.known = null;
}
function deInit() {
  if (DE.deck) return;
  const B = window.STUDYHUB_DE || {};
  deSetDeck(B.deck); DE.fileTexts = B.texts || [];
  // B2/C1 used to sit in their own "Frequency" folder: keep ticks and open folders from then
  const mv = a => (a || []).map(x => x.replace(/^Frequency(?=\/|$)/, 'Goethe'));
  if ((UI.deCats || []).some(x => /^Frequency/.test(x)) || (UI.deOpen || []).some(x => /^Frequency/.test(x))) { UI.deCats = [...new Set(mv(UI.deCats))]; UI.deOpen = [...new Set(mv(UI.deOpen))]; saveUI(); }
  if (location.protocol === 'file:') DE.textsDir = decodeURIComponent(location.pathname).replace(/\/[^/]*$/, '') + '/content/_german/texts';
}
// when served, read the deck and the texts fresh (a new import, or a text Claude Code just wrote, without a rebuild)
function deLoad(force) {
  if (!deServed() || (DE.live && !force)) return DE.live || Promise.resolve();
  DE.live = Promise.all([
    fetch('content/_german/deck.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch('/de-api/texts', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null)
  ]).then(([deck, tx]) => {
    let changed = false;
    if (deck && deck.imported !== (DE.deck && DE.deck.imported)) { deSetDeck(deck); changed = true; }
    if (tx) { DE.textsDir = tx.dir || DE.textsDir; const ids = t => t.map(x => x.id).join(); if (ids(tx.texts || []) !== ids(DE.fileTexts)) { DE.fileTexts = tx.texts || []; changed = true; } }
    if (changed) DE.ver++;
    DE.liveDone = true;
    return changed;
  });
  return DE.live;
}

/* ---------- how a word is shown ---------- */
const DE_ARTS = { der: 'm', die: 'f', das: 'n' };
const deArtCls = a => DE_ARTS[a] || (a ? 'x' : '');
// "der Arbeiter / die Arbeiterin": each article in its gender colour (blue der, red die, green das)
function deWordHtml(w) {
  return esc(w).replace(/(^|\/ |\/|, )(der|die|das)(?=[ /])/g, (m, pre, a) => `${pre}<span class="de-art ${deArtCls(a)}">${a}</span>`);
}
const deMean = c => c.no || c.en || '';
// the spellings that count as right when typing: "der Arbeiter / die Arbeiterin" -> both; "(sich) freuen" -> with and without sich
function deAlts(c) {
  const out = new Set();
  String(c.w || c.lemma).split(/\s+\/\s+|,\s+(?=(?:der|die|das) )/).forEach(p => {
    p = p.replace(/\((Pl|Sg)\.\)/g, '').replace(/\s+\(.*?\)$/, '').trim();
    if (/\(sich\)|^sich /.test(p)) { out.add(p.replace(/\(sich\)\s*/, '').replace(/^sich /, '').trim()); out.add('sich ' + p.replace(/\(sich\)\s*/, '').replace(/^sich /, '').trim()); }
    else out.add(p);
    if (/\(.*\)/.test(p)) { out.add(p.replace(/[()]/g, '')); out.add(p.replace(/\(.*?\)/g, '').trim()); }
    if (p.includes('/') && !/^(der|die|das)\//.test(p)) p.split('/').forEach(x => out.add(x.trim()));
  });
  return [...out].filter(Boolean);
}
const deNorm = s => String(s || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[.!?,;:"„“]/g, '').replace(/\s+/g, ' ').trim();
// typed answer: right, right word but wrong/missing article, or wrong; and the rating it suggests
function deCheckType(typed, c) {
  if (!typed.trim()) return { ok: false, art: false, sug: 0 };
  const alts = deAlts(c), t = deNorm(typed);
  if (alts.some(a => deNorm(a) === t)) return { ok: true, art: true, sug: 2 };
  const noArt = x => deNorm(x).replace(/^(der|die|das)(\/(der|die|das))? /, '');
  if (c.art && alts.some(a => noArt(a) === noArt(typed))) return { ok: false, art: true, sug: 1 };
  return { ok: false, art: false, sug: 0 };
}
// the card's word marked in a sentence (any form that starts like it: Anfang -> Anfang, Anfänge is not caught)
function deMarkIn(sentence, c) {
  const stem = deBare(c.lemma).split(' ').pop() || '', s = esc(sentence);
  if (stem.length < 3) return s;
  const k = stem.length > 5 ? stem.slice(0, stem.length - 2) : stem;
  try { return s.replace(new RegExp(`(^|[^\\p{L}])(${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\p{L}*)`, 'giu'), '$1<mark>$2</mark>'); } catch (e) { return s; }
}

/* ---------- weakness and scheduling (same scheme as Chinese, without Pleco) ---------- */
function deWeak(c) {
  const r = deP().cards[c.id];
  if (!r || !r.n) return r && r.lkT && Date.now() - r.lkT < 14 * DAY ? 0.5 : null;
  const h = r.h || '', miss = h ? [...h].filter(x => x === '0').length / h.length : 0;
  let w = 0.5 * miss + 0.5 * (1 - Math.min(r.b || 0, 5) / 5);
  if (r.lkT && Date.now() - r.lkT < 14 * DAY) w = Math.min(1, w + 0.15);     // looked up in the reader lately
  return w;
}
const deLearnAt = () => Math.max(50, Math.round(+UI.deLearnAt || 300));
const deScore = c => { const r = deP().cards[c.id]; return r && r.sc != null ? r.sc : 0; };
const deLearned = c => deScore(c) >= deLearnAt();
const deNewScore = (sc, lvl) => lvl === 0 ? Math.max(0, Math.min(Math.floor(sc / 2), deLearnAt() - 100)) : lvl === 1 ? Math.min(sc + 25, deLearnAt() - 50) : sc + [0, 25, 100, 150][lvl];
// a review record, or null (an undone first rating leaves { n: 0 }; "I know these" leaves { known })
function deRec(c) { const r = deP().cards[c.id]; return r && (r.n || r.lk || r.known) ? r : null; }
function deDue(c) { const r = deRec(c); return r ? (r.due || 0) : null; }      // null = new
const deTomorrow = () => { const d = new Date(); d.setHours(24, 0, 0, 0); return d.getTime(); };
function deDay() { const d = deP().days, k = today(); return d[k] = d[k] || { rev: 0, ok: 0, nw: 0, lrn: 0 }; }
// 0 don't know, 1 hard, 2 good, 3 easy. Learned only after right answers on two different days.
function deRate(c, lvl, again) {
  const z = deP(), now = Date.now(), day = today(), at = deLearnAt();
  const wasLearned = deLearned(c), isNew = !deRec(c) || (z.cards[c.id] && z.cards[c.id].known && !z.cards[c.id].n);
  const r = Object.assign({ b: 0, n: 0, ok: 0, bad: 0, h: '' }, z.cards[c.id]); delete r.u;
  let sc = deNewScore(deScore(c), lvl);
  if (lvl >= 2 && r.ld !== day) { r.dd = (r.dd || 0) + 1; r.ld = day; }
  r.cap = !wasLearned && sc >= at && (r.dd || 0) < 2 && !r.known;
  if (r.cap) sc = at - 1;
  r.sc = sc;
  if (lvl === 0) { r.b = 1; r.due = now; }
  else if (lvl === 1) { r.b = Math.max(1, Math.min(r.b, 2)); r.due = now + 0.5 * DAY; }
  else if (again) { r.b = Math.max(1, Math.min(r.b, 2)); r.due = now + DAY; }
  else { r.b = Math.min(DE_INT.length - 1, Math.max(1, r.b) + (lvl === 3 ? 2 : 1)); r.due = now + DE_INT[r.b] * DAY; }
  if (r.cap) r.due = Math.min(r.due, deTomorrow());
  r.n++; if (lvl >= 2) r.ok++; else r.bad++;
  r.h = (r.h + (lvl >= 2 ? '1' : '0')).slice(-8); r.t = now;
  z.cards[c.id] = r;
  const D = deDay(); D.rev++; if (lvl >= 2) D.ok++; if (isNew && !r.known) D.nw++; if (!wasLearned && sc >= at) D.lrn++;
  bumpDay(); saveP();
}
// "I know these": cards never reviewed get learned, with a check-up review spread over the next six weeks
function deMarkKnown(cards) {
  const z = deP(), now = Date.now(), at = deLearnAt(); let n = 0;
  cards.forEach(c => { if (deRec(c)) return; z.cards[c.id] = { b: 4, n: 0, ok: 0, bad: 0, h: '', sc: at, known: 1, due: now + (7 + Math.random() * 35) * DAY, t: now }; n++; });
  if (n) saveP();
  return n;
}
// a deck word looked up in the reader: a light miss (score -50, back tomorrow, weaker for two weeks)
function deLookup(c) {
  const z = deP(), r = Object.assign({ b: 0, n: 0, ok: 0, bad: 0, h: '' }, z.cards[c.id]), d = deDue(c);
  r.sc = Math.max(0, deScore(c) - 50); r.lk = (r.lk || 0) + 1; r.lkT = Date.now(); r.t = Date.now();
  r.due = Math.min(d === null ? Infinity : d, deTomorrow());
  z.cards[c.id] = r; saveP();
}
const deFlagged = c => { const x = deP().hardW[c.id]; return !!(x && !x.del); };

/* ---------- choosing cards ---------- */
const deCatsOf = c => c.cats && c.cats.length ? c.cats : ['(No category)'];
const deInCats = (c, sel = UI.deCats || []) => !sel.length || sel.some(p => deCatsOf(c).some(x => x === p || x.startsWith(p + '/')));
const deIsNoun = c => !!DE_ARTS[c.art];
function deMatches(c, o) {
  if (!deInCats(c, o.cats || [])) return false;
  if (o.nouns && !deIsNoun(c)) return false;
  const f = o.filter || 'all';
  if (f === 'weak') { const w = deWeak(c); return w !== null && w >= (o.weakMin == null ? DE_WEAK : o.weakMin); }
  if (f === 'due') { const d = deDue(c); return d !== null && d <= Date.now(); }
  if (f === 'new') return !deRec(c);
  if (f === 'learning') return !deLearned(c);
  if (f === 'learned') return deLearned(c);
  if (f === 'flagged') return deFlagged(c);
  if (f === 'verbs') return c.kind === 'v';
  if (f === 'nouns') return deIsNoun(c);
  return true;
}
function deWaiting(c) { const r = deRec(c); return !!(r && r.cap && r.ld === today() && !deLearned(c)); }
function deRightToday(c) { const r = deRec(c); return !!(r && r.ld === today() && deLearned(c)); }
const deRefresh = o => !!(o.until && o.filter === 'learned');
function deUntilCounts(o) {
  const all = dePool(Object.assign({}, o, { until: false }));
  let learned = 0, waiting = 0, refresh = 0;      // learned = learned and answered right today; refresh = learned, not yet today
  for (const c of all) { if (deLearned(c)) { if (deRightToday(c)) learned++; else refresh++; } else if (deWaiting(c)) waiting++; }
  return { total: all.length, learned, waiting, refresh, left: all.length - learned - waiting };
}
// repeat-until-learned: cards not learned yet go first, then the learned ones to answer right once
const deUntilOrder = cs => cs.filter(c => !deLearned(c)).concat(cs.filter(deLearned));
function dePool(o) {
  let cs = o.ids ? o.ids.map(id => DE.byId.get(id)).filter(Boolean) : DE.cards.filter(c => deMatches(c, o));
  if (o.ids && o.nouns) cs = cs.filter(deIsNoun);
  // repeat-until-learned: only cards still to do today (learned cards until answered right today)
  if (o.until) cs = cs.filter(c => deLearned(c) ? !deRightToday(c) : !deWaiting(c));
  const ord = o.order || 'weak';
  if (ord === 'keep') return cs;
  const fin = o.until ? deUntilOrder : x => x;
  if (ord === 'random') return fin(shuffle(cs));
  if (ord === 'due') { const d = c => { const x = deDue(c); return x === null ? Infinity : x; }; return fin(shuffle(cs).sort((a, b) => d(a) - d(b))); }
  const w = c => { const x = deWeak(c); return x === null ? -1 : x; };
  return fin(shuffle(cs).sort((a, b) => w(b) - w(a)));
}
const deOpts = () => ({ cats: UI.deCats || [], filter: UI.deFilter || 'all', weakMin: UI.deWeakMin == null ? DE_WEAK : UI.deWeakMin, order: UI.deOrder || 'weak', until: !!UI.deUntil, nouns: UI.deDir === 'art' });
const deBatch = () => Math.max(1, Math.min(500, Math.round(+UI.deBatch || 20)));
const deNewPerDay = () => Math.max(0, Math.min(200, Math.round(UI.deNewPerDay == null ? 15 : +UI.deNewPerDay)));
const deMaxRev = () => Math.max(10, Math.min(1000, Math.round(+UI.deMaxRev || 150)));
// Today: due reviews (most overdue for their interval first) up to the daily maximum, with the day's new words mixed in
// (one after every five reviews) in deck order: A1 Set 01 before Set 02 and so on. Uses the ticked categories, if any.
function deToday() {
  const now = Date.now(), D = deP().days[today()] || {};
  const order = new Map(DE.cards.map((c, i) => [c.id, i])), firstCat = c => deCatsOf(c)[1] || deCatsOf(c)[0];
  const due = [];
  for (const c of DE.cards) {
    if (!deInCats(c)) continue;
    const d = deDue(c); if (d === null || d > now) continue;
    const r = deRec(c), iv = Math.max(0.5, DE_INT[r.b || 1] || 1);
    due.push([c, (now - d) / DAY / iv]);
  }
  due.sort((a, b) => b[1] - a[1]);
  const revLeft = Math.max(0, deMaxRev() - Math.max(0, (D.rev || 0) - (D.nw || 0))), newLeft = Math.max(0, deNewPerDay() - (D.nw || 0));
  const fresh = DE.cards.filter(c => deInCats(c) && !deRec(c))
    .sort((a, b) => firstCat(a).localeCompare(firstCat(b), undefined, { numeric: true }) || order.get(a.id) - order.get(b.id)).slice(0, newLeft);
  const rev = due.slice(0, revLeft).map(([c]) => c), out = [];
  let k = 0;
  rev.forEach((c, i) => { out.push(c); if ((i + 1) % 5 === 0 && k < fresh.length) out.push(fresh[k++]); });
  while (k < fresh.length) out.push(fresh[k++]);
  return { cards: out, due: due.length, rev: rev.length, fresh: fresh.length };
}

/* ---------- sets ---------- */
function deStart(o, prev) {
  const pool = dePool(o), seen = new Set(prev && !o.until ? prev.seen : []);
  let rest = pool.filter(c => !seen.has(c.id)), wrapped = false;
  if (!rest.length && pool.length) { rest = pool; seen.clear(); wrapped = true; }
  if (!rest.length) {
    if (o.until) { const u = deUntilCounts(o); toast(u.total ? `All ${u.total} card${u.total === 1 ? '' : 's'} here ${deRefresh(o) ? 'answered right today' : 'learned'}${u.waiting ? ` (${u.waiting} waiting for tomorrow)` : ''}` : 'No cards match these choices'); }
    else toast(o.nouns ? 'No nouns match these choices' : 'No cards match these choices');
    return false;
  }
  const ids = rest.slice(0, deBatch()).map(c => c.id);
  ids.forEach(id => seen.add(id));
  DS = { o, ids, i: 0, flipped: false, good: 0, again: 0, req: [], missed: [], seen: [...seen], setNo: prev ? prev.setNo + 1 : 1, pool: pool.length, wrapped,
    until: !!o.until, total: ids.length, learnedN: 0, capN: 0, rated: [], wasL: ids.filter(id => deLearned(DE.byId.get(id))) };
  deSave(); go('#/de/play'); return true;
}
function deNext() { const f = DS.o.from; if (f) deStart(f.o, { seen: f.seen, setNo: DS.setNo }); else deStart(DS.o, DS); }
function deSave() { try { if (DS) sessionStorage.setItem(LS_DES, JSON.stringify(DS)); else sessionStorage.removeItem(LS_DES); } catch (e) { /* the set just won't survive a reload */ } }
function deRestore() { try { DS = JSON.parse(sessionStorage.getItem(LS_DES) || 'null'); } catch (e) { DS = null; } return !!DS; }
const deDir = () => UI.deDir || 'de';
function deRateHtml() {
  const undo = deCanUndo() ? '<button class="btn ghost" data-de="undo" title="Undo the last rating (← or U)">↶ Undo</button>' : '';
  const sug = DS.flipped && DS.typed ? DS.typed.sug : -1;
  if (DS.flipped) return `<div class="rate">${[['0', "Don't know", 'bad'], ['1', 'Hard', 'warnbtn'], ['2', 'Good', 'primary'], ['3', 'Easy', 'good']].map(([l, t, k]) => `<button class="btn ${k}${+l === sug ? ' zh-sug' : ''}" data-de="rate" data-l="${l}">${t} <span class="kbd" style="background:transparent;color:inherit">${+l + 1}</span></button>`).join('')}</div>`;
  if (deDir() === 'art') return `<div class="rate">${undo}${['der', 'die', 'das'].map((a, i) => `<button class="btn de-artbtn ${deArtCls(a)}" data-de="art" data-a="${a}">${a} <span class="kbd" style="background:transparent;color:inherit">${i + 1}</span></button>`).join('')}</div>`;
  return `<div class="rate">${undo}<button class="btn primary" data-de="${deDir() === 'type' ? 'type-check' : 'flip'}">${deDir() === 'type' ? 'Check' : 'Show answer'}</button></div>`;
}
function deExBox(c, n = 3) {
  const ex = (c.ex || []).slice(0, n);
  if (!ex.length) return '';
  return `<div class="zh-exbox de-exbox"><div class="zh-pos">Example${ex.length > 1 ? 's' : ''} <span class="zh-exnote">${/^(A1|A2|B1)$/.test(c.lv) ? 'Goethe-Institut' : 'written for this deck'}</span></div>${ex.map(e => `<div class="de-ex">${deMarkIn(e, c)} <button class="btn sm ghost" data-de="speak" data-w="${esc(e)}" title="Listen" aria-label="Listen">🔊</button></div>`).join('')}</div>`;
}
function deGrammar(c) {
  const bits = [];
  if (c.pl) bits.push(`<span class="muted">Plural</span> <b>die ${esc(c.pl)}</b>`);
  else if (c.plonly || /\(Pl\.\)/.test(c.w)) bits.push('<span class="muted">only plural</span>');
  else if (deIsNoun(c)) bits.push('<span class="muted">no plural</span>');
  if (c.forms) bits.push(`<span class="muted">Forms</span> <b>${esc(c.forms)}</b>`);
  if (c.reg) bits.push(`<span class="pill">${esc(c.reg.replace(/,/g, ', '))}</span>`);
  if (c.note) bits.push(`<span class="muted">${esc(c.note)}</span>`);
  return bits.length ? `<div class="de-gram">${bits.join(' · ')}</div>` : '';
}
function deBack(c) {
  const r = deRec(c), w = deWeak(c), sc = deScore(c), at = deLearnAt(), T = DS && DS.typed && DS.typed.id === c.id ? DS.typed : null;
  const stats = [r && r.n ? `${r.ok}/${r.n} right` : '', r && r.known && !r.n ? 'marked as known' : '', w === null && !r ? 'new' : w !== null && w >= DE_WEAK ? 'weak' : ''].filter(Boolean).join(' · ');
  const typedBox = T ? `<div class="zh-typed ${T.ok ? 'ok' : T.art ? 'tone' : 'bad'}">${T.ok ? '✓ Right' : T.art ? (T.kind === 'art' ? `✗ It is <b>${esc(c.art)}</b>` : '≈ Right word, wrong or missing article') : '✗ Not quite'}${T.ok || T.kind === 'art' ? '' : ` - you typed <b>${esc(T.v || '(nothing)')}</b>`}</div>` : '';
  const capNote = r && r.cap && !deLearned(c) ? ' · learned after one more right answer on another day' : '';
  return `${typedBox}<div class="zh-ahead">
      <div class="de-hw">${deWordHtml(c.w)}</div>
      ${deGrammar(c)}
      <div class="de-mean"><b>${esc(c.no || '')}</b>${c.en ? `<div class="de-en">${esc(c.en)}</div>` : ''}</div>
      <div class="zh-scoreline small muted"><button class="btn sm ghost" data-de="speak" data-w="${esc(deBare(c.w))}" title="Listen (S)" aria-label="Listen">🔊</button><span class="zh-lb wide"><i style="width:${Math.min(100, Math.round(100 * sc / at))}%"></i></span> ${deLearned(c) ? '<b class="zh-ok">learned</b>' : `score ${sc} / ${at}`}${capNote}${stats ? ' · ' + stats : ''}</div></div>
    ${deExBox(c)}
    <div class="zh-afoot small muted">
      <button class="btn sm ${deFlagged(c) ? 'warnbtn' : 'ghost'}" data-de="flag-word" data-id="${esc(c.id)}" title="Flag this word as hard">⚑ ${deFlagged(c) ? 'Flagged' : 'Flag word'}</button>
      <span>${esc(deCatsOf(c).slice(-1).map(x => x.split('/').slice(-2).join(' › ')).join(', '))}</span></div>`;
}
function dePlay(keep) {
  deInit();
  if (!DS && !deRestore()) { location.hash = '#/de'; return; }
  const s = DS;
  if (s.ids.slice(s.i).some(id => !DE.byId.get(id)) && deServed() && !DE.liveDone) { main.innerHTML = '<p class="muted">Loading your deck…</p>'; deLoad().then(() => { if (/^#\/de\/play/.test(location.hash)) dePlay(); }); return; }
  while (s.i < s.ids.length && !DE.byId.get(s.ids[s.i])) s.ids.splice(s.i, 1);
  if (s.i >= s.ids.length) return deEnd();
  const c = DE.byId.get(s.ids[s.i]), r = deRec(c), dir = deDir();
  const ex = dir === 'de' && UI.deExample && c.ex && c.ex.length ? c.ex[0] : null;
  const front = dir === 'no' ? `<div class="de-mean big"><b>${esc(c.no || c.en)}</b>${c.no && c.en ? `<div class="de-en">${esc(c.en)}</div>` : ''}</div><div class="small muted" style="margin-top:8px">${c.art ? 'Say it with its article' : 'Say the German word'}</div>`
    : dir === 'type' ? `<div class="de-mean big"><b>${esc(c.no || c.en)}</b>${c.no && c.en ? `<div class="de-en">${esc(c.en)}</div>` : ''}</div><input id="de-type" class="zh-in zh-typein" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" lang="de" placeholder="${c.art ? 'der/die/das + word' : 'German word'}" aria-label="Type the German word">`
    : dir === 'listen' ? `<button class="btn primary zh-listen" data-de="speak" data-w="${esc(deBare(c.w))}">🔊 Listen again</button><div class="small muted" style="margin-top:10px">What does it mean?</div>`
    : dir === 'art' ? `<div class="de-hw"><span class="de-art q">___</span> ${esc(deBare(c.lemma))}</div><div class="small muted" style="margin-top:8px">der, die or das? (keys 1-3)</div>`
    : ex ? `<div class="de-exfront">${deMarkIn(ex, c)}</div><div class="small muted" style="margin-top:8px">What does the marked word mean?</div>`
    : `<div class="de-hw">${deWordHtml(c.w)}</div>${UI.deFormsFront ? deGrammar(c) : ''}`;
  main.innerHTML = `<div class="deck-wrap de-play ${s.flipped ? '' : 'front'}">
    <div class="crumbs"><a href="#/de">← Deutsch</a> · Set ${s.setNo}${s.o.title ? ' · ' + esc(s.o.title) : ''}</div>
    <div class="prog-row">${s.until
      ? `<span class="small muted zh-tick"><b>${s.ids.length - s.i}</b> left · <b>${s.learnedN}</b>/${s.total} learned${s.capN ? ` · ${s.capN} for tomorrow` : ''}</span><div class="bar"><i style="width:${Math.round(100 * (s.learnedN + (s.capN || 0)) / s.total)}%"></i></div>`
      : `<span class="small muted">${s.i + 1} / ${s.ids.length}</span><div class="bar"><i style="width:${Math.round(100 * s.i / s.ids.length)}%"></i></div>`}
      <span class="leitner" title="Review box">${[1, 2, 3, 4, 5, 6, 7].map(i => `<i class="${r && i <= r.b ? 'on' : ''}"></i>`).join('')}</span></div>
    <div class="card zh-card ${s.flipped ? 'flipped' : ''}" ${s.flipped || dir === 'art' ? '' : 'data-de="flip" tabindex="0" role="button" aria-label="Show answer"'}>
      ${s.flipped ? deBack(c) : `<div class="zh-front"><span class="zh-lbl">${({ no: 'Meaning', listen: 'Listen', type: 'Type the German', art: 'Article' })[dir] || (ex ? 'In context' : 'Wort')}</span>${front}${dir === 'art' ? '' : '<span class="zh-hint">click or <span class="kbd">Space</span></span>'}</div>`}</div>
    ${deRateHtml()}
    <p class="muted small zh-keys"><span class="kbd">Space</span> flip · <span class="kbd">1</span>–<span class="kbd">4</span> rate · <span class="kbd">S</span> listen · <span class="kbd">←</span> undo. ${s.until ? `A card leaves the set when its score reaches ${deLearnAt()}.` : `"Don't know" brings the card back later in this set.`}</p></div>`;
  if (keep && s.flipped) deToCard(); else window.scrollTo({ top: 0, behavior: 'instant' });
  if (!s.flipped && dir === 'listen' && s.spoken !== s.ids[s.i] + '|' + s.i) { s.spoken = s.ids[s.i] + '|' + s.i; deSpeak(deBare(c.w), true); }
  if (!s.flipped && dir === 'type') { const t = $('#de-type'); if (t) t.focus({ preventScroll: true }); }
}
function deTypeCheck() {
  const c = DS && DE.byId.get(DS.ids[DS.i]); if (!c || DS.flipped) return;
  const v = (($('#de-type') || {}).value || '').trim();
  DS.typed = Object.assign({ id: c.id, v }, deCheckType(v, c));
  DS.flipped = true; deSave(); dePlay(true);
}
function deArtPick(a) {
  const c = DS && DE.byId.get(DS.ids[DS.i]); if (!c || DS.flipped) return;
  const ok = c.art === a;
  DS.typed = { id: c.id, v: a, ok, art: !ok, kind: 'art', sug: ok ? 2 : 0 };
  DS.flipped = true; deSave(); dePlay(true);
}
function deFlip() {
  if (!DS || !$('.de-play')) return;
  if (!DS.flipped && deDir() === 'type') return deTypeCheck();
  if (!DS.flipped && deDir() === 'art') return;
  DS.flipped = !DS.flipped; deSave(); dePlay(true);
}
function deToCard() {
  const el = $('.de-play .zh-card'); if (!el) return;
  const bar = ($('.topbar') && getComputedStyle($('.topbar')).display !== 'none' && !document.body.classList.contains('top-hidden')) ? $('.topbar').offsetHeight : 0;
  window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + scrollY - bar - 70), behavior: 'instant' });
}
const DE_UNDO = 20;
const deCanUndo = () => !!(DS && DS.undos && DS.undos.length);
function deRateCur(l) {
  const s = DS, c = DE.byId.get(s.ids[s.i]); if (!c || !s.flipped) return;
  const z = deP(), stack = s.undos || [];
  const undo = { id: c.id, rec: z.cards[c.id] ? JSON.parse(JSON.stringify(z.cards[c.id])) : null, day: z.days[today()] ? Object.assign({}, z.days[today()]) : null,
    ds: JSON.stringify(Object.assign({}, s, { undos: null })) };
  s.typed = null;
  deRateDo(c, l);
  DS.undos = stack.concat([undo]).slice(-DE_UNDO); DE.known = null; deSave(); dePlay();
}
function deUndo() {
  if (!deCanUndo()) return;
  const stack = DS.undos.slice(), u = stack.pop(), z = deP();
  z.cards[u.id] = Object.assign(u.rec || { n: 0 }, { u: Date.now(), t: Date.now() });
  if (u.day) z.days[today()] = u.day; else delete z.days[today()];
  DS = JSON.parse(u.ds); DS.flipped = true; DS.undos = stack; DS.typed = null;
  saveP(); deSave(); dePlay(true);   // no toast: the card coming back is the feedback (a toast covered the buttons on phones)
}
function deRateDo(c, l) {
  const s = DS;
  if (s.until) {
    const again = s.rated.includes(c.id); deRate(c, l, again); if (!again) s.rated.push(c.id);
    if (l >= 2) s.good++; else { s.again++; if (!s.missed.includes(c.id)) s.missed.push(c.id); }
    s.ids.splice(s.i, 1);
    const r = deRec(c);
    // a card learned before the set leaves on its first right answer, even if a miss on the way left it weak
    if (deLearned(c) || (l >= 2 && (s.wasL || []).includes(c.id))) s.learnedN++; else if (r && r.cap) s.capN++; else s.ids.splice(Math.min(s.ids.length, s.i + 4), 0, c.id);
    s.flipped = false; return;
  }
  const again = s.req.includes(c.id);
  deRate(c, l, again);
  if (l >= 2) s.good++; else { s.again++; if (!s.missed.includes(c.id)) s.missed.push(c.id); }
  if (l === 0 && !again) { s.req.push(c.id); s.ids.splice(Math.min(s.ids.length, s.i + 6), 0, c.id); }
  s.i++; s.flipped = false;
}
function deEnd() {
  if (!DS.ghSynced) { DS.ghSynced = true; deSave(); if (typeof ghSync === 'function') ghSync(); }
  const s = DS, left = Math.max(0, s.pool - s.seen.length);
  const miss = s.missed.map(id => DE.byId.get(id)).filter(Boolean);
  main.innerHTML = `<div class="q-card card zh-end" style="text-align:center">
    <h2>${s.until ? (s.capN ? `${s.learnedN} learned · ${s.capN} for tomorrow` : `All ${s.total} learned`) : s.o.today ? 'Today: set done' : `Set ${s.setNo} done`}</h2>
    <p class="muted">${s.good} right · ${s.again} ${s.until ? 'misses on the way' : 'to revisit'}${s.wrapped ? ' · you had been through every matching card, so this set started over' : ''}</p>
    ${miss.length ? `<details class="zh-missd"><summary>${miss.length} word${miss.length === 1 ? '' : 's'} you missed</summary><div class="zh-misslist">${miss.map(c => `<button class="zh-mrow" data-de="card" data-id="${esc(c.id)}"><b>${deWordHtml(c.w)}</b><span class="zh-mpy">${esc(c.pl ? 'pl. ' + c.pl : '')}</span><span class="zh-mm">${esc(deMean(c))}</span></button>`).join('')}</div></details>` : ''}
    <div class="row" style="justify-content:center;margin-top:14px">
      ${deCanUndo() ? '<button class="btn ghost" data-de="undo">↶ Undo last rating <span class="kbd" style="background:transparent;color:inherit">←</span></button>' : ''}
      <button class="btn primary" data-de="next-set">Next set of ${deBatch()} <span class="kbd" style="background:transparent;color:inherit">Enter</span></button>
      ${miss.length ? `<button class="btn" data-de="redo-missed">Again: the ${miss.length} I missed</button>` : ''}
      <a class="btn ghost" href="#/de">Back</a></div>
    <p class="small muted" style="margin-top:10px">${s.o.today ? (() => { const t = deToday(); return t.cards.length ? `${t.rev} review${t.rev === 1 ? '' : 's'} and ${t.fresh} new word${t.fresh === 1 ? '' : 's'} left for today.` : 'Nothing more for today.'; })()
      : left ? `${left} matching card${left === 1 ? '' : 's'} not yet in this run.` : 'Every matching card has been in a set; the next set starts over.'}</p></div>`;
}

/* ---------- bottom sheet (a word's details) ---------- */
function deSheet(html, anchor) {
  let el = document.getElementById('de-sheet');
  if (!el) { el = document.createElement('div'); el.id = 'de-sheet'; el.className = 'zh-sheet'; el.setAttribute('role', 'dialog'); document.body.appendChild(el); }
  el.innerHTML = `<button class="btn sm ghost zh-x" data-de="sheet-close" aria-label="Close">✕</button><div class="zh-sheet-in">${html}</div>`;
  el.hidden = false; document.body.classList.add('zh-sheet-open');
  if (anchor && anchor.getBoundingClientRect) { const b = anchor.getBoundingClientRect().bottom, lim = innerHeight - el.offsetHeight - 12; if (b > lim) window.scrollBy({ top: b - lim, behavior: 'smooth' }); }
}
function deSheetClose() { const el = document.getElementById('de-sheet'); if (el) el.hidden = true; document.body.classList.remove('zh-sheet-open'); $$('.de-on').forEach(x => x.classList.remove('de-on')); DE.sheetEl = null; }
// a word in a text -> { card, gloss }: the text's glossary first (it knows the lemma), then the deck's word forms,
// then common endings taken off (schönen -> schön, macht -> machen)
function deFind(form) {
  const g = DE.cur && DE.cur.glossary || {}, low = form.toLowerCase();
  const gl = g[form] || g[low] || g[form.charAt(0).toUpperCase() + form.slice(1)] || null;
  const byLemma = l => l ? DE.forms.get(deBare(l).toLowerCase().replace(/^(der|die|das) /, '')) : null;
  let c = gl && (gl.id && DE.byId.get(gl.id) || byLemma(gl.lemma)) || DE.forms.get(low);
  if (!c) for (const e of ['en', 'er', 'es', 'em', 'e', 'n', 's', 'st', 'et', 't', 'te', 'ten', 'test']) {
    if (low.length - e.length < 3 || !low.endsWith(e)) continue;
    const st = low.slice(0, -e.length);
    c = DE.forms.get(st) || DE.forms.get(st + 'en') || DE.forms.get(st + 'n'); if (c) break;
  }
  return { card: c || null, gloss: gl };
}
function deWordSheet(form, anchor) {
  const { card: c, gloss: g } = deFind(form), lk = DE.cur && c && anchor ? DE.cur.id + '|' + c.id : null;
  DE.looked = DE.looked || new Set();
  if (lk && !DE.looked.has(lk)) { DE.looked.add(lk); deLookup(c); }
  const wk = c ? deWeak(c) : null, tgt = c && DE.cur && (DE.cur.targets || []).includes(c.id);
  deSheet(`<div class="row" style="align-items:baseline;gap:14px;flex-wrap:wrap"><div class="de-sbig">${c ? deWordHtml(c.w) : esc(g && g.lemma || form)}</div>
      ${c && c.pl ? `<span class="muted small">pl. die ${esc(c.pl)}</span>` : ''}
      <div class="row small">${c && !c.user ? `<span class="pill">${esc(c.lv)}</span>` : ''}${wk !== null && wk >= DE_WEAK ? '<span class="pill zh-weak">weak</span>' : ''}${tgt ? '<span class="pill zh-tgtp">target</span>' : ''}${c && deFlagged(c) ? '<span class="pill">flagged</span>' : ''}</div></div>
    ${g && (g.no || g.en) ? `<div style="margin-top:6px"><span class="muted small">Here:</span> <b>${esc(g.no || '')}</b>${g.en ? ` <span class="muted">${esc(g.en)}</span>` : ''}</div>` : ''}
    ${c ? `<div style="margin-top:4px"><span class="muted small">Your card:</span> <b>${esc(c.no || '')}</b> <span class="muted">${esc(c.en || '')}</span></div>${c.forms ? `<div class="small muted">${esc(c.forms)}</div>` : ''}` : ''}
    ${!c && !g ? '<div class="muted" style="margin-top:6px">Not in your deck and not in this text\'s glossary.</div>' : ''}
    ${lk ? '<div class="small muted" style="margin-top:4px">Looked up while reading: it comes back in tomorrow\'s review.</div>' : ''}
    <div class="row" style="margin-top:10px">
      <button class="btn sm ghost" data-de="speak" data-w="${esc(form)}">🔊 Listen</button>
      ${c ? `<button class="btn sm ${deFlagged(c) ? 'warnbtn' : 'ghost'}" data-de="flag-word" data-id="${esc(c.id)}">⚑ ${deFlagged(c) ? 'Flagged' : 'Flag'}</button>`
        : g ? `<button class="btn sm ghost" data-de="add-word" data-w="${esc(g.lemma || form)}" data-no="${esc(g.no || '')}" data-en="${esc(g.en || '')}">＋ Add to deck</button>` : ''}
      ${c && c.ex && c.ex.length ? `<details class="small" style="flex-basis:100%"><summary class="muted" style="cursor:pointer">Examples</summary>${c.ex.slice(0, 4).map(e => `<div style="margin-top:4px">${deMarkIn(e, c)}</div>`).join('')}</details>` : ''}</div>`, anchor);
}
function deCardSheet(id) {
  const c = DE.byId.get(id); if (!c) return;
  deSheet(`<div class="de-sbig">${deWordHtml(c.w)}</div>${deGrammar(c)}<div style="margin-top:6px"><b>${esc(c.no || '')}</b> <span class="muted">${esc(c.en || '')}</span></div>${deExBox(c, 2)}
    <div class="row" style="margin-top:10px"><button class="btn sm ghost" data-de="speak" data-w="${esc(deBare(c.w))}">🔊 Listen</button>
    <button class="btn sm ${deFlagged(c) ? 'warnbtn' : 'ghost'}" data-de="flag-word" data-id="${esc(c.id)}">⚑ ${deFlagged(c) ? 'Flagged' : 'Flag'}</button></div>`);
}

/* ---------- statistics ---------- */
function deStatsData() {
  const z = deP(), now = Date.now(), at = deLearnAt(), cats = new Map();
  const T = { cards: 0, learned: 0, here: 0, right: 0, all: 0, due: 0 }, hard = [];
  const add = (key, x) => { let o = cats.get(key); if (!o) cats.set(key, o = { cards: 0, learned: 0, here: 0, right: 0, all: 0, due: 0 }); for (const k in x) o[k] += x[k]; };
  for (const c of DE.cards) {
    const r = deRec(c), d = deDue(c);
    const x = { cards: 1, learned: deScore(c) >= at ? 1 : 0, here: r ? r.n || 0 : 0, right: r ? r.ok || 0 : 0, all: r ? (r.ok || 0) + (r.bad || 0) : 0, due: d !== null && d <= now ? 1 : 0 };
    for (const k in x) T[k] += x[k];
    const paths = new Set();
    deCatsOf(c).forEach(cat => { const p = cat.split('/'); for (let i = 1; i <= p.length; i++) paths.add(p.slice(0, i).join('/')); });
    paths.forEach(p => add(p, x));
    const miss = x.all - x.right;
    if (x.all >= 3 && miss) hard.push([c, miss / x.all, miss, x.all]);
  }
  hard.sort((a, b) => b[1] - a[1] || b[2] - a[2]);
  let streak = 0;
  for (let k = (z.days[today()] || {}).rev ? 0 : 1; ; k++) { const d = z.days[dayKey(now - k * DAY)]; if (d && d.rev) streak++; else break; }
  return { T, cats, hard: hard.slice(0, 12), streak };
}
function deStatsPage() {
  const { T, cats, hard, streak } = deStatsData(), z = deP(), pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '-';
  const days = n => Array.from({ length: n }, (_, k) => { const key = dayKey(Date.now() - (n - 1 - k) * DAY); return { key, d: z.days[key] || {} }; });
  const d30 = days(30), fmt = key => new Date(key + 'T12:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const revRows = d30.map(({ key, d }) => ({ label: fmt(key), v: d.rev || 0, now: key === today() }));
  const lrnRows = d30.map(({ key, d }) => ({ label: fmt(key), v: d.lrn || 0, now: key === today() }));
  const ahead = Array.from({ length: 14 }, (_, k) => ({ start: new Date(new Date().setHours(0, 0, 0, 0) + (k + 1) * DAY).getTime(), v: 0 }));
  for (const c of DE.cards) { const d = deDue(c); if (d === null) continue; const k = Math.floor((d - ahead[0].start) / DAY); if (k >= 0 && k < 14) ahead[k].v++; }
  const aheadRows = ahead.map(a => ({ label: new Date(a.start).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }), short: new Date(a.start).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), v: a.v }));
  const rev30 = revRows.reduce((n, r) => n + r.v, 0);
  const tile = (n, l, sub) => `<div class="zh-tile"><div class="zh-tile-n">${n}</div><div class="small muted">${l}</div>${sub ? `<div class="small muted">${sub}</div>` : ''}</div>`;
  const kids = new Map();
  [...cats.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).forEach(p => { const i = p.lastIndexOf('/'), par = i < 0 ? '' : p.slice(0, i); if (!kids.has(par)) kids.set(par, []); kids.get(par).push(p); });
  const row = (p, depth) => { const o = cats.get(p), name = p.slice(p.lastIndexOf('/') + 1);
    return `<div class="zh-srow d${depth}"><span class="zh-sname">${esc(name)}</span><span>${o.cards}</span>
      <span class="zh-slearn"><span class="zh-lb"><i style="width:${Math.round(100 * o.learned / o.cards)}%"></i></span>${pct(o.learned, o.cards)}</span>
      <span>${o.here}</span><span>${pct(o.right, o.all)}</span><span>${o.due}</span></div>`; };
  const tree = (p, depth) => { const ch = kids.get(p) || []; return ch.length ? `<details class="zh-sgroup" ${depth === 0 ? 'open' : ''}><summary>${row(p, depth)}</summary>${ch.map(x => tree(x, depth + 1)).join('')}</details>` : row(p, depth); };
  main.innerHTML = `<div class="crumbs"><a href="#/de">← Deutsch</a></div><h1>Statistics</h1>
    <div class="zh-tiles">
      ${tile(T.here, 'repetitions', '')}
      ${tile(pct(T.right, T.all), 'right', `${T.right} of ${T.all} answers`)}
      ${tile(T.learned, 'learned', `of ${T.cards} cards (${pct(T.learned, T.cards)})`)}
      ${tile(streak, streak === 1 ? 'day in a row' : 'days in a row', `${rev30} reviews in 30 days`)}
      ${tile(T.due, 'due now', '')}
    </div>
    <div class="zh-grid" style="margin-top:16px">
      <div class="card"><h3 style="margin-top:0">Reviews per day</h3><p class="small muted" style="margin-top:-6px">last 30 days</p>${zhBars(revRows, 'reviews', 'Reviews per day, last 30 days')}</div>
      <div class="card"><h3 style="margin-top:0">Words learned per day</h3><p class="small muted" style="margin-top:-6px">last 30 days</p>${zhBars(lrnRows, 'learned', 'Words learned per day, last 30 days')}</div>
      <div class="card"><h3 style="margin-top:0">Coming up</h3><p class="small muted" style="margin-top:-6px">reviews due on each of the next 14 days (${T.due} due now)</p>${zhBars(aheadRows, 'due', 'Reviews due on each of the next 14 days')}</div>
    </div>
    <div class="card" style="margin-top:16px"><h3 style="margin-top:0">By level and set</h3>
      <div class="zh-srow zh-shead small muted"><span>Category</span><span>Cards</span><span>Learned</span><span>Repetitions</span><span>Right</span><span>Due</span></div>
      ${(kids.get('') || []).map(p => tree(p, 0)).join('')}</div>
    ${hard.length ? `<div class="card" style="margin-top:16px"><h3 style="margin-top:0">Hardest words</h3><p class="small muted" style="margin-top:-6px">most often wrong (at least 3 answers)</p>
      <div class="zh-misslist">${hard.map(([c, , miss, all]) => `<button class="zh-mrow" data-de="card" data-id="${esc(c.id)}"><b>${deWordHtml(c.w)}</b><span class="zh-mpy">${all - miss}/${all}</span><span class="zh-mm">${esc(deMean(c))}</span></button>`).join('')}</div>
      <div class="row" style="margin-top:10px"><button class="btn sm" data-de="drill-hard">Practise these ${hard.length}</button></div></div>` : ''}`;
}

/* ---------- home ---------- */
function deStats() {
  const now = Date.now(); let weak = 0, rev = 0, due = 0, fl = 0, learned = 0;
  DE.cards.forEach(c => { const w = deWeak(c), r = deRec(c), d = deDue(c); if (w !== null && w >= DE_WEAK) weak++; if (r) rev++; if (d !== null && d <= now) due++; if (deFlagged(c)) fl++; if (deLearned(c)) learned++; });
  return { total: DE.cards.length, weak, rev, due, fl, learned };
}
// categories nest with "/" (Goethe/B1/Set 07): folders; ticking a folder includes everything in it
function deCatData() {
  const counts = new Map(), learned = new Map();
  DE.cards.forEach(c => { const s = new Set(), l = deLearned(c); deCatsOf(c).forEach(cat => { const p = cat.split('/'); for (let i = 1; i <= p.length; i++) s.add(p.slice(0, i).join('/')); }); s.forEach(p => { counts.set(p, (counts.get(p) || 0) + 1); if (l) learned.set(p, (learned.get(p) || 0) + 1); }); });
  const kids = new Map();
  [...counts.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).forEach(p => { const i = p.lastIndexOf('/'), par = i < 0 ? '' : p.slice(0, i); if (!kids.has(par)) kids.set(par, []); kids.get(par).push(p); });
  return { counts, kids, learned };
}
const deCatOpen = kids => new Set(UI.deOpen || kids.get('') || []);
const deCatName = p => p.slice(p.lastIndexOf('/') + 1);
function deCatTree() {
  const { counts, kids, learned } = deCatData(), sel = new Set(UI.deCats || []), open = deCatOpen(kids);
  let n = 0;
  const node = (p, inherited) => {
    const ch = kids.get(p) || [], name = deCatName(p), isOpen = open.has(p), on = sel.has(p) || inherited;
    const part = on ? 0 : [...sel].filter(x => x.startsWith(p + '/')).length, id = 'dc' + n++;
    return `<div class="zh-cat${inherited ? ' inh' : ''}">${ch.length ? `<button class="zh-tw" data-de="cat-open" data-p="${esc(p)}" aria-expanded="${isOpen}" aria-label="${isOpen ? 'Close' : 'Open'} ${esc(name)}">${isOpen ? '▾' : '▸'}</button>` : '<span class="zh-tw"></span>'}
      <input type="checkbox" id="${id}" data-dc="cat" value="${esc(p)}" ${on ? 'checked' : ''} ${inherited ? 'disabled title="Included: the folder above is ticked"' : ''} ${part ? 'data-part="1"' : ''}>
      ${ch.length ? `<button class="zh-cn" data-de="cat-open" data-p="${esc(p)}">${esc(name)}</button>` : `<label class="zh-cn" for="${id}">${esc(name)}</label>`}
      <span class="muted small">${counts.get(p)}${part && !isOpen ? ` · ${part} ticked inside` : ''}</span>${p === DE.lastTick && sel.has(p) && p.includes('/') && deCatUp(p, kids).length > 1 ? `<button class="zh-up" data-de="cat-up" data-p="${esc(p)}" title="Tick ${esc(name)} and everything before it">↑ and up</button>` : ''}${zhLearnBar(learned.get(p) || 0, counts.get(p))}</div>
      ${ch.length ? `<div class="zh-catk${isOpen ? ' open' : ''}">${ch.map(x => node(x, on)).join('')}</div>` : ''}`;
  };
  return (kids.get('') || []).map(x => node(x, false)).join('');
}
function deCatUp(p, kids) {
  const out = []; let cur = p;
  while (cur.includes('/')) { const par = cur.slice(0, cur.lastIndexOf('/')), sib = kids.get(par) || []; out.push(...sib.slice(0, sib.indexOf(cur) + (cur === p ? 1 : 0))); cur = par; }
  return out;
}
function deCatHead() {
  const sel = UI.deCats || [], n = sel.length ? DE.cards.filter(c => deInCats(c) && !deRec(c)).length : 0;
  return sel.length ? `${n ? `<button class="btn sm ghost" data-de="known" title="Count the ticked words you have never reviewed as learned; each comes back once within six weeks as a check">I know these (${n})</button>` : ''}<button class="btn sm ghost" data-de="cats-clear">Clear</button>` : '';
}
function deTreeFix() { $$('.de-tree input[data-part]').forEach(i => { i.indeterminate = true; }); }
function deTreeRedraw() {
  const t = $('.de-tree'); if (!t) return;
  const y = t.scrollTop; t.innerHTML = deCatTree(); deTreeFix(); t.scrollTop = y;
  const h = $('#de-cat-head'); if (h) h.innerHTML = deCatHead();
  deRefreshCount(); const td = $('#de-today'); if (td) td.outerHTML = deTodayHtml();
}
function deCountLine() {
  const o = deOpts(), n = dePool(o).length, B = deBatch(), sets = k => `${Math.ceil(k / B)} set${Math.ceil(k / B) === 1 ? '' : 's'} of ${B}`;
  if (UI.deUntil) {
    const u = deUntilCounts(o);
    if (!u.left) return u.total ? `All ${u.total} ${deRefresh(o) ? 'answered right today' : 'learned'}${u.waiting ? ` · ${u.waiting} waiting for tomorrow` : ''}` : 'No cards match';
    return `${u.left} of ${u.total} still to ${deRefresh(o) ? 'answer right' : 'learn'}${u.refresh && !deRefresh(o) ? ` (${u.refresh} learned, to answer right once)` : ''}${u.waiting ? ` · ${u.waiting} waiting for tomorrow` : ''} · ${sets(u.left)}`;
  }
  return `${n} ${o.nouns ? 'noun' : 'card'}${n === 1 ? '' : 's'} match${n === 1 ? 'es' : ''}${n ? ' · ' + sets(n) : ''}`;
}
function deRefreshCount() { const el = $('#de-count'); if (el) el.textContent = deCountLine(); }
function deTodayHtml() {
  const T = deToday(), D = deP().days[today()] || {}, days = [];
  for (let k = 13; k >= 0; k--) { const key = dayKey(Date.now() - k * DAY), d = deP().days[key] || {}; days.push([key, d.rev || 0, d.lrn || 0]); }
  const max = Math.max(10, ...days.map(d => d[1]));
  return `<div class="card zh-today" id="de-today">
    <div class="zh-todayl">
      <h3 style="margin:0">Today</h3>
      <div class="small muted" style="margin:4px 0 10px">${D.rev || 0} reviewed${D.rev ? ` (${D.ok || 0} right)` : ''} · ${D.nw || 0} new · ${D.lrn || 0} learned${(UI.deCats || []).length ? ' · ticked categories only' : ''}</div>
      <button class="btn primary" data-de="today" ${T.cards.length ? '' : 'disabled'}>${T.cards.length ? `Start: ${T.rev} review${T.rev === 1 ? '' : 's'} + ${T.fresh} new` : 'Nothing due - done for today'}</button>
      ${T.due > T.rev ? `<div class="small muted" style="margin-top:6px">${T.due - T.rev} more due (over today's maximum)</div>` : ''}
    </div>
    ${days.some(d => d[1]) ? `<div class="zh-strip" title="Reviews per day, last 14 days">${days.map(([k, n, l]) => `<i title="${k}: ${n} reviewed, ${l} learned" style="height:${Math.max(2, Math.round(44 * n / max))}px" class="${k === today() ? 'now' : ''}"></i>`).join('')}</div>` : ''}
    <details class="zh-todayset"><summary class="small muted">Daily limits</summary>
      <label class="small">New words per day <input type="number" min="0" max="200" value="${deNewPerDay()}" data-dc="newday" class="zh-in" style="width:70px"></label>
      <label class="small">Max reviews per day <input type="number" min="10" max="1000" value="${deMaxRev()}" data-dc="maxrev" class="zh-in" style="width:80px"></label></details>
  </div>`;
}
function deHome() {
  const st = deStats(), o = deOpts();
  if (!st.total) {
    main.innerHTML = `<h1>Deutsch</h1><div class="card"><h3 style="margin-top:0">No German deck yet</h3>
      <p>Put the Goethe word lists (A1, A2, B1 PDFs) in <code>../German/Goethe-Wortlisten</code>, then run <code>python3 engine/goethe_import.py</code> and <code>python3 build.py</code>.</p></div>`;
    return;
  }
  const sel = (k, opts, v) => `<select data-dc="${k}">${opts.map(([val, t]) => `<option value="${val}" ${String(v) === val ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
  const firstTime = !Object.keys(deP().cards).length;
  main.innerHTML = `<h1>Deutsch</h1>
    ${firstTime ? `<div class="card de-hint small">Start by ticking the levels you want under <b>Categories</b> (for B1-B2: tick <b>B1</b> and <b>B2</b>). Words from levels you already know can be ticked and marked with <b>I know these</b>: they count as learned and each comes back once within six weeks as a check. Today then gives you ${deNewPerDay()} new words a day from the ticked levels, Set 01 first.</div>` : ''}
    ${deTodayHtml()}
    <div class="small muted" style="margin:-6px 0 16px;line-height:1.6">${st.total} cards · <b>${st.learned} learned</b> · ${st.total - st.learned} not yet · ${st.rev} reviewed · ${st.weak} weak · ${st.due} due · ${st.fl} flagged</div>
    <div class="zh-grid">
      <div class="card">
        <h3 style="margin-top:0">Flashcard sets</h3>
        <div class="zh-form">
          <label>Cards per set <input type="number" min="1" max="500" value="${deBatch()}" data-dc="batch" class="zh-in" style="width:80px"></label>
          <label>Cards ${sel('filter', [['all', 'All'], ['learning', 'Not learned yet'], ['learned', 'Learned'], ['weak', 'Weak'], ['due', 'Due for review'], ['new', 'New (never reviewed)'], ['flagged', 'Flagged'], ['nouns', 'Nouns only'], ['verbs', 'Verbs only']], o.filter)}</label>
          <label class="zh-weakmin" ${o.filter === 'weak' ? '' : 'hidden'}>Weak from <input type="range" min="0.1" max="0.8" step="0.05" value="${o.weakMin}" data-dc="weakmin"> <span id="de-wm">${Math.round(o.weakMin * 100)}%</span></label>
          <label>Order ${sel('order', [['weak', 'Weakest first'], ['due', 'Most overdue first'], ['random', 'Random']], o.order)}</label>
          <label>Show ${sel('dir', [['de', 'German → meaning'], ['no', 'Norwegian → German'], ['type', 'Norwegian → type the German'], ['art', 'Article drill: der, die or das'], ['listen', 'Listen → meaning']], deDir())}</label>
          <label title="Show the word inside one of Goethe's example sentences (German → meaning only)"><input type="checkbox" data-dc="example" ${UI.deExample ? 'checked' : ''}> Example sentence on the front</label>
          <label title="Plural and verb forms on the front (German → meaning)"><input type="checkbox" data-dc="formsfront" ${UI.deFormsFront ? 'checked' : ''}> Plural and forms on the front</label>
          <label title="The set keeps going round; each card leaves when its score reaches the learned line. Learned cards come after the others and leave on a right answer; a miss brings them back in the set and still marks them weak"><input type="checkbox" data-dc="until" ${UI.deUntil ? 'checked' : ''}> Repeat until learned</label>
          <label title="Good +100, Easy +150, Hard +25 but counts as a miss (never learned), Don't know halves the score">Learned at score <input type="number" min="50" step="50" value="${deLearnAt()}" data-dc="learnat" class="zh-in" style="width:80px"></label>
        </div>
        <div class="row" style="margin-top:14px"><button class="btn primary" data-de="start">Start set</button><span class="small muted" id="de-count">${deCountLine()}</span></div>
      </div>
      <div class="card">
        <div class="row" style="justify-content:space-between;min-height:32px"><h3 style="margin:0">Categories</h3><span id="de-cat-head">${deCatHead()}</span></div>
        <div class="zh-tree de-tree">${deCatTree()}</div>
      </div>
    </div>
    <div class="zh-grid" style="margin-top:16px">
      <a class="card zh-link" href="#/de/stats"><h3 style="margin:0">Statistics</h3><p class="muted small" style="margin:6px 0 0">repetitions, learned and due per level and set · reviews per day · hardest words</p></a>
      <a class="card zh-link" href="#/de/read"><h3 style="margin:0">Reader</h3><p class="muted small" style="margin:6px 0 0">${deTexts().length} text${deTexts().length === 1 ? '' : 's'} · tap a word for its meaning · new texts from your weak words</p></a>
    </div>
    <p class="small muted" style="margin-top:16px">Words: Goethe-Institut Wortlisten A1 (Start Deutsch 1), A2 and B1 (Zertifikat B1), with Goethe's example sentences; each word sits at the lowest level it appears in. B2 and C1 (Goethe has no lists for them): the next most frequent words of written German after A1-B1, from the DeReWo lemma list (IDS Mannheim, CC BY-NC 3.0), most frequent first, with example sentences written for this deck; they are filed under Goethe with the other levels. ${DE.deck.imported ? 'Imported ' + new Date(DE.deck.imported).toLocaleDateString() + '. ' : ''}Update with <code>python3 engine/goethe_import.py</code>.</p>`;
  deTreeFix();
}

/* ---------- reader ---------- */
function deTexts() {
  const z = deP(), out = new Map();
  DE.fileTexts.forEach(t => { if (t && t.id && Array.isArray(t.paragraphs)) out.set(t.id, Object.assign({ src: 'file' }, t)); });
  for (const [id, v] of Object.entries(z.texts)) { if (v.del) out.delete(id); else if (!out.has(id) && Array.isArray(v.paragraphs)) out.set(id, Object.assign({ src: 'saved', id }, v)); }
  return [...out.values()].sort((a, b) => (b.created || 0) - (a.created || 0));
}
const DE_TOK = /([\p{L}ß]+(?:-[\p{L}ß]+)*)/u;
function deReadText(id) {
  const t = deTexts().find(x => x.id === id);
  if (!t) { main.innerHTML = `<div class="crumbs"><a href="#/de/read">← Reader</a></div><div class="card">That text is not here${deServed() ? '' : ' - texts written by Claude Code show up when StudyHub runs through Start StudyHub, or after python3 build.py'}.</div>`; return; }
  DE.cur = t;
  const targets = new Set(t.targets || []), tgtCards = [...targets].map(id => DE.byId.get(id)).filter(Boolean);
  const found = new Set();
  const para = (p, i) => {
    const toks = String(p.de || '').split(DE_TOK).map((k, j) => {
      if (j % 2 === 0) return esc(k);
      const { card: c } = deFind(k), cls = ['zw', c && targets.has(c.id) ? 'tgt' : '', c ? 'indeck' : '', c && deWeak(c) !== null && deWeak(c) >= DE_WEAK ? 'weak' : ''].filter(Boolean).join(' ');
      if (c && targets.has(c.id)) found.add(c.id);
      return `<span class="${cls}" data-de="word" data-w="${esc(k)}">${esc(k)}</span>`;
    }).join('');
    const tr = p.no || p.en || '';
    return `<div class="zh-para"><p lang="de">${toks}</p>${tr ? `<p class="zh-en ${UI.deShowTr ? 'on' : ''}" id="de-tr-${i}">${esc(tr)}</p><button class="btn sm ghost zh-enb" data-de="para-tr" data-i="${i}">${UI.deShowTr ? 'Hide' : 'Norsk'}</button>` : ''}</div>`;
  };
  const body = t.paragraphs.map(para).join('');
  const missing = tgtCards.filter(c => !found.has(c.id));
  main.innerHTML = `<div class="crumbs"><a href="#/de/read">← Reader</a></div>
    <div class="zh-read">
      <h1 lang="de" style="margin-bottom:4px">${esc(t.title || 'Text')}</h1>${t.titleNo ? `<div class="muted">${esc(t.titleNo)}</div>` : ''}
      <div class="row small" style="margin:12px 0">
        <label><input type="checkbox" data-dc="showtr" ${UI.deShowTr ? 'checked' : ''}> Norwegian translation</label>
        ${tgtCards.length ? `<button class="btn sm primary" data-de="drill-text">Drill the ${tgtCards.length} target word${tgtCards.length === 1 ? '' : 's'}</button>` : ''}
        <button class="btn sm ghost" data-de="speak" data-w="${esc(t.paragraphs.map(p => p.de).join(' '))}">🔊 Read aloud</button>
        <button class="btn sm ghost" data-de="text-del" data-id="${esc(t.id)}">Delete text</button></div>
      ${tgtCards.length ? `<div class="small muted" style="margin-bottom:10px">Target words (highlighted): ${tgtCards.map(c => esc(deBare(c.w))).join(', ')}${missing.length ? ` · <span class="zh-bad">not found in the text: ${missing.map(c => esc(deBare(c.w))).join(', ')}</span>` : ''}</div>` : ''}
      <div class="card zh-text de-text">${body}</div>
      <p class="small muted">Tap any word for its meaning. Underlined words are in your deck; red underline = weak.</p></div>`;
}
const DE_LENS = { short: 150, medium: 300, long: 600, xlong: 1000, xxlong: 1600 };
function deReader() {
  const g = Object.assign({ source: 'weak', n: 12, len: 'medium', style: 'story', topic: '', level: 'B1' }, UI.deGen || {});
  const texts = deTexts(), opt = (v, t) => `<option value="${v}" ${g.source === v ? 'selected' : ''}>${t}</option>`;
  main.innerHTML = `<div class="crumbs"><a href="#/de">← Deutsch</a></div><h1>Reader</h1>
    <div class="zh-grid">
      <div class="card"><h3 style="margin-top:0">New text from my words</h3>
        <p class="small muted" style="margin-top:-4px">Copies a prompt for Claude Code (uses your plan, not the API). Paste it into a Claude Code window; it writes the text where StudyHub finds it.</p>
        <div class="zh-form">
          <label>Words <select data-dc="gen-source">${opt('weak', 'My weakest words')}${opt('weakcats', 'Weakest in the ticked categories')}${opt('flagged', 'Flagged words')}${opt('recent', 'Words learned in the last 7 days')}</select></label>
          <label>How many <input type="number" min="3" max="60" value="${g.n}" data-dc="gen-n" class="zh-in" style="width:70px"></label>
          <label>Level <select data-dc="gen-level">${['A2', 'B1', 'B2', 'C1', 'C2'].map(v => `<option ${g.level === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          <label>Length <select data-dc="gen-len">${[['short', 'Short (~150 words)'], ['medium', 'Medium (~300)'], ['long', 'Long (~600)'], ['xlong', 'Very long (~1,000)'], ['xxlong', 'Extra long (~1,600)']].map(([v, t]) => `<option value="${v}" ${g.len === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label>Kind <select data-dc="gen-style">${[['story', 'Short story'], ['dialogue', 'Dialogue'], ['diary', 'Diary entry'], ['news', 'News-style report'], ['email', 'E-mail / letter']].map(([v, t]) => `<option value="${v}" ${g.style === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label style="flex:1 1 220px">Topic <input class="zh-in" data-dc="gen-topic" value="${esc(g.topic)}" placeholder="optional, e.g. a semester abroad" style="width:100%"></label>
        </div>
        <div class="row" style="margin-top:12px"><button class="btn primary" data-de="gen-copy">Copy prompt for Claude Code</button><span class="small muted" id="de-gen-status">${DE.pending ? 'Waiting for Claude Code to write the text…' : ''}</span></div>
        <textarea id="de-prompt" class="zh-in zh-prompt" readonly ${DE.prompt ? '' : 'hidden'}>${esc(DE.prompt)}</textarea>
      </div>
      <div class="card"><h3 style="margin-top:0">Paste a text</h3>
        <p class="small muted" style="margin-top:-4px">Any German text (an article, a chapter), or the JSON Claude replied with.</p>
        <textarea id="de-paste" class="zh-in" lang="de" rows="6" style="width:100%" placeholder="Deutschen Text einfügen…"></textarea>
        <div class="row" style="margin-top:8px"><button class="btn" data-de="paste-open">Open in reader</button></div></div>
    </div>
    <h3 style="margin-top:22px">Texts</h3>
    ${texts.length ? `<div class="zh-texts">${texts.map(t => `<a class="card zh-link" href="#/de/read/${encodeURIComponent(t.id)}"><b lang="de">${esc(t.title || 'Text')}</b>${t.titleNo ? ` <span class="muted small">${esc(t.titleNo)}</span>` : ''}<div class="small muted">${t.created ? new Date(t.created).toLocaleDateString() : ''}${(t.targets || []).length ? ` · ${t.targets.length} target words` : ''}${t.level ? ' · ' + esc(t.level) : ''}</div></a>`).join('')}</div>` : '<p class="muted">No texts yet.</p>'}`;
}
// the words a text should practise: a random draw from the weak ones (weight = weakness²), leaving out the targets of the last 5 texts
function deDraw(cands, n) {
  const recent = new Set(deTexts().slice(0, 5).flatMap(t => t.targets || []));
  let pool = cands.map(c => [c, deWeak(c)]).filter(([, w]) => w !== null && w >= 0.2);
  if (pool.length < n) pool = cands.filter(deRec).map(c => [c, deWeak(c) ?? 0.3]);
  if (pool.length < n) pool = pool.concat(cands.filter(c => !deRec(c)).slice(0, n * 3).map(c => [c, 0.3]));
  const fresh = pool.filter(([c]) => !recent.has(c.id));
  if (fresh.length >= n) pool = fresh;
  pool = pool.sort((a, b) => b[1] - a[1]).slice(0, Math.max(n * 8, 80));
  const out = [];
  while (out.length < n && pool.length) {
    const total = pool.reduce((t, [, w]) => t + w * w + 0.01, 0);
    let r = Math.random() * total, k = 0;
    for (; k < pool.length - 1; k++) { r -= pool[k][1] * pool[k][1] + 0.01; if (r <= 0) break; }
    out.push(pool.splice(k, 1)[0][0]);
  }
  return out;
}
function deTargets(g) {
  const n = Math.max(3, Math.min(60, +g.n || 12));
  if (g.source === 'flagged') return deDraw(DE.cards.filter(deFlagged), n);
  if (g.source === 'recent') { const t0 = Date.now() - 7 * DAY; return shuffle(DE.cards.filter(c => { const r = deRec(c); return r && r.n && (r.t || 0) > t0; })).slice(0, n); }
  return deDraw(g.source === 'weakcats' ? DE.cards.filter(c => deInCats(c)) : DE.cards, n);
}
function deBuildPrompt() {
  const g = Object.assign({ source: 'weak', n: 12, len: 'medium', style: 'story', topic: '', level: 'B1' }, UI.deGen || {});
  const words = deTargets(g); if (!words.length) return null;
  const d = new Date(), pad = x => String(x).padStart(2, '0');
  const id = `de-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = DE.textsDir || '<StudyHub folder>/content/_german/texts';
  const len = DE_LENS[g.len] || 300;
  const kind = { story: 'a short story (some dialogue is fine)', dialogue: 'a dialogue between two or three people', diary: 'a diary entry', news: 'a short news-style report', email: 'a personal e-mail or letter' }[g.style] || 'a short story';
  const p = `Write a German reading text for me (I am Norwegian, learning German at about CEFR ${g.level}) and save it as a JSON file. Do not ask questions; just write the file.

Target words. Use every one at least once, ideally twice, in a natural way and in a form that fits the sentence (any case, plural or tense is fine):
${words.map(c => `- ${c.id} = ${deBare(c.w)}${c.pl ? ' (pl. ' + c.pl + ')' : ''}${c.forms ? ' (' + c.forms + ')' : ''}: ${deMean(c)}`).join('\n')}

Keep the rest of the language at ${g.level}: everyday vocabulary, clear sentences, some subordinate clauses (weil, dass, obwohl, wenn) and the Perfekt and Präteritum as a native speaker would use them. Standard German (Germany), no dialect.

Length: about ${len} words (count them; do not stop much shorter), in short paragraphs of 40-90 words${len >= 1000 ? ', as a story with several scenes so it stays interesting' : ''}. Kind: ${kind}. Topic: ${g.topic.trim() || 'your choice, everyday life'}.

Save exactly this JSON shape (UTF-8, valid JSON) to this file:
${dir}/${id}.json

{
  "id": "${id}",
  "title": "short German title",
  "titleNo": "the title in Norwegian (bokmål)",
  "level": "${g.level}",
  "created": ${Date.now()},
  "targets": ${JSON.stringify(words.map(c => c.id))},
  "paragraphs": [ { "de": "one paragraph in German", "no": "natural Norwegian (bokmål) translation of it" } ],
  "glossary": { "Wortform": { "lemma": "dictionary form, nouns with article (der Bahnhof), verbs in the infinitive", "no": "Norwegian meaning as used here", "en": "English meaning" } }
}

The glossary must list every word form in the text that a ${g.level} learner might not know, plus every form of the target words, keyed exactly as the word appears in the text (inflected, with its capital letter if it has one). Leave out the most basic words (der, und, ist, ich, nicht, in, mit …). Before saving, check that every target word appears in the text and that the file parses as JSON. Then reply with one line.`;
  return { id, prompt: p };
}
function deWatch(id) {
  DE.pending = id; clearInterval(DE.poll);
  if (!deServed()) return;
  const t0 = Date.now();
  DE.poll = setInterval(async () => {
    if (Date.now() - t0 > 20 * 60000) { clearInterval(DE.poll); DE.pending = null; return; }
    await deLoad(true);
    if (DE.fileTexts.some(t => t.id === id)) {
      clearInterval(DE.poll); DE.pending = null; DE.prompt = '';
      toast('New text ready');
      if (/^#\/de\/read\/?$/.test(location.hash)) go('#/de/read/' + encodeURIComponent(id));
    }
  }, 4000);
}
function dePasteOpen() {
  const raw = ($('#de-paste') || {}).value || ''; if (!raw.trim()) { toast('Paste a text first'); return; }
  let t = null;
  if (raw.trim().startsWith('{')) { try { t = JSON.parse(raw.trim()); } catch (e) { toast('That JSON does not parse'); return; } }
  if (!t || !Array.isArray(t.paragraphs)) {
    const ps = raw.split(/\n\s*\n|\n/).map(s => s.trim()).filter(Boolean);
    t = { title: ps[0].split(/\s+/).slice(0, 6).join(' '), paragraphs: ps.map(de => ({ de })) };
  }
  t.id = t.id || 'p-' + Date.now().toString(36); t.created = t.created || Date.now();
  const z = deP(); z.texts[t.id] = Object.assign({}, t, { t: Date.now() });
  deLive(z.texts).sort((a, b) => (b[1].t || 0) - (a[1].t || 0)).slice(30).forEach(([id]) => { z.texts[id] = { t: Date.now(), del: true }; });
  saveP(); go('#/de/read/' + encodeURIComponent(t.id));
}
function deSpeak(text, auto) {
  const ss = window.speechSynthesis; if (!ss) { if (!auto) toast('This browser cannot read aloud'); return; }
  const vs = ss.getVoices(), v = vs.find(x => /^de[-_]DE/i.test(x.lang)) || vs.find(x => /^de/i.test(x.lang));
  if (!v) { toast('No German voice on this device - add one in the system speech settings'); return; }
  ss.cancel(); const u = new SpeechSynthesisUtterance(text); u.voice = v; u.lang = v.lang; u.rate = 0.9; ss.speak(u);
}

/* ---------- view ---------- */
function viewDe(r) {
  deInit();
  const sub = r.sub || '';
  document.title = 'StudyHub · Deutsch';
  if (sub !== 'read' || !r.arg) DE.cur = null;
  if (sub === 'play') dePlay();
  else if (sub === 'stats') deStatsPage();
  else if (sub === 'read' && r.arg) deReadText(r.arg);
  else if (sub === 'read') deReader();
  else deHome();
  const h = location.hash, v0 = DE.ver;
  deLoad().then(() => { if (location.hash !== h || sub === 'play') return; if (DE.ver !== v0) { const y = scrollY; viewDe(r); window.scrollTo(0, y); } });
}
function deRedraw() { const y = scrollY; viewDe(parseRoute()); window.scrollTo(0, y); }

/* ---------- events (own listeners, data-de / data-dc attributes) ---------- */
let deTapEl = null, deTapAt = 0, deTap = null;
document.addEventListener('pointerdown', ev => { const el = ev.isPrimary && ev.target.closest && ev.target.closest('span[data-de]'); deTap = el ? { x: ev.clientX, y: ev.clientY, t: Date.now(), el } : null; }, true);
document.addEventListener('pointerup', ev => {
  const s = deTap; deTap = null;
  if (s && Math.hypot(ev.clientX - s.x, ev.clientY - s.y) <= 10 && Date.now() - s.t <= 600) {
    const el = ev.target.closest && ev.target.closest('span[data-de]');
    if (el === s.el) { deTapEl = el; deTapAt = Date.now(); deAct(el, ev); }
    return;
  }
}, true);
// a tap on a plain part of the card flips it (phones send no click there)
document.addEventListener('pointerup', ev => {
  if (!DS || DS.flipped || !ev.target.closest || !ev.target.closest('.de-play.front') || ev.target.closest('a,button,input,textarea,select,label,summary')) return;
  if (deDir() === 'art' || deDir() === 'type') return;
  deTapAt = Date.now(); deTapEl = null; deFlip();
});
document.addEventListener('click', ev => {
  const el = ev.target.closest && ev.target.closest('[data-de]');
  if (!el) return;
  if (Date.now() - deTapAt < 700 && (el === deTapEl || (el.dataset.de === 'flip' && !deTapEl))) return;
  deAct(el, ev);
});
function deAct(el, ev) {
  const a = el.dataset.de, d = el.dataset;
  switch (a) {
    case 'flip': deFlip(); break;
    case 'rate': deRateCur(+d.l); break;
    case 'art': deArtPick(d.a); break;
    case 'type-check': deTypeCheck(); break;
    case 'start': deStart(deOpts()); break;
    case 'next-set': deNext(); break;
    case 'undo': deUndo(); break;
    case 'today': { const T = deToday(); if (!T.cards.length) { toast('Nothing due today'); break; } deStart({ ids: T.cards.map(c => c.id), order: 'keep', title: 'Today', today: true }); break; }
    case 'drill-hard': deStart({ ids: deStatsData().hard.map(([c]) => c.id), order: 'keep', title: 'Hardest words' }); break;
    case 'redo-missed': deStart({ ids: DS.missed.slice(), order: 'random', title: 'missed', nouns: DS.o.nouns, from: DS.o.from || { o: DS.o, seen: DS.seen, setNo: DS.setNo } }); break;
    case 'known': { const cs = DE.cards.filter(c => deInCats(c) && !deRec(c)); if (!cs.length || !confirm(`Count ${cs.length} ticked word${cs.length === 1 ? '' : 's'} you have never reviewed as learned? Each comes back once within six weeks as a check.`)) break;
      const n = deMarkKnown(cs); toast(`${n} words marked as known`); deRedraw(); break; }
    case 'cats-clear': UI.deCats = []; saveUI(); deTreeRedraw(); break;
    case 'cat-up': { const add = deCatUp(d.p, deCatData().kids), covered = x => add.some(a2 => x === a2 || x.startsWith(a2 + '/'));
      UI.deCats = (UI.deCats || []).filter(x => !covered(x)).concat(add); DE.lastTick = null; saveUI(); deTreeRedraw(); toast(`Ticked ${deCatName(d.p)} and up (${add.length} folders)`); break; }
    case 'cat-open': { const o = deCatOpen(deCatData().kids); o.has(d.p) ? o.delete(d.p) : o.add(d.p); UI.deOpen = [...o]; saveUI(); deTreeRedraw(); break; }
    case 'word': if (DE.sheetEl === el && !document.getElementById('de-sheet').hidden) deSheetClose(); else { deWordSheet(d.w, el); $$('.de-on').forEach(x => x.classList.remove('de-on')); el.classList.add('de-on'); DE.sheetEl = el; } break;
    case 'card': deCardSheet(d.id); break;
    case 'sheet-close': deSheetClose(); break;
    case 'speak': ev.stopPropagation(); deSpeak(d.w); break;
    case 'flag-word': { ev.stopPropagation(); const c = DE.byId.get(d.id); if (!c) break; const on = !deFlagged(c); deP().hardW[d.id] = on ? { t: Date.now() } : { t: Date.now(), del: true }; saveP();
      el.classList.toggle('warnbtn', on); el.classList.toggle('ghost', !on); el.textContent = on ? '⚑ Flagged' : '⚑ Flag' + (el.closest('.zh-card') ? ' word' : ''); toast(on ? 'Word flagged' : 'Flag removed'); break; }
    case 'add-word': { const w = d.w, m = /^(der|die|das) (.+)$/.exec(w), id = 'reader:' + w; deP().added[id] = { w, lemma: m ? m[2] : w, art: m ? m[1] : '', no: d.no, en: d.en, t: Date.now() }; saveP(); deSetDeck(DE.deck); toast('Added to your deck (category "From reader")'); deSheetClose(); break; }
    case 'para-tr': { const p = $('#de-tr-' + d.i); if (p) { p.classList.toggle('on'); el.textContent = p.classList.contains('on') ? 'Hide' : 'Norsk'; } break; }
    case 'drill-text': { const t = DE.cur; if (t) deStart({ ids: (t.targets || []).filter(id => DE.byId.get(id)), order: 'weak', title: t.title }); break; }
    case 'text-del': { if (!confirm('Delete this text?')) break; deP().texts[d.id] = { t: Date.now(), del: true }; saveP(); go('#/de/read'); break; }
    case 'gen-copy': { const b = deBuildPrompt(); if (!b) { toast('No words to practise yet - review some cards first'); break; }
      DE.prompt = b.prompt; const ta = $('#de-prompt'); if (ta) { ta.value = b.prompt; ta.hidden = false; }
      zhCopy(b.prompt).then(ok => { if (!ok && ta) { ta.select(); try { document.execCommand('copy'); } catch (e) { /* select it by hand */ } } toast(ok ? 'Prompt copied - paste it into Claude Code' : 'Select the prompt below and copy it'); });
      deWatch(b.id); const st = $('#de-gen-status'); if (st) st.textContent = deServed() ? 'Waiting for Claude Code to write the text… it opens here by itself.' : 'When Claude Code is done, run python3 build.py and reload.'; break; }
    case 'paste-open': dePasteOpen(); break;
  }
}
document.addEventListener('change', ev => {
  const el = ev.target, k = el.dataset && el.dataset.dc; if (!k) return;
  const gen = (f, v) => { UI.deGen = Object.assign({ source: 'weak', n: 12, len: 'medium', style: 'story', topic: '', level: 'B1' }, UI.deGen, { [f]: v }); saveUI(); };
  switch (k) {
    case 'batch': UI.deBatch = Math.max(1, Math.min(500, Math.round(+el.value || 20))); el.value = UI.deBatch; break;
    case 'filter': UI.deFilter = el.value; { const w = $('.zh-weakmin'); if (w) w.hidden = el.value !== 'weak'; } break;
    case 'weakmin': UI.deWeakMin = +el.value; break;
    case 'order': UI.deOrder = el.value; break;
    case 'dir': UI.deDir = el.value; break;
    case 'until': UI.deUntil = el.checked; break;
    case 'example': UI.deExample = el.checked; break;
    case 'formsfront': UI.deFormsFront = el.checked; break;
    case 'newday': UI.deNewPerDay = Math.max(0, Math.min(200, Math.round(+el.value || 0))); saveUI(); deRedraw(); return;
    case 'maxrev': UI.deMaxRev = Math.max(10, Math.min(1000, Math.round(+el.value || 150))); saveUI(); deRedraw(); return;
    case 'learnat': UI.deLearnAt = Math.max(50, Math.round(+el.value || 300)); el.value = UI.deLearnAt; saveUI(); deRedraw(); return;
    case 'cat': { const v = el.value; let sel = (UI.deCats || []).filter(x => x !== v);
      DE.lastTick = el.checked ? v : null;
      if (el.checked) sel = sel.filter(x => !x.startsWith(v + '/')).concat(v);
      UI.deCats = sel; saveUI(); deTreeRedraw(); return; }
    case 'showtr': UI.deShowTr = el.checked; saveUI(); deRedraw(); return;
    case 'gen-source': gen('source', el.value); return;
    case 'gen-n': gen('n', Math.max(3, Math.min(60, +el.value || 12))); return;
    case 'gen-level': gen('level', el.value); return;
    case 'gen-len': gen('len', el.value); return;
    case 'gen-style': gen('style', el.value); return;
    case 'gen-topic': gen('topic', el.value); return;
  }
  saveUI(); deRefreshCount();
});
document.addEventListener('input', ev => { const el = ev.target; if (el.dataset && el.dataset.dc === 'weakmin') { const s = $('#de-wm'); if (s) s.textContent = Math.round(el.value * 100) + '%'; } });
document.addEventListener('keydown', ev => {
  const sh = document.getElementById('de-sheet');
  if (ev.key === 'Escape' && sh && !sh.hidden) { deSheetClose(); return; }
  if (ev.key === 'Enter' && ev.target.id === 'de-type') { ev.preventDefault(); deTypeCheck(); return; }
  if (!DS || !/^#\/de\/play/.test(location.hash)) return;
  const tag = (ev.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const undoKey = ev.key === 'ArrowLeft' || ev.key.toLowerCase() === 'u';
  if (DS.i >= DS.ids.length) { if (ev.key === 'Enter') { ev.preventDefault(); deNext(); } else if (undoKey && deCanUndo()) { ev.preventDefault(); deUndo(); } return; }
  if (!DS.flipped && deDir() === 'art' && /^[1-3]$/.test(ev.key)) { ev.preventDefault(); deArtPick(['der', 'die', 'das'][+ev.key - 1]); }
  else if (ev.key === 'Enter' && DS.flipped && DS.typed) { ev.preventDefault(); deRateCur(DS.typed.sug); }
  else if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); deFlip(); }
  else if (DS.flipped && /^[1-4]$/.test(ev.key)) { ev.preventDefault(); deRateCur(+ev.key - 1); }
  else if (undoKey && deCanUndo()) { ev.preventDefault(); deUndo(); }
  else if (ev.key.toLowerCase() === 's') { const c = DE.byId.get(DS.ids[DS.i]); if (c) deSpeak(deBare(c.w)); }
});
window.addEventListener('hashchange', () => deSheetClose());
window.addEventListener('load', () => setTimeout(() => { if (deServed() && !window.STUDYHUB_STATIC && typeof P !== 'undefined') { deInit(); deLoad(); } }, 4500));

/* ---------- styles (on top of zh.js's) ---------- */
(() => {
  const s = document.createElement('style'); s.id = 'de-css';
  s.textContent = `
:root{--de-m:#2f6fd6;--de-f:#d23f57;--de-n:#1f9d63}
@media (prefers-color-scheme:dark){:root{--de-m:#7aa8ff;--de-f:#ff7f93;--de-n:#53d39a}}
.de-art{font-weight:700}.de-art.m{color:var(--de-m)}.de-art.f{color:var(--de-f)}.de-art.n{color:var(--de-n)}.de-art.q{color:var(--muted);letter-spacing:.05em}
.de-hw{font-size:clamp(2rem,7vw,3.2rem);line-height:1.2;font-weight:600;overflow-wrap:anywhere}
.zh-ahead .de-hw{font-size:clamp(1.8rem,6vw,2.6rem)}
.de-gram{margin-top:6px;font-size:.95rem;line-height:1.5}
.de-mean{margin-top:12px;font-size:1.25rem}.de-mean.big{font-size:clamp(1.5rem,5vw,2rem);margin-top:0}.de-en{color:var(--muted);font-size:.9em;font-weight:400;margin-top:2px}
.de-exbox .de-ex{font-size:1.05rem;line-height:1.5;margin-top:4px}.de-exbox mark,.de-exfront mark{background:var(--accent-soft);color:inherit;border-radius:3px;padding:0 2px;font-weight:600}
.de-exfront{font-size:clamp(1.3rem,4.5vw,1.8rem);line-height:1.5}
.de-sbig{font-size:1.7rem;font-weight:600;line-height:1.2}
.de-play .rate .de-artbtn{font-size:1.1rem;font-weight:700;min-width:90px}.de-artbtn.m{color:var(--de-m)}.de-artbtn.f{color:var(--de-f)}.de-artbtn.n{color:var(--de-n)}
.de-text{font-size:1.2rem;line-height:1.85}
.zw.de-on{outline:2px solid var(--accent);outline-offset:1px;border-radius:4px}
.de-hint{margin-bottom:14px;line-height:1.55;border-color:var(--accent)}
.de-play.front{cursor:pointer}
@media (min-width:701px){.de-play .rate{position:sticky;bottom:0;z-index:5;padding:10px 0;background:linear-gradient(transparent,var(--bg) 30%)}}
@media (max-width:700px){.de-play{min-height:calc(100vh - 90px);padding-bottom:120px}
  .de-play .rate{position:fixed;left:0;right:0;bottom:0;z-index:15;margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(0,1fr));gap:8px;padding:10px 12px calc(10px + env(safe-area-inset-bottom));background:var(--bg);border-top:1px solid var(--border)}
  .de-play .rate .btn{min-width:0;padding:15px 4px;font-size:.92rem;justify-content:center;white-space:nowrap}.de-play .rate .kbd{display:none}}`;
  document.head.appendChild(s);
})();
