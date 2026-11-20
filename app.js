import {LOCALES, names, t, displayTitle, citation, quoteWithCitation} from './i18n.js';
import zhmap from './zhmap.js';

const el = id => document.getElementById(id);
const select = el('locale');
const query = el('query');
const results = el('results');
const reader = el('reader');
const notesView = el('notes');
const status = el('status');
const position = new Map();
let catalog;
let texts = {};
let available = {};
const loadedLocales = new Map();
let previousDocument;
let index = [];
let indexedLocale;
let current = null; // {doc, locale, text}

// ---------------------------------------------------------------- storage
function readStore(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
let annotations = readStore('sacerdos-annotations', {});
let lastRead = readStore('sacerdos-last-read', {});
let settings = readStore('sacerdos-settings', {});

function element(tag, content, className) {
  const node = document.createElement(tag);
  node.textContent = content ?? '';
  if (className) node.className = className;
  return node;
}
function link(label, href) {
  const node = element('a', label);
  node.href = href;
  return node;
}
function setLang(node, locale) {
  node.lang = locale;
  node.dir = locale === 'ar' ? 'rtl' : 'auto';
}
function toast(message) {
  const box = el('toast');
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { box.hidden = true; }, 2200);
}

// ---------------------------------------------------------------- language and chrome
function defaultLocale() {
  const stored = readStore('sacerdos-language', null);
  if (LOCALES.includes(stored)) return stored;
  for (const lang of navigator.languages ?? [navigator.language]) {
    const l = (lang || '').toLowerCase();
    if (/^zh-(hk|tw|mo|hant)/.test(l)) return 'zh-Hant';
    if (l.startsWith('zh')) return 'zh-Hans';
    const base = l.split('-')[0];
    if (LOCALES.includes(base)) return base;
  }
  return 'en';
}
let uiLocale = defaultLocale();

let fontLoaded = {};
function ensureFont(locale) {
  if (!locale.startsWith('zh') || fontLoaded[locale]) return;
  fontLoaded[locale] = true;
  const family = locale === 'zh-Hant' ? 'Noto+Serif+TC' : 'Noto+Serif+SC';
  const linkEl = document.createElement('link');
  linkEl.rel = 'stylesheet';
  linkEl.href = `https://fonts.googleapis.com/css2?family=${family}:wght@400;600&display=swap`;
  document.head.append(linkEl);
}

function applyChrome(locale) {
  uiLocale = locale;
  const s = t(locale);
  document.documentElement.lang = locale;
  document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  ensureFont(locale);
  el('landing-tagline').textContent = s.tagline;
  el('open-library').textContent = s.open;
  el('library-eyebrow').textContent = s.saint;
  el('library-title').textContent = s.libraryTitle;
  el('library-sub').textContent = s.librarySub;
  el('search-label').textContent = s.searchLabel;
  query.placeholder = s.searchPlaceholder;
  el('language-label').textContent = s.languageLabel;
  el('footer-saint').textContent = s.saint;
  el('install').textContent = s.install;
  el('offline').textContent = s.offline;
  el('notes-link').textContent = s.myNotes;
  el('display-btn').setAttribute('aria-label', s.display);
  el('display-btn').title = s.display;
  el('display-title').textContent = s.display;
  el('theme-label').textContent = s.theme;
  el('size-label').textContent = s.textSize;
  el('size-down').setAttribute('aria-label', s.smaller);
  el('size-up').setAttribute('aria-label', s.larger);
  el('display-close').textContent = s.close;
  el('actions-close').textContent = s.close;
  el('act-copy').textContent = s.copy;
  el('note-editor-label').textContent = s.notePrompt;
  el('note-save').textContent = s.save;
  el('note-delete').textContent = s.remove;
  el('note-cancel').textContent = s.cancel;
  renderThemeOptions();
}

