// Flatline Site — a faster drop-in for makefun-site 1.0.0.
//
// Written fresh for site-generator-speed-01-run-20261122. It answers every
// case exactly as makefun-site 1.0.0 does (same output tree, byte for byte)
// but renders it with a fused single-pass Markdown renderer, bulk HTML
// escaping, an ASCII fast path for slugs, and templates compiled to plain
// JavaScript functions. Pure JavaScript, no dependencies, no network, no
// WASM, no native code, no model calls.

export function run(input) {
  return build(input);
}

// ---------------------------------------------------------------- text

const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped. */
function esc(s) {
  if (!ESC_TEST.test(s)) return s;
  return s.replace(ESC_RE, (ch) => ESC_MAP[ch]);
}

const ASCII_ONLY = /^[\x00-\x7F]*$/;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters other than a-z and 0-9 one "-", none at either end, at most 64 characters (a "-" left at the cut dropped), and "untitled" when nothing is left. */
function slugify(text) {
  let out = '';
  let gap = false;
  if (ASCII_ONLY.test(text)) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** The words of one line: its runs of characters other than whitespace. */
function countLineWords(line) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    if (isWS(line.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** The words of `lines`: their runs of characters other than whitespace (a word never spans a line). */
function countWords(lines) {
  let n = 0;
  for (const line of lines) n += countLineWords(line);
  return n;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function isDigit(c) {
  return c >= 48 && c <= 57;
}

function isLowerAlnum(c) {
  return (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      let y = 0;
      let mo = 0;
      let d = 0;
      for (let i = 0; i < 4; i++) {
        const c = raw.charCodeAt(i);
        if (!isDigit(c)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
        y = y * 10 + (c - 48);
      }
      for (let i = 5; i < 7; i++) {
        const c = raw.charCodeAt(i);
        if (!isDigit(c)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
        mo = mo * 10 + (c - 48);
      }
      for (let i = 8; i < 10; i++) {
        const c = raw.charCodeAt(i);
        if (!isDigit(c)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
        d = d * 10 + (c - 48);
      }
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = [];
      for (const p of parts) {
        const t = p.trim();
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        tags.push(t);
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!isLowerAlnum(c) && c !== 45) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      if (!isLowerAlnum(raw.charCodeAt(0))) return { error: 'key "slug": not a slug' };
      let i = 1;
      while (i < raw.length) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          i++;
          if (i >= raw.length || !isLowerAlnum(raw.charCodeAt(i))) return { error: 'key "slug": not a slug' };
          i++;
        } else if (isLowerAlnum(c)) i++;
        else return { error: 'key "slug": not a slug' };
      }
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body lines: { data, lines }, or { error } with the first reason it is refused. `text`
 * has "\n" line ends.
 */
function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    let e = raw.length;
    while (e > 0) {
      const c = raw.charCodeAt(e - 1);
      if (c === 32 || c === 9) e--;
      else break;
    }
    if (e !== raw.length) raw = raw.slice(0, e);
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, lines: lines.slice(close + 1) };
}

// ---------------------------------------------------------------- Markdown

/** A line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  const a0 = line.charCodeAt(0);
  const b0 = line.charCodeAt(line.length - 1);
  if (a0 !== 32 && a0 !== 9 && b0 !== 32 && b0 !== 9) return line;
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** Whether `line` closes a fence. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  const bm = BLOCK_RE.exec(line);
  if (bm === null) return false;
  return bm[1] !== undefined || bm[2] !== undefined || bm[4] !== undefined || bm[6] !== undefined;
}

// One native scan classifies a body line and extracts its parts — blank (1), fence (2: ```, 3: lang), heading
// (4: hashes, 5: text), thematic break (6), blockquote (7: >), bullet (8: marker), ordered item (9: digits).
// The alternatives are mutually exclusive (each needs its own first character), so one exec replaces the six
// per-line helper calls, and the branch bodies reuse the captured values instead of re-parsing the line.
// Not global: exec always starts at 0, so no shared lastIndex state.
const BLOCK_RE = /^([ \t]*)$|^(```)([A-Za-z0-9_+\-]*)[ \t]*$|^(#{1,6})[ \t]+(\S(?:[\s\S]*\S)?)[ \t]*$|^((?:---|\*\*\*)[ \t]*)$|^(>)|^(-|\*) |^([0-9]{1,9})\. /;

/** A bullet item's raw text, or null. */
function bulletOf(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's start number and raw text, or null. */
function orderedOf(line) {
  const c0 = line.charCodeAt(0);
  if (c0 < 48 || c0 > 57) return null;
  let k = 1;
  while (k < line.length && line.charCodeAt(k) >= 48 && line.charCodeAt(k) <= 57) k++;
  if (k > 9) return null;
  if (line.charCodeAt(k) !== 46 || line.charCodeAt(k + 1) !== 32) return null;
  return { start: Number(line.slice(0, k)), text: line.slice(k + 2) };
}

/** Whether a character code counts as whitespace (JavaScript's \s). */
function isWS(c) {
  return c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32 || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let r = 0;
  while (r < line.length && line.charCodeAt(r) === 32) r++;
  if (r < 2 || r >= line.length) return false;
  return !isWS(line.charCodeAt(r));
}

/** Whether a character code is one a backslash escapes. */
const ESCAPABLE_CODES = new Set([92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]);

// One backslash escape (a backslash and one of the codes above) or a closing marker: a regex scan in native code
// replaces the per-character loops. Each finder is a leaf (no recursion inside), so one shared regex per finder is
// safe: lastIndex is reset on every call. A match that starts inside [from, to) but ends past `to` is not a match
// inside the range — except a `**` straddling the end, whose first star is a single star in range.
const ESC_CLASS = '[\\\\`*_\\[\\]()#+\\-.!>]';
const STRONG_RE = new RegExp('\\\\' + ESC_CLASS + '|\\*\\*', 'g');
const BRACKET_RE = new RegExp('\\\\' + ESC_CLASS + '|\\]', 'g');
const EM_RE = new RegExp('\\\\' + ESC_CLASS + '|\\*\\*|\\*', 'g');

/** The first unescaped `**` from `from` (under `to`), or -1. */
function findStrong(s, from, to) {
  const re = STRONG_RE;
  re.lastIndex = from;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index >= to) return -1;
    if (m[0].length === 2 && m[0][0] === '\\') {
      if (m.index + 2 > to) return -1;
      continue;
    }
    if (m.index + 2 > to) return -1;
    return m.index;
  }
  return -1;
}

/** The first unescaped `]` from `from` (under `to`), or -1. */
function findCloseBracket(s, from, to) {
  const re = BRACKET_RE;
  re.lastIndex = from;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index >= to) return -1;
    if (m[0].length === 2) {
      if (m.index + 2 > to) return -1;
      continue;
    }
    return m.index;
  }
  return -1;
}

/** The first single * from `from` (under `to`, one whose run is not **), outside an escape, or -1. */
function findEm(s, from, to) {
  const re = EM_RE;
  re.lastIndex = from;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index >= to) return -1;
    if (m[0] === '**') {
      if (m.index + 2 > to) return m.index;
      continue;
    }
    if (m[0].length === 2) {
      if (m.index + 2 > to) return -1;
      continue;
    }
    return m.index;
  }
  return -1;
}

