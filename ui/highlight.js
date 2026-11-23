// ---------- Small, dependency-free syntax highlighter (token scanner) ----------
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const NUMBER_RE = /(?:0[xX][0-9a-fA-F_']+|0[bB][01_']+|(?:\d[\d_']*\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)[uUlLfFdDzZ]*/y;

function highlightCode(src, langId) {
  const cfg = LANGUAGES[langId].hl;
  const n = src.length;
  let out = '';
  let plain = '';
  let i = 0;
  let lineStart = true; // only whitespace so far on this line (for C preprocessor lines)

  const flush = () => { if (plain) { out += escapeHtml(plain); plain = ''; } };
  const emit = (cls, text) => { flush(); out += `<span class="tok-${cls}">${escapeHtml(text)}</span>`; };

  const readString = (start, quote, multiline) => {
    let j = start + quote.length;
    while (j < n) {
      const ch = src[j];
      if (ch === '\\') { j += 2; continue; }
      if (src.startsWith(quote, j)) return j + quote.length;
      if (ch === '\n' && !multiline) return j;
      j++;
    }
    return n;
  };

  while (i < n) {
    const c = src[i];

    if (c === '\n') { plain += c; i++; lineStart = true; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { plain += c; i++; continue; }

    // Comments
    if (cfg.block && src.startsWith(cfg.block[0], i)) {
      const end = src.indexOf(cfg.block[1], i + cfg.block[0].length);
      const stop = end < 0 ? n : end + cfg.block[1].length;
      emit('c', src.slice(i, stop)); i = stop; lineStart = false; continue;
    }
    if (cfg.line && src.startsWith(cfg.line, i)) {
      let stop = src.indexOf('\n', i); if (stop < 0) stop = n;
      emit('c', src.slice(i, stop)); i = stop; continue;
    }

    // C / C++ preprocessor lines (#include, #define, ...), honouring backslash continuations
    if (cfg.preprocessor && c === '#' && lineStart) {
      let j = i;
      while (j < n) {
        const nl = src.indexOf('\n', j);
        if (nl < 0) { j = n; break; }
        if (src[nl - 1] === '\\' || (src[nl - 1] === '\r' && src[nl - 2] === '\\')) { j = nl + 1; continue; }
        j = nl; break;
      }
      const lineText = src.slice(i, j);
      const cm = /\/\/.*$/.exec(lineText);
      if (cm) { emit('p', lineText.slice(0, cm.index)); emit('c', cm[0]); } else emit('p', lineText);
      i = j; continue;
    }

    // Strings
    if (langId === 'python' || cfg.tripleQuotes) {
      if (c === '"' || c === "'") {
        const triple = c.repeat(3);
        if (src.startsWith(triple, i)) { const stop = readString(i, triple, true); emit('s', src.slice(i, stop)); i = stop; lineStart = false; continue; }
      }
    }
    if (cfg.textBlock && src.startsWith(cfg.textBlock, i)) {
      const stop = readString(i, cfg.textBlock, true); emit('s', src.slice(i, stop)); i = stop; lineStart = false; continue;
    }
    if (cfg.strings.includes(c)) {
      const stop = readString(i, c, c === '`');
      emit('s', src.slice(i, stop)); i = stop; lineStart = false; continue;
    }

    // Annotations / decorators
    if ((cfg.annotations || cfg.decorators) && c === '@' && IDENT_START.test(src[i + 1] || '')) {
      let j = i + 1; while (j < n && (IDENT_PART.test(src[j]) || src[j] === '.')) j++;
      emit('p', src.slice(i, j)); i = j; lineStart = false; continue;
    }

    // Numbers
    if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      NUMBER_RE.lastIndex = i;
      const m = NUMBER_RE.exec(src);
      if (m) { emit('n', m[0]); i += m[0].length; lineStart = false; continue; }
    }

    // Identifiers and keywords
    if (IDENT_START.test(c)) {
      let j = i + 1; while (j < n && IDENT_PART.test(src[j])) j++;
      const word = src.slice(i, j);
      let k = j; while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
      let cls = '';
      if (cfg.kw.has(word)) cls = word === 'self' || word === 'cls' ? 'p' : 'k';
      else if (cfg.types.has(word)) cls = 't';
      else if (src[k] === '(') cls = 'f';
      else if (cfg.capitalTypes && /^[A-Z][A-Za-z0-9_]*$/.test(word) && !/^[A-Z0-9_]+$/.test(word)) cls = 't';
      else if (cfg.capitalTypes && /^[A-Z][A-Z0-9_]+$/.test(word)) cls = 'n';
      if (cls) emit(cls, word); else plain += word;
      i = j; lineStart = false; continue;
    }

    plain += c; i++; lineStart = false;
  }
  flush();
  return `${out}\n`;
}