// ---------------------------------------------------------------- display settings
const SIZES = [0.95, 1.05, 1.15, 1.23, 1.35, 1.5, 1.7, 1.9];
function applySettings() {
  const root = document.documentElement;
  if (settings.theme) root.dataset.theme = settings.theme; else delete root.dataset.theme;
  const size = settings.size ?? 1.23;
  root.style.setProperty('--reader-size', size + 'rem');
  el('size-value').textContent = Math.round(size / 1.23 * 100) + '%';
  document.querySelector('meta[name=theme-color]').content = settings.theme === 'dark' ? '#0f1716' : '#172b28';
}
function renderThemeOptions() {
  const s = t(uiLocale);
  const box = el('theme-options');
  box.replaceChildren(...['light', 'sepia', 'dark'].map(theme => {
    const b = element('button', s[theme]);
    b.type = 'button';
    b.setAttribute('aria-pressed', String((settings.theme ?? 'light') === theme));
    b.onclick = () => {
      settings.theme = theme === 'light' ? undefined : theme;
      writeStore('sacerdos-settings', settings);
      applySettings();
      renderThemeOptions();
    };
    return b;
  }));
}
el('display-btn').onclick = () => el('display-dialog').showModal();
el('display-close').onclick = () => el('display-dialog').close();
function stepSize(dir) {
  const cur = settings.size ?? 1.23;
  const i = SIZES.findIndex(v => Math.abs(v - cur) < 0.01);
  const next = SIZES[Math.min(SIZES.length - 1, Math.max(0, (i < 0 ? 3 : i) + dir))];
  settings.size = next;
  writeStore('sacerdos-settings', settings);
  applySettings();
}
el('size-down').onclick = () => stepSize(-1);
el('size-up').onclick = () => stepSize(1);

// ---------------------------------------------------------------- data
async function load(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error('Could not load ' + path);
  return response.json();
}
function hasText(id, locale) {
  return available[locale]?.includes(id) ?? false;
}
function ensureLocale(locale) {
  if (!loadedLocales.has(locale)) {
    loadedLocales.set(locale, load('./editions/' + locale + '.json').then(data => {
      Object.assign(texts, data);
    }).catch(error => {
      loadedLocales.delete(locale);
      throw error;
    }));
  }
  return loadedLocales.get(locale);
}
function route(id, locale, passage, section) {
  const params = new URLSearchParams({doc:id, lang:locale});
  if (section !== undefined) params.set('s', section);
  else if (passage !== undefined) params.set('p', passage);
  return '#' + params;
}

function fold(text, locale) {
  const lowercase = text.toLocaleLowerCase(locale);
  const normalized = (locale === 'pl' ? lowercase.replaceAll('ł', 'l') : lowercase).normalize('NFKC');
  if (locale.startsWith('zh')) {
    let out = '';
    for (const ch of normalized.replace(/\s+/gu, '')) out += zhmap[ch] ?? ch;
    return out;
  }
  return normalized.normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/gu, ' ').trim();
}