/** The first structural character (\ ` * [) at or after `i` (under `b`), or -1: one native regex scan. Shared
 * across inline() calls: lastIndex is set from `i` at the top of every loop turn, so a nested call's use of it
 * cannot disturb the outer one (its match array is a separate object). */
const STRUCT_RE = /[\\`*[]/g;

/** `s[a..b)` rendered inline into `out`; `link(target)` is a link's href. */
function inline(s, link, out, a, b) {
  let i = a;
  let run = a;
  for (;;) {
    STRUCT_RE.lastIndex = i;
    const mx = STRUCT_RE.exec(s);
    if (mx === null || mx.index >= b) break;
    const m = mx.index;
    const c = s.charCodeAt(m);
    if (c === 92) {
      if (m + 1 < b && ESCAPABLE_CODES.has(s.charCodeAt(m + 1))) {
        if (m > run) out.push(esc(s.slice(run, m)));
        out.push(s[m + 1]);
        i = m + 2;
        run = i;
      } else i = m + 1;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', m + 1);
      if (j !== -1 && j < b && j > m + 1) {
        if (m > run) out.push(esc(s.slice(run, m)));
        out.push('<code>');
        out.push(esc(s.slice(m + 1, j)));
        out.push('</code>');
        i = j + 1;
        run = i;
      } else i = m + 1;
      continue;
    }
    if (c === 42) {
      if (m + 1 < b && s.charCodeAt(m + 1) === 42) {
        const j = findStrong(s, m + 2, b);
        if (j > m + 2) {
          if (m > run) out.push(esc(s.slice(run, m)));
          out.push('<strong>');
          inline(s, link, out, m + 2, j);
          out.push('</strong>');
          i = j + 2;
          run = i;
        } else i = m + 2;
      } else {
        const j = findEm(s, m + 1, b);
        if (j > m + 1) {
          if (m > run) out.push(esc(s.slice(run, m)));
          out.push('<em>');
          inline(s, link, out, m + 1, j);
          out.push('</em>');
          i = j + 1;
          run = i;
        } else i = m + 1;
      }
      continue;
    }
    const k = findCloseBracket(s, m + 1, b);
    let mm = -1;
    if (k !== -1 && k + 1 < b && s.charCodeAt(k + 1) === 40) {
      const q = s.indexOf(')', k + 2);
      if (q !== -1 && q < b) mm = q;
    }
    const target = mm === -1 ? '' : s.slice(k + 2, mm);
    let hasWS = false;
    for (let q = 0; q < target.length; q++) {
      if (isWS(target.charCodeAt(q))) {
        hasWS = true;
        break;
      }
    }
    if (target !== '' && !hasWS) {
      if (m > run) out.push(esc(s.slice(run, m)));
      out.push('<a href="');
      out.push(esc(link(target)));
      out.push('">');
      inline(s, link, out, m + 1, k);
      out.push('</a>');
      i = mm + 1;
      run = i;
    } else i = m + 1;
  }
  if (b > run) out.push(esc(s.slice(run, b)));
}

/** Render `text` (one inline run) to a string. */
function inlineStr(s, link) {
  const out = [];
  inline(s, link, out, 0, s.length);
  return out.join('');
}

/**
 * `lines` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(lines, link) {
  const n = lines.length;
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let wc = 0;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (line.length === 0) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    // Fast paths that need no regex: a line starting with anything but a block-start character is a paragraph,
    // '>' is always a blockquote, and a space/tab start is blank or a paragraph.
    if (c0 !== 32 && c0 !== 9 && c0 !== 96 && c0 !== 35 && c0 !== 45 && c0 !== 42 && c0 !== 62 && !(c0 >= 48 && c0 <= 57)) {
      const body = [trimLine(line)];
      wc += countLineWords(line);
      i++;
      while (i < n && !endsParagraph(lines[i])) {
        wc += countLineWords(lines[i]);
        body.push(trimLine(lines[i++]));
      }
      const html = inlineStr(body.join('\n'), link);
      if (excerpt === null) excerpt = html;
      out.push('<p>' + html + '</p>\n');
      continue;
    }
    if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        wc += countLineWords(lines[i]);
        let l = lines[i++].slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        l = trimLine(l);
        if (l !== '') body.push(l);
      }
      if (body.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else out.push('<blockquote>\n<p>' + inlineStr(body.join('\n'), link) + '</p>\n</blockquote>\n');
      continue;
    }
    if (c0 === 32 || c0 === 9) {
      if (isBlank(line)) {
        i++;
        continue;
      }
      const body = [trimLine(line)];
      wc += countLineWords(line);
      i++;
      while (i < n && !endsParagraph(lines[i])) {
        wc += countLineWords(lines[i]);
        body.push(trimLine(lines[i++]));
      }
      const html = inlineStr(body.join('\n'), link);
      if (excerpt === null) excerpt = html;
      out.push('<p>' + html + '</p>\n');
      continue;
    }
    const bm = BLOCK_RE.exec(line);
    if (bm !== null && bm[2] !== undefined) {
      const lang = bm[3];
      wc += countLineWords(line);
      i++;
      const body = [];
      while (i < n && !fenceClose(lines[i])) {
        wc += countLineWords(lines[i]);
        body.push(lines[i++]);
      }
      if (i < n) wc += countLineWords(lines[i]);
      i++;
      out.push('<pre><code' + (lang === '' ? '' : ' class="language-' + lang + '"') + '>');
      if (body.length > 0) {
        out.push(esc(body.join('\n')));
        out.push('\n');
      }
      out.push('</code></pre>\n');
      continue;
    }
    if (bm !== null && bm[4] !== undefined) {
      wc += countLineWords(line);
      const depth = bm[4].length;
      const text = bm[5];
      const id = uniqueSlug(slugify(text), ids);
      const html = inlineStr(text, link);
      out.push('<h' + depth + ' id="' + id + '">' + html + '</h' + depth + '>\n');
      if (depth === 2 || depth === 3) toc.push({ level: depth, id, html });
      i++;
      continue;
    }
    if (bm !== null && bm[6] !== undefined) {
      wc += countLineWords(line);
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (bm !== null && (bm[8] !== undefined || bm[9] !== undefined)) {
      const isOrdered = bm[9] !== undefined;
      const oStart = isOrdered ? Number(bm[9]) : 1;
      const items = [];
      while (i < n) {
        const l = lines[i];
        if (isOrdered) {
          const m = orderedOf(l);
          if (m !== null) {
            wc += countLineWords(l);
            items.push([trimLine(m.text)]);
            i++;
            continue;
          }
        } else {
          const m = bulletOf(l);
          if (m !== null) {
            wc += countLineWords(l);
            items.push([trimLine(m)]);
            i++;
            continue;
          }
        }
        if (isContinued(l)) {
          wc += countLineWords(l);
          items[items.length - 1].push(trimLine(l));
          i++;
          continue;
        }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      out.push(isOrdered && oStart !== 1 ? '<ol start="' + oStart + '">\n' : '<' + tag + '>\n');
      for (const parts of items) out.push('<li>' + inlineStr(parts.join('\n'), link) + '</li>\n');
      out.push('</' + tag + '>\n');
      continue;
    }
    const body = [trimLine(line)];
    wc += countLineWords(line);
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      wc += countLineWords(lines[i]);
      body.push(trimLine(lines[i++]));
    }
    const html = inlineStr(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    out.push('<p>' + html + '</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt === null ? '' : excerpt, words: wc };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `s` holds only spaces and tabs. */
function onlySpaces(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlySpaces(src.slice(lineStart, open)) && onlySpaces(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { k: 'root', b: [] };
  const stack = [root];
  let body = root.b;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ k: 'text', x: tok.text });
    else if (tok.t === 'var') body.push({ k: 'var', p: tok.path });
    else if (tok.t === 'raw') body.push({ k: 'raw', p: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { k: 'for', n: m[1], p: pathOf(name, m[2]), b: [] };
        body.push(node);
        stack.push(node);
        body = node.b;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { k: 'if', not: m[1] !== undefined, p: pathOf(name, m[2]), t: [], e: null };
        body.push(node);
        stack.push(node);
        body = node.t;
      } else if (tag === 'else') {
        if (top.k !== 'if' || top.e !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.e = [];
        body = top.e;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.k !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.k === 'root' ? parent.b : parent.k === 'for' ? parent.b : parent.e !== null ? parent.e : parent.t;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ k: 'include', n: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].k} is not closed`);
  return root.b;
}