// passages that only repeat the document title (mastheads in the source pages)
const splitTitles = {
  'a-concilio-constantinopolitano-i/ar': [0, 1, 2], 'a-concilio-constantinopolitano-i/it': [0, 1, 2],
  'a-concilio-constantinopolitano-i/nl': [0, 1, 2], 'a-concilio-constantinopolitano-i/pl': [0, 1, 2],
  'a-concilio-constantinopolitano-i/ru': [0, 1, 2], 'a-concilio-constantinopolitano-i/uk': [0, 1, 2],
  'dominicae-cenae/ar': [0], 'dominicae-cenae/de': [0], 'dominicae-cenae/nl': [0], 'dominicae-cenae/pl': [0],
  'dominicae-cenae/ru': [0], 'holy-thursday-1998/de': [0], 'holy-thursday-2000/fr': [0],
};
const letterMastheads = {
  en: /^(?:letter\b|holy thursday letter\b|the pope's letter\b).*priest/,
  es: /^carta\b.*sacerdotes/, it: /^lettera\b.*sacerdoti/, fr: /^lettre\b.*pretres/,
  de: /^(?:schreiben|brief)\b.*priester/, nl: /^brief\b.*priesters/, pl: /^list(?:al)?\b.*kaplan/,
  ru: /^(?:письмо|послание).*священник/, uk: /^(?:лист|послання).*священник/, ar: /^رسالة.*الكهنة/,
};
function repeatedTitle(doc, locale, part, i) {
  if (i > 3) return false;
  const value = fold(part.text, locale).replaceAll('·', '').replace(/^[«「『“"]|[»」』”"]$/gu, '');
  if (splitTitles[doc.id + '/' + locale]?.includes(i)) return true;
  if (value === fold(displayTitle(doc, locale), locale)) return true;
  if (/^(?:giovanni paolo|juan pablo|jean[- ]paul|john paul|johannes paul|jan pawel|ioanna? paulus) ii\.?$|^(?:іван пав(?:ло|іл) (?:іі|ii)|иоанн павел ii|يوحنا بولس الثاني)$/u.test(value)) return true;
  if (locale.startsWith('zh')) return false;
  if (doc.kind === 'priests-letter' || doc.kind === 'priests-prayer') {
    return value.length < 250 && Boolean(letterMastheads[locale]?.test(value));
  }
  if (doc.kind === 'post-synodal-apostolic-exhortation') {
    return i === 0 && /pastores dabo vobis|ساعطيكم رعاة/u.test(value);
  }
  if (doc.kind === 'bishops-letter') {
    return (value.includes(fold(doc.title, locale)) && value.length < 400)
      || /^(?:lettera apostolica|apostolic letter|lettre apostolique|carta apostolica|apostolisches schreiben|apostolische brief|list apostolski|апостольское послание|апостольський лист|رسالة رسولية)$/u.test(value);
  }
  return false;
}

// section number at the start of a passage, shown in the margin
function splitNumber(part) {
  if (part.n === undefined) return [null, part.text];
  const m = part.text.match(new RegExp('^\\s*' + part.n + '\\s*[\\.．、]\\s*'));
  return m ? [part.n, part.text.slice(m[0].length)] : [part.n, part.text];
}
function sectionOf(text, i) {
  for (let k = i; k >= 0; k--) if (text.passages[k].n !== undefined) return text.passages[k].n;
  return undefined;
}

// ---------------------------------------------------------------- library
function snippet(text, needle, locale) {
  if (text.length <= 240) return text;
  const at = Math.max(0, fold(text, locale).indexOf(needle));
  const start = Math.max(0, at - 65);
  const end = Math.min(text.length, start + 235);
  return (start ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}
function localeIndex(locale) {
  if (indexedLocale === locale) return index;
  indexedLocale = locale;
  index = catalog.entries.flatMap(doc => {
    const text = texts[doc.id + '/' + locale];
    if (!text) return [];
    const title = displayTitle(doc, locale);
    return [{doc, text:title, search:fold(title, locale)}, ...text.passages.flatMap((part, p) =>
      repeatedTitle(doc, locale, part, p) ? [] : [{doc, p, text:part.text, search:fold(part.text, locale)}])];
  });
  return index;
}
function row(doc, locale, detail, passage) {
  const featured = doc.kind === 'post-synodal-apostolic-exhortation' || doc.kind === 'encyclical';
  const article = element('article', '', 'entry' + (featured ? ' featured' : ''));
  const heading = element('h3', '');
  heading.append(link(displayTitle(doc, locale), route(doc.id, locale, passage)));
  setLang(heading, locale);
  const body = element('div', '');
  body.append(heading);
  if (detail) body.append(detail);
  article.append(element('span', doc.year, 'year'), body);
  return article;
}
function renderContinue(locale) {
  const box = el('continue');
  const recent = Object.values(lastRead).filter(r => r.locale === locale).sort((a, b) => b.t - a.t)[0];
  const doc = recent && catalog.entries.find(d => d.id === recent.doc);
  if (!doc) { box.replaceChildren(); return; }
  const s = t(locale);
  const card = element('p', '', 'continue-card');
  card.append(element('span', s.continueReading, 'eyebrow'), ' ');
  const a = link(displayTitle(doc, locale) + (recent.n ? ` · § ${recent.n}` : ''), route(doc.id, locale, recent.p));
  setLang(a, locale);
  card.append(a);
  box.replaceChildren(card);
}
function renderLibrary() {
  const locale = select.value;
  const s = t(locale);
  const readable = catalog.entries.filter(doc => hasText(doc.id, locale)).length;
  const needle = fold(query.value, locale);
  el('view-title').textContent = needle ? s.results : s.collection;
  renderContinue(locale);
  if (needle && readable && !Object.keys(texts).some(key => key.endsWith('/' + locale))) {
    status.textContent = s.loadingLang(names[locale]);
    ensureLocale(locale).then(() => { if (select.value === locale) renderLibrary(); },
      () => { status.textContent = s.notOffline(names[locale]); });
    return;
  }
  if (needle) {
    const matches = localeIndex(locale).filter(item => item.search.includes(needle));
    const docs = new Set(matches.map(m => m.doc.id)).size;
    status.textContent = s.matches(matches.length, docs);
    const cards = matches.slice(0, 150).map(({doc, p, text}) => {
      const preview = element('p', snippet(text, needle, locale));
      setLang(preview, locale);
      return row(doc, locale, preview, p);
    });
    if (!cards.length) cards.push(element('p', s.noMatches, 'notice'));
    if (matches.length > 150) cards.push(element('p', s.first150, 'notice'));
    results.replaceChildren(...cards);
    return;
  }
  status.textContent = s.readable(readable, catalog.entries.length);
  const rank = d => d.kind === 'post-synodal-apostolic-exhortation' ? 0 : 1;
  const ordered = [...catalog.entries].sort((a, b) => rank(a) - rank(b) || a.year - b.year);
  results.replaceChildren(...ordered.map(doc =>
    hasText(doc.id, locale) ? row(doc, locale) : row(doc, locale, element('p', s.notInLanguage, 'meta'))));
}

// ---------------------------------------------------------------- footnotes
function readingNotes(text, locale) {
  const s = t(locale);
  const groups = text.noteGroups ?? [];
  const lookup = groups.map(group => new Map(group.notes.map(note => [note.number, note.text])));
  const dialog = element('dialog', '', 'note-dialog');
  const dialogTitle = element('h2', '');
  dialogTitle.id = 'note-title';
  dialog.setAttribute('aria-labelledby', dialogTitle.id);
  const noteText = element('p', '');
  const close = element('button', '×');
  close.setAttribute('aria-label', s.close);
  close.onclick = () => dialog.close();
  dialog.append(close, dialogTitle, noteText);
  setLang(dialog, locale);
  const panel = element('details', '', 'footnotes');
  panel.append(element('summary', s.footnotes));
  setLang(panel, locale);
  for (const group of groups) {
    if (group.title) panel.append(element('h3', group.title));
    const list = element('ol', '');
    for (const note of group.notes) {
      const item = element('li', note.text);
      if (note.number === '*') { item.className = 'star-note'; item.prepend('* '); }
      else item.value = Number(note.number);
      list.append(item);
    }
    panel.append(list);
  }
  const label = (g, number) => {
    const title = groups[g]?.title;
    if (!title) return s.footnotes + ' ' + number;
    return locale.startsWith('zh') ? `${title} ${s.noteShort}${number}` : `${title} · ${s.noteShort} ${number}`;
  };
  return {
    appendTo(parent) { if (groups.length) parent.append(panel, dialog); },
    render(block, part, displayText) {
      const g = part.noteGroup === undefined ? 0 : part.noteGroup;
      const notes = lookup[g];
      if (!notes) return;
      const markers = /[\[［〔]\s*(\p{Nd}+)\s*[\]］〕]|[（(]\s*(\p{Nd}+)\s*[）)]|(?<=[\p{L}\p{P}])([*])/gu;
      let offset = 0;
      for (const marker of displayText.matchAll(markers)) {
        const number = (marker[1] ?? marker[2] ?? marker[3]).normalize('NFKC')
          .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x660))
          .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x6f0));
        if (!notes.has(number)) continue;
        if (offset === 0) block.replaceChildren();
        block.append(displayText.slice(offset, marker.index));
        const reference = element('sup', '');
        const button = element('button', number);
        button.setAttribute('aria-label', label(g, number));
        button.onclick = event => {
          event.stopPropagation();
          dialogTitle.textContent = label(g, number);
          noteText.textContent = notes.get(number);
          dialog.showModal();
        };
        reference.append(button);
        block.append(reference);
        offset = marker.index + marker[0].length;
      }
      if (offset) block.append(displayText.slice(offset));
    },
  };
}

// ---------------------------------------------------------------- annotations
const annKey = (doc, locale, p) => `${doc}|${locale}|${p}`;
function getAnn(doc, locale, p) {
  return annotations[annKey(doc, locale, p)];
}
function setAnn(doc, locale, p, patch) {
  const key = annKey(doc, locale, p);
  const prev = annotations[key] ?? {};
  const next = {...prev, ...patch};
  const [, body] = splitNumber(current.text.passages[p]);
  const clean = body.replace(/[（(]\d+[）)]|\[\d+\]/g, '').trim();
  Object.assign(next, {doc, locale, p, n: sectionOf(current.text, p), text: clean, t: Date.now()});
  if (!next.bookmark && !next.highlight && !next.note) delete annotations[key];
  else annotations[key] = next;
  writeStore('sacerdos-annotations', annotations);
  decorate(p);
}
function decorate(p) {
  const block = document.getElementById('passage-' + p);
  if (!block || !current) return;
  const a = getAnn(current.doc.id, current.locale, p);
  block.classList.toggle('hl', Boolean(a?.highlight));
  block.classList.toggle('bm', Boolean(a?.bookmark));
  block.nextElementSibling?.classList.contains('para-note') && block.nextElementSibling.remove();
  if (a?.note) {
    const aside = element('aside', a.note, 'para-note');
    setLang(aside, current.locale);
    aside.onclick = () => openNoteEditor(p);
    block.after(aside);
  }
}