const HOP = Object.hasOwn;

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function LK(s, p) {
  let sc = s;
  while (sc !== null && !HOP(sc.vars, p[0])) sc = sc.parent;
  if (sc === null) return undefined;
  let v = sc.vars[p[0]];
  for (let k = 1; k < p.length; k++) {
    if (v === null || typeof v !== 'object' || !HOP(v, p[k])) return undefined;
    v = v[p[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function TX(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(TX).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function TR(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * A parsed template compiled to a plain function (S, C, D, O, LK, TR, TX):
 * S the scope chain ({ vars, parent }), C the context ({ T: compiled templates, E: escape }),
 * D the include depth, O the output array the rendering is pushed into.
 * Lookup paths are hoisted to one constant each (no array built per lookup), and a for loop reuses one frame
 * and one loop record, mutated per item, instead of building both per item: templates render synchronously,
 * so nothing reads a previous item's frame after its iteration.
 */
function compileTemplate(nodes) {
  let uid = 0;
  const paths = new Map();
  const pathId = (p) => {
    const key = JSON.stringify(p);
    let id = paths.get(key);
    if (id === undefined) {
      id = '__p' + paths.size;
      paths.set(key, id);
    }
    return id;
  };
  const collect = (list) => {
    for (const nd of list) {
      if (nd.k === 'var' || nd.k === 'raw' || nd.k === 'if' || nd.k === 'for') pathId(nd.p);
      if (nd.k === 'for') collect(nd.b);
      else if (nd.k === 'if') {
        collect(nd.t);
        if (nd.e !== null) collect(nd.e);
      }
    }
  };
  collect(nodes);
  let head = '';
  for (const [key, id] of paths) head += 'const ' + id + '=' + key + ';';
  const gen = (list, scope) => {
    let code = '';
    for (const nd of list) {
      if (nd.k === 'text') code += 'O.push(' + JSON.stringify(nd.x) + ');';
      else if (nd.k === 'var') code += 'O.push(C.E(TX(LK(' + scope + ',' + pathId(nd.p) + '))));';
      else if (nd.k === 'raw') code += 'O.push(TX(LK(' + scope + ',' + pathId(nd.p) + ')));';
      else if (nd.k === 'if') {
        code += 'if(TR(LK(' + scope + ',' + pathId(nd.p) + '))!==' + nd.not + '){' + gen(nd.t, scope) + '}';
        if (nd.e !== null) code += 'else{' + gen(nd.e, scope) + '}';
      } else if (nd.k === 'for') {
        const xs = 'a' + uid++;
        const fr = 'f' + uid++;
        const sc = 's' + uid++;
        const ix = 'i' + uid++;
        const it = 'x' + uid++;
        code += '{const ' + xs + '=LK(' + scope + ',' + pathId(nd.p) + ');';
        code += 'if(Array.isArray(' + xs + ')){const ' + fr + '={};' + fr + '.loop={};const ' + sc + '={vars:' + fr + ',parent:' + scope + '};';
        code += 'for(let ' + ix + '=0;' + ix + '<' + xs + '.length;' + ix + '++){const ' + it + '=' + xs + '[' + ix + '];';
        code += fr + '[' + JSON.stringify(nd.n) + ']=' + it + ';';
        code += fr + '.loop.index=' + ix + '+1;' + fr + '.loop.first=' + ix + '===0;' + fr + '.loop.last=' + ix + '===' + xs + '.length-1;' + fr + '.loop.length=' + xs + '.length;';
        code += gen(nd.b, sc);
        code += '}}}';
      } else if (nd.k === 'include') {
        code += 'if(D<8){const __t=C.T.get(' + JSON.stringify(nd.n) + ');if(__t!==undefined)__t(' + scope + ',C,D+1,O,LK,TR,TX);}';
      }
    }
    return code;
  };
  return new Function('S', 'C', 'D', 'O', 'LK', 'TR', 'TX', head + gen(nodes, 'S'));
}

// Compiled templates are a pure function of their source, so one cache serves every case.
const TEMPLATE_CACHE = new Map();

function getTemplate(name, source) {
  let fn = TEMPLATE_CACHE.get(source);
  if (fn === undefined) {
    fn = compileTemplate(parseTemplate(name, source));
    TEMPLATE_CACHE.set(source, fn);
  }
  return fn;
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** A page's link record as templates read it. */
function linkOf(s) {
  return s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

/** One site's output tree: path -> text. */
function build(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, getTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.lines = fm.lines;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const targets = new Map();
  for (const s of kept) targets.set(s.path, s.url);
  for (const f of statics) targets.set(f.path, `${base}/${f.path}`);
  const resolvedByDir = new Map();
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const linkCache = new Map();
    const link = (target) => {
      let href = linkCache.get(target);
      if (href === undefined) {
        href = computeLink(target);
        linkCache.set(target, href);
      }
      return href;
    };
    const computeLink = (target) => {
      const c0 = target.charCodeAt(0);
      if (c0 === 47 || c0 === 35) return target;
      const ci = target.indexOf(':');
      if (ci > 0) {
        const si = target.indexOf('/');
        if (si === -1 || ci < si) {
          const a = target.charCodeAt(0);
          let ok = (a >= 65 && a <= 90) || (a >= 97 && a <= 122);
          for (let k = 1; ok && k < ci; k++) {
            const c = target.charCodeAt(k);
            if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) ok = false;
          }
          if (ok) return target;
        }
      }
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      let byRel = resolvedByDir.get(dir);
      if (byRel === undefined) {
        byRel = new Map();
        resolvedByDir.set(dir, byRel);
      }
      let path = byRel.get(rel);
      if (path === undefined) {
        path = resolvePath(dir, rel);
        byRel.set(rel, path);
      }
      if (path !== null) {
        const u = targets.get(path);
        if (u !== undefined) return u + frag;
      }
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.lines, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const tagSlugCache = new Map();
  const tagSlug = (name) => {
    let sl = tagSlugCache.get(name);
    if (sl === undefined) {
      sl = slugify(name);
      tagSlugCache.set(name, sl);
    }
    return sl;
  };
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = tagSlug(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = tagSlug(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(tagSlug(name)) ?? { name, slug: tagSlug(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // A post's card, as lists show it (built once per page and reused by every list and page that shows it).
  const cards = new Map();
  const cardOf = (s) => {
    let c = cards.get(s);
    if (c === undefined) {
      c = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil((s.words ?? countWords(s.lines)) / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
      cards.set(s, c);
    }
    return c;
  };

  /** A page as its layout reads it. */
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  const ctx = { T: templates, E: esc };
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const out = [];
    fn({ vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out, LK, TR, TX);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (const s of kept) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