let actionPassage = null;
function openActions(p) {
  if (!current) return;
  actionPassage = p;
  const s = t(current.locale);
  const a = getAnn(current.doc.id, current.locale, p);
  el('actions-cite').textContent = citation(current.doc, current.locale, sectionOf(current.text, p));
  setLang(el('actions-cite'), current.locale);
  el('act-bookmark').textContent = a?.bookmark ? s.unbookmark : s.bookmark;
  el('act-highlight').textContent = a?.highlight ? s.unhighlight : s.highlight;
  el('act-note').textContent = a?.note ? s.editNote : s.note;
  el('actions-dialog').showModal();
}
el('actions-close').onclick = () => el('actions-dialog').close();
el('act-copy').onclick = async () => {
  const p = actionPassage;
  const part = current.text.passages[p];
  const [, body] = splitNumber(part);
  const plain = body.replace(/[（(]\d+[）)]|\[\d+\]/g, '').replace(/\s+\n/g, '\n').trim();
  const out = quoteWithCitation(plain, current.doc, current.locale, sectionOf(current.text, p));
  try { await navigator.clipboard.writeText(out); }
  catch {
    const area = element('textarea', out);
    document.body.append(area); area.select();
    try { document.execCommand('copy'); } catch {}
    area.remove();
  }
  el('actions-dialog').close();
  toast(t(current.locale).copied);
};
el('act-bookmark').onclick = () => {
  const a = getAnn(current.doc.id, current.locale, actionPassage);
  setAnn(current.doc.id, current.locale, actionPassage, {bookmark: !a?.bookmark});
  el('actions-dialog').close();
};
el('act-highlight').onclick = () => {
  const a = getAnn(current.doc.id, current.locale, actionPassage);
  setAnn(current.doc.id, current.locale, actionPassage, {highlight: !a?.highlight});
  el('actions-dialog').close();
};
el('act-note').onclick = () => {
  el('actions-dialog').close();
  openNoteEditor(actionPassage);
};
let notePassage = null;
function openNoteEditor(p) {
  notePassage = p;
  el('note-text').value = getAnn(current.doc.id, current.locale, p)?.note ?? '';
  setLang(el('note-text'), current.locale);
  el('note-editor').showModal();
  el('note-text').focus();
}
el('note-cancel').onclick = () => el('note-editor').close();
el('note-save').onclick = () => {
  setAnn(current.doc.id, current.locale, notePassage, {note: el('note-text').value.trim() || undefined});
  el('note-editor').close();
};
el('note-delete').onclick = () => {
  setAnn(current.doc.id, current.locale, notePassage, {note: undefined});
  el('note-editor').close();
};

// long-press (touch) and right-click open the paragraph actions
function attachGestures(body) {
  let timer = null;
  let start = null;
  const target = e => e.target.closest('[data-p]');
  body.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' || e.target.closest('sup button')) return;
    const block = target(e);
    if (!block) return;
    start = [e.clientX, e.clientY];
    timer = setTimeout(() => {
      timer = null;
      body.dataset.suppressClick = '1';
      if (navigator.vibrate) navigator.vibrate(10);
      openActions(Number(block.dataset.p));
    }, 550);
  });
  const cancel = () => { clearTimeout(timer); timer = null; };
  body.addEventListener('pointermove', e => {
    if (timer && start && Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 10) cancel();
  });
  body.addEventListener('pointerup', cancel);
  body.addEventListener('pointercancel', cancel);
  body.addEventListener('contextmenu', e => {
    const block = target(e);
    if (!block) return;
    e.preventDefault();
    if (!body.dataset.suppressClick) openActions(Number(block.dataset.p));
    delete body.dataset.suppressClick;
  });
  body.addEventListener('click', e => {
    if (body.dataset.suppressClick) { delete body.dataset.suppressClick; e.preventDefault(); return; }
    const num = e.target.closest('.secno');
    if (num) openActions(Number(num.closest('[data-p]').dataset.p));
  });
}

// ---------------------------------------------------------------- resume reading
let scrollTimer = null;
function trackPosition() {
  if (!current || reader.hidden) return;
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    const blocks = reader.querySelectorAll('.reader-body [data-p]');
    for (const b of blocks) {
      if (b.getBoundingClientRect().bottom > 90) {
        const p = Number(b.dataset.p);
        lastRead[current.doc.id + '|' + current.locale] = {doc: current.doc.id, locale: current.locale, p,
          n: sectionOf(current.text, p), t: Date.now()};
        writeStore('sacerdos-last-read', lastRead);
        break;
      }
    }
  }, 400);
}
addEventListener('scroll', trackPosition, {passive: true});

// ---------------------------------------------------------------- notes view
function renderNotes() {
  const s = t(uiLocale);
  const items = Object.values(annotations).sort((a, b) => a.doc.localeCompare(b.doc) || a.locale.localeCompare(b.locale) || a.p - b.p);
  const head = element('div', '', 'reader-head');
  head.append(element('p', s.saint, 'eyebrow'), element('h1', s.myNotes));
  const exportBtn = element('button', s.exportMd, 'primary');
  exportBtn.type = 'button';
  exportBtn.disabled = !items.length;
  exportBtn.onclick = () => exportMarkdown(items);
  head.append(exportBtn);
  notesView.replaceChildren(link(s.back, '#library'), head);
  if (!items.length) { notesView.append(element('p', s.noNotes, 'notice')); return; }
  let lastDoc = '';
  for (const a of items) {
    const doc = catalog.entries.find(d => d.id === a.doc);
    if (!doc) continue;
    const groupKey = a.doc + '|' + a.locale;
    if (groupKey !== lastDoc) {
      const h = element('h2', '');
      h.append(link(displayTitle(doc, a.locale), route(doc.id, a.locale)));
      h.append(element('span', ' · ' + names[a.locale], 'meta'));
      setLang(h, a.locale);
      notesView.append(h);
      lastDoc = groupKey;
    }
    const card = element('article', '', 'note-card' + (a.highlight ? ' hl' : ''));
    const cite = link((a.bookmark ? '🔖 ' : '') + citation(doc, a.locale, a.n), route(doc.id, a.locale, a.p));
    card.append(cite);
    const quote = element('blockquote', a.text.length > 400 ? a.text.slice(0, 400) + '…' : a.text);
    setLang(quote, a.locale);
    card.append(quote);
    if (a.note) { const n = element('p', a.note, 'para-note'); setLang(n, a.locale); card.append(n); }
    notesView.append(card);
  }
}
function exportMarkdown(items) {
  const s = t(uiLocale);
  const date = new Date().toISOString().slice(0, 10);
  const lines = [`# SACERDOS — ${s.myNotes}`, '', `_${date}_`, ''];
  let lastDoc = '';
  for (const a of items) {
    const doc = catalog.entries.find(d => d.id === a.doc);
    if (!doc) continue;
    if (a.doc + a.locale !== lastDoc) {
      lines.push(`## ${displayTitle(doc, a.locale)} (${names[a.locale]})`, '');
      lastDoc = a.doc + a.locale;
    }
    lines.push(`### ${citation(doc, a.locale, a.n)}`);
    const tags = [a.bookmark && '#bookmark', a.highlight && '#highlight'].filter(Boolean).join(' ');
    if (tags) lines.push(tags);
    lines.push('', ...a.text.split('\n').map(l => '> ' + l), '');
    if (a.note) lines.push(a.note, '');
  }
  const blob = new Blob([lines.join('\n')], {type: 'text/markdown'});
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `SACERDOS notes ${date}.md`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

// ---------------------------------------------------------------- reader
function renderRoute() {
  const params = new URLSearchParams(location.hash.slice(1));
  const requestedDoc = params.get('doc');
  const doc = catalog?.entries.find(item => item.id === requestedDoc);
  const locale = LOCALES.includes(params.get('lang')) ? params.get('lang') : select.value || uiLocale;
  const showNotes = location.hash === '#notes';
  const landing = !requestedDoc && location.hash !== '#library' && !showNotes;
  const library = el('library');
  const enteringLibrary = library.hidden && !landing && !doc && !showNotes;
  el('landing').hidden = !landing;
  reader.hidden = !doc;
  notesView.hidden = !showNotes;
  library.hidden = landing || Boolean(doc) || showNotes;
  if (doc && locale !== uiLocale) {
    select.value = locale;
    applyChrome(locale);
  }
  if (landing) { current = null; previousDocument = null; window.scrollTo(0, 0); return; }
  if (showNotes) { current = null; if (catalog) renderNotes(); window.scrollTo(0, 0); return; }
  if (!doc) {
    current = null;
    if (catalog) renderLibrary();
    if (enteringLibrary) el('library-title').focus({preventScroll:true});
    if (previousDocument) window.scrollTo(0, position.get(previousDocument) ?? 0);
    previousDocument = null;
    return;
  }
  const s = t(locale);
  if (hasText(doc.id, locale) && !texts[doc.id + '/' + locale]) {
    reader.replaceChildren(element('p', s.loadingLang(names[locale]), 'notice'));
    ensureLocale(locale).then(renderRoute, () => {
      reader.replaceChildren(link(s.back, '#library'), element('p', s.notOffline(names[locale]), 'notice'));
    });
    return;
  }
  if (!previousDocument) position.set(doc.id, window.scrollY);
  previousDocument = doc.id;
  const back = link(s.back, '#library');
  const head = element('div', '', 'reader-head');
  const title = element('h1', displayTitle(doc, locale));
  setLang(title, locale);
  head.append(element('p', doc.year + ' · ' + s.saint, 'eyebrow'), title);
  const sources = element('div', '', 'sources');
  const edition = doc.editions.find(item => item.locale === locale);
  if (edition?.format === 'pdf') sources.append(link(s.openPdf, edition.url));
  head.append(element('p', names[locale], 'meta'), sources);
  reader.replaceChildren(back, head);

  const other = catalog.targetContentLocales.filter(language => language !== locale && hasText(doc.id, language));
  if (other.length) {
    const options = element('div', '', 'sources');
    options.setAttribute('aria-label', s.otherEditions);
    const currentSection = params.get('s') ?? undefined;
    for (const language of other) {
      const a = link(names[language], route(doc.id, language, undefined, currentSection));
      a.lang = language;
      options.append(a);
    }
    head.append(options);
  }
  const text = texts[doc.id + '/' + locale];
  if (!text) {
    current = null;
    reader.append(element('p', s.noEdition, 'notice'));
    title.tabIndex = -1;
    title.focus({preventScroll:true});
    window.scrollTo(0, 0);
    return;
  }
  current = {doc, locale, text};
  const tr = text.translation;
  if (tr?.type === 'ai-generated') {
    const notice = element('p', s.aiNotice, 'notice');
    setLang(notice, locale);
    reader.append(notice);
  } else if ((tr?.type === 'published' || tr?.type === 'script-conversion') && s.published) {
    const lines = [s.published + tr.credit];
    if (tr.type === 'script-conversion') lines.push(s.converted);
    const notice = element('p', lines.join(' '), 'notice');
    setLang(notice, locale);
    reader.append(notice);
  }
  const notes = readingNotes(text, locale);
  const body = element('article', '', 'reader-body');
  setLang(body, locale);
  const sections = [];
  text.passages.forEach((part, i) => {
    if (repeatedTitle(doc, locale, part, i)) return;
    const [n, display] = splitNumber(part);
    const block = element(part.heading ? 'h2' : 'p', display);
    block.id = 'passage-' + i;
    block.dataset.p = i;
    notes.render(block, part, display);
    if (n !== null) {
      block.dataset.section = n;
      block.classList.add('numbered');
      const num = element('button', String(n), 'secno');
      num.type = 'button';
      num.setAttribute('aria-label', `${s.section} ${n} — ${s.actions}`);
      block.prepend(num);
      sections.push([n, i]);
    }
    body.append(block);
  });
  if (sections.length) {
    const jump = element('select', '');
    jump.setAttribute('aria-label', s.section);
    jump.append(new Option(s.section + ' …', ''));
    for (const [n] of sections) jump.append(new Option('§ ' + n, n));
    jump.onchange = () => { if (jump.value) location.hash = route(doc.id, locale, undefined, jump.value); };
    const bar = element('div', '', 'section-jump');
    bar.append(jump);
    head.append(bar);
  }
  reader.append(body);
  notes.appendTo(reader);
  attachGestures(body);
  for (const key of Object.keys(annotations)) {
    const a = annotations[key];
    if (a.doc === doc.id && a.locale === locale) decorate(a.p);
  }
  const sectionStart = sections.find(([n]) => String(n) === params.get('s'));
  const wanted = sectionStart ? sectionStart[1] : params.get('p');
  const target = wanted !== null && wanted !== undefined ? document.getElementById('passage-' + wanted) : null;
  if (target) {
    target.classList.add('match');
    target.tabIndex = -1;
    target.focus({preventScroll:true});
    target.scrollIntoView({block:'start'});
    return;
  }
  const last = lastRead[doc.id + '|' + locale];
  const resume = last && last.p > 2 ? document.getElementById('passage-' + last.p) : null;
  if (resume) {
    resume.scrollIntoView({block:'start'});
    toast(s.continueReading + (last.n ? ` · § ${last.n}` : ''));
    return;
  }
  title.tabIndex = -1;
  title.focus({preventScroll:true});
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- start
applySettings();
applyChrome(uiLocale);
addEventListener('hashchange', renderRoute);
renderRoute();

try {
  [catalog, available] = await Promise.all([load('./sacerdos-source-catalog.json'), load('./editions/index.json')]);
  select.replaceChildren(...catalog.targetContentLocales.map(locale => {
    const o = new Option(names[locale], locale);
    o.lang = locale;
    return o;
  }));
  select.value = uiLocale;
  select.addEventListener('change', () => {
    writeStore('sacerdos-language', select.value);
    applyChrome(select.value);
    renderLibrary();
  });
  query.addEventListener('input', renderLibrary);
  renderRoute();
} catch (error) {
  status.textContent = t(uiLocale).loading;
  console.error(error);
}

const updateNetwork = () => { el('offline').hidden = navigator.onLine; };
addEventListener('online', updateNetwork);
addEventListener('offline', updateNetwork);
updateNetwork();
addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  const install = el('install');
  install.hidden = false;
  install.onclick = async () => { await event.prompt(); install.hidden = true; };
});
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(console.error);
}
