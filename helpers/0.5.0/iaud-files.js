// iaud-files: reading the zakázka's Soubory (#23). Claude passes this whole file
// to the browser's JavaScript tool after references/iaud.js; it extends
// window.iaud (same version only) and evaluates to "iaud-files <version> loaded,
// délka <n>, hash <h>". A file is fetched at once from its 300 s link (V5) and
// read in the page (DOCX, XLSX, text PDF, TXT/CSV); what can't be read exactly
// (scans, fonts without a Unicode map, images) is said, never guessed.
// Changes to Soubory are in iaud-filewrite.js.
(function installFiles(root) {
  'use strict';

  var VERSION = '0.5.0';
  var NAME = 'iaud-files';

  var isModule = typeof module === 'object' && module.exports;
  var iaud = isModule ? require('./iaud.js') : root.iaud;
  if (!iaud || !iaud._internal) {
    return NAME + ': nejdřív je potřeba načíst iaud.js (verze ' + VERSION + ').';
  }
  if (iaud.version !== VERSION) {
    return NAME + ' ' + VERSION + ': načtené iaud.js je jiné verze (' + iaud.version + '). Načtěte znovu všechny soubory.';
  }
  var core = iaud._internal;
  var NL = String.fromCharCode(10);
  var BS = String.fromCharCode(92);
  var BAD = String.fromCharCode(0xfffd);

  // A longer read comes back as pending (Cowork's JS tool stops at about 45 s, V5).
  iaud.readWaitMs = 30000;

  var MAX_SLICE = 50000;
  var DEFAULT_SLICE = 15000;
  var MAX_REFERENCE_FILES = 30;
  var MAX_HITS = 20;

  var TYPES = {
    'application/pdf': { label: 'PDF', read: readPdf },
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { label: 'Word (DOCX)', read: readDocx },
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { label: 'Excel (XLSX)', read: readXlsx },
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': { label: 'PowerPoint (PPTX)' },
    'application/vnd.oasis.opendocument.text': { label: 'OpenDocument (ODT)' },
    'text/csv': { label: 'CSV', read: readText },
    'text/plain': { label: 'Text', read: readText },
    'image/png': { label: 'Obrázek (PNG)' },
    'image/jpeg': { label: 'Obrázek (JPEG)' },
    'image/tiff': { label: 'Obrázek (TIFF)' },
    'image/heic': { label: 'Obrázek (HEIC)' },
    'image/heif': { label: 'Obrázek (HEIF)' },
  };

  var FOLDER = 'Stáhněte si ho prosím z iAuditingu (Soubory → soubor → Stáhnout) a uložte do pracovní složky; ' +
    'pak ho přečtu jako ostatní dokumenty ve složce.';

  function fail(code, message) { return core.apiError(code, message); }

  function loose(text) { return String(text || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase(); }

  function sizeLabel(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return Math.round(n / 1024) + ' kB';
    return (Math.round(n / 104857.6) / 10).toString().replace('.', ',') + ' MB';
  }

  // -- the zakázka and its files

  // Reading a file needs a role on the zakázka (PLAN §5: the user's own engagements).
  function openForRead(engagement) {
    return core.findAudit(engagement).then(function (a) {
      return core.auditRole(a.auditId).then(function (role) {
        if (!role) throw fail('NO_ROLE', 'Na zakázce ' + core.auditLabel(a) + ' nemáte roli, takže její soubory nečtu.');
        return a;
      });
    });
  }

  function docsBase(audit) { return 'audits/audit/' + audit.auditId + '/documents'; }

  function documents(audit) {
    return core.apiGet(docsBase(audit) + '/list').then(function (list) {
      return (list || []).filter(function (d) { return d.status === 'active'; });
    });
  }

  // The file by its storageId or by (part of) its name, if only one fits.
  function pickFile(docs, file) {
    var id = String(file || '').trim();
    var byId = docs.filter(function (d) { return d.storageId === id; });
    if (byId.length) return byId[0];
    var key = loose(file);
    var exact = docs.filter(function (d) { return key && loose(d.name) === key; });
    var hits = exact.length ? exact : docs.filter(function (d) { return key && loose(d.name).indexOf(key) !== -1; });
    if (hits.length === 1) return hits[0];
    if (!hits.length) throw fail('NOT_FOUND', 'Soubor „' + file + '“ v Souborech zakázky není.');
    throw fail('AMBIGUOUS', 'Názvu „' + file + '“ odpovídá víc souborů: ' + hits.map(function (d) { return d.name; }).join(', ') +
      '. Který myslíte?');
  }

  function typeOf(d) { return TYPES[d.mimetype] || { label: d.mimetype }; }

  // Where a file is attached: procedure and question (no people, no answers).
  function attachedTo(refs, audit) {
    return ((refs && refs.forms) || []).filter(function (f) { return !f.auditId || f.auditId === audit.auditId; }).map(function (f) {
      var t = f.template || {};
      return { procedure: core.procedureNumber(f.displayId || t.displayId), name: f.name || t.name,
        questionId: f.questionId, sectionId: f.sectionId === undefined ? null : f.sectionId };
    });
  }

  function publicFile(d, refs, audit) {
    var t = typeOf(d);
    var out = { storageId: d.storageId, name: d.name, type: t.label, size: d.size, sizeLabel: sizeLabel(d.size || 0),
      uploaded: String(d.createdAt || '').slice(0, 10), readable: Boolean(t.read) };
    if (refs) {
      out.attachedTo = attachedTo(refs, audit);
      if (refs.standardAccounts && refs.standardAccounts.length) out.usedInImports = refs.standardAccounts.length;
    }
    return out;
  }

  // The zakázka's Soubory: name, type, size, date and where each is attached.
  function listFiles(engagement) {
    var audit;
    var docs;
    return core.findAudit(engagement).then(function (a) {
      audit = a;
      return documents(a);
    }).then(function (list) {
      docs = list;
      return Promise.all(docs.map(function (d, i) {
        if (i >= MAX_REFERENCE_FILES) return null;
        return core.apiGet(docsBase(audit) + '/' + d.storageId + '/references');
      }));
    }).then(function (refs) {
      var out = { auditId: audit.auditId, client: audit.client && audit.client.name, year: audit.year, count: docs.length,
        files: docs.map(function (d, i) { return publicFile(d, refs[i], audit); }) };
      if (docs.length > MAX_REFERENCE_FILES) {
        out.referencesNote = 'U souborů za prvními ' + MAX_REFERENCE_FILES + ' jsem nezjišťoval, ke kterým otázkám jsou připojené.';
      }
      return out;
    });
  }

  // -- download and read in the page

  function download(audit, d) {
    return core.apiGet(docsBase(audit) + '/' + d.storageId + '/download').then(function (link) {
      return fetch(link.downloadUrl).catch(function () {
        throw fail('NETWORK', 'Soubor „' + d.name + '“ se nepodařilo stáhnout z úložiště iAuditingu.');
      });
    }).then(function (r) {
      if (!r.ok) throw fail('DOWNLOAD', 'Úložiště iAuditingu soubor „' + d.name + '“ nevydalo (HTTP ' + r.status + ').');
      return r.arrayBuffer();
    }).then(function (buf) { return new Uint8Array(buf); });
  }

  // A reader's lines: group (a heading "--- strana 2 ---") and place ("strana 2").
  function sink() {
    var out = { lines: [], warnings: [] };
    out.emit = function (group, where, text) { out.lines.push({ group: group, where: where, text: text }); };
    return out;
  }

  function joined(lines) {
    var parts = [];
    var group = null;
    lines.forEach(function (l) {
      if (l.group !== group) { group = l.group; parts.push('--- ' + group + ' ---'); }
      parts.push(l.text);
    });
    return parts.join(NL);
  }

  var cache = {};

  function cacheKey(d) { return d.storageId + '|' + d.size + '|' + d.updatedAt; }

  // The whole read of one file, done once per page and kept for slices and searches.
  function loaded(audit, d) {
    var key = cacheKey(d);
    if (cache[key]) return cache[key];
    var t = typeOf(d);
    var entry = { done: false };
    entry.promise = (t.read ? download(audit, d).then(function (bytes) {
      if (bytes.length !== d.size) throw fail('DOWNLOAD', 'Stažený soubor „' + d.name + '“ má jinou velikost než v Souborech.');
      return t.read(bytes);
    }) : Promise.resolve({ unreadable: t.label + ' v prohlížeči nepřečtu (je to obrázek nebo nepodporovaný formát)' }))
      .then(function (res) {
        res.text = res.unreadable ? null : joined(res.lines);
        entry.done = true;
        entry.result = res;
        return res;
      }, function (err) {
        delete cache[key];
        throw err;
      });
    cache[key] = entry;
    return entry;
  }

  var PENDING = {};

  // Waits for the read at most iaud.readWaitMs.
  function settled(entry) {
    if (entry.done) return Promise.resolve(entry.result);
    var timer;
    var late = new Promise(function (resolve) { timer = setTimeout(function () { resolve(PENDING); }, iaud.readWaitMs); });
    var stop = function () { clearTimeout(timer); };
    entry.promise.then(stop, stop);
    return Promise.race([entry.promise, late]);
  }

  // Opens one file, waits for its read and hands fn the result (pending and
  // unreadable files are answered here).
  function withFile(engagement, file, fn) {
    var audit;
    return openForRead(engagement).then(function (a) {
      audit = a;
      return documents(a);
    }).then(function (docs) {
      var d = pickFile(docs, file);
      return settled(loaded(audit, d)).then(function (res) {
        var out = publicFile(d);
        if (res === PENDING) {
          out.pending = true;
          out.message = 'Soubor „' + d.name + '“ se ještě čte. Zavolejte stejnou funkci znovu za chvíli; výsledek zůstává v prohlížeči.';
          return out;
        }
        out.warnings = res.warnings || [];
        if (!res.unreadable) return fn(out, res);
        out.unreadable = res.unreadable;
        out.needsFolder = true;
        out.message = 'Soubor „' + d.name + '“ neumím přečíst přímo v iAuditingu: ' + res.unreadable + '. ' + FOLDER;
        return out;
      });
    });
  }

  // Reads one file of the zakázka's Soubory (storageId or name) in the page.
  // {from, length} give a slice of the text (default the first 15 000 chars);
  // a long read returns {pending: true}: call again later for the result.
  function readFile(engagement, file, options) {
    options = options || {};
    return withFile(engagement, file, function (out, res) {
      ['pages', 'sheets', 'note', 'needsFolderPages'].forEach(function (k) { if (res[k] !== undefined) out[k] = res[k]; });
      var from = Math.max(0, Number(options.from) || 0);
      var length = Math.min(MAX_SLICE, Math.max(1, Number(options.length) || DEFAULT_SLICE));
      out.chars = res.text.length;
      out.from = from;
      out.text = res.text.slice(from, from + length);
      out.more = from + length < res.text.length;
      if (out.more) out.nextFrom = from + length;
      return out;
    });
  }

  // Finds a text in one file (no case), each hit with its place ("strana 2", "list X, ř. 5").
  function findInFile(engagement, file, text) {
    var key = loose(text);
    if (!key) return Promise.reject(fail('BAD_QUERY', 'Napište prosím, co mám v souboru hledat.'));
    return withFile(engagement, file, function (out, res) {
      var hits = res.lines.filter(function (l) { return loose(l.text).indexOf(key) !== -1; });
      out.query = text;
      out.count = hits.length;
      out.hits = hits.slice(0, MAX_HITS).map(function (l) { return { where: l.where, text: l.text.slice(0, 500) }; });
      if (hits.length > MAX_HITS) out.more = 'Zásahů je ' + hits.length + '; ukazuji prvních ' + MAX_HITS + '.';
      return out;
    });
  }

  // -- ZIP and XML (DOCX, XLSX)

  function inflate(bytes, format) {
    return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format))).arrayBuffer()
      .then(function (buf) { return new Uint8Array(buf); });
  }

  function u16(b, i) { return b[i] | (b[i + 1] << 8); }
  function u32(b, i) { return u16(b, i) + u16(b, i + 2) * 65536; }
  function utf8(b) { return new TextDecoder('utf-8').decode(b); }

  // {names, text(name)}: the entries of a ZIP, read from its central directory.
  function unzip(b) {
    var end = -1;
    for (var i = b.length - 22; i >= 0 && i >= b.length - 65557; i--) {
      if (u32(b, i) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw fail('BAD_FILE', 'soubor není platný balík Office (ZIP)');
    var entries = {};
    var at = u32(b, end + 16);
    for (var n = u16(b, end + 10); n > 0 && u32(b, at) === 0x02014b50; n--) {
      var nameLength = u16(b, at + 28);
      var name = utf8(b.subarray(at + 46, at + 46 + nameLength));
      entries[name] = { method: u16(b, at + 10), size: u32(b, at + 20), offset: u32(b, at + 42) };
      at += 46 + nameLength + u16(b, at + 30) + u16(b, at + 32);
    }
    return {
      names: Object.keys(entries),
      text: function (entryName) {
        var e = entries[entryName];
        if (!e) return Promise.resolve(null);
        var start = e.offset + 30 + u16(b, e.offset + 26) + u16(b, e.offset + 28);
        var data = b.subarray(start, start + e.size);
        if (e.method === 0) return Promise.resolve(utf8(data));
        if (e.method !== 8) return Promise.reject(fail('BAD_FILE', 'neznámá komprese v souboru'));
        return inflate(data, 'deflate-raw').then(function (raw) { return utf8(raw); });
      },
    };
  }

  var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: String.fromCharCode(34), apos: "'" };
  function entities(text) {
    return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, function (all, e) {
      if (e.charAt(0) !== '#') return ENTITIES[e];
      return String.fromCodePoint(e.charAt(1) === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    });
  }

  // A small XML walker: fn('open' | 'close' | 'text', name, attrs, selfClosing).
  function walk(xml, fn) {
    var re = /<([/]?)([A-Za-z_][^\s/>]*)([^>]*?)([/]?)>|<!\[CDATA\[([^]*?)\]\]>|<[!?][^>]*>|([^<]+)/g;
    var m;
    while ((m = re.exec(xml))) {
      if (m[6] !== undefined) fn('text', null, entities(m[6]));
      else if (m[5] !== undefined) fn('text', null, m[5]);
      else if (m[2]) {
        if (m[1]) fn('close', m[2], '');
        else {
          fn('open', m[2], m[3], Boolean(m[4]));
          if (m[4]) fn('close', m[2], '');
        }
      }
    }
  }

  function attr(attrs, name) {
    var m = new RegExp('(?:^|\\s)' + name.replace(':', '[:]') + '=["\']([^"\']*)["\']').exec(attrs || '');
    return m ? entities(m[1]) : null;
  }

  // -- DOCX

  var DOCX_MARKS = { ins: 'vloženo', del: 'smazáno', hidden: 'skrytý text' };

  function docxPart(xml, group, out, stats) {
    var ins = 0;
    var del = 0;
    var inT = false;
    var run = null;
    var segments = [];
    var table = 0;
    var tableNo = 0;
    var rowNo = 0;
    var cells = null;
    var cell = null;
    var paragraphs = 0;
    var render = function () {
      var text = segments.map(function (s) { return s.mark ? '[' + DOCX_MARKS[s.mark] + ': ' + s.text + ']' : s.text; }).join('');
      segments = [];
      return text.trim();
    };
    var add = function (text) {
      var mark = del ? 'del' : run && run.hidden ? 'hidden' : ins ? 'ins' : null;
      var last = segments[segments.length - 1];
      if (last && last.mark === mark) last.text += text;
      else {
        segments.push({ mark: mark, text: text });
        if (mark) stats[mark]++;
      }
    };
    walk(xml, function (kind, name, value, selfClosing) {
      if (kind === 'text') { if (inT) add(value); return; }
      var open = kind === 'open';
      if (name === 'w:t' || name === 'w:delText') inT = open && !selfClosing;
      else if (name === 'w:r') run = open ? { hidden: false } : null;
      else if (name === 'w:vanish' && open && run) run.hidden = attr(value, 'w:val') !== '0' && attr(value, 'w:val') !== 'false';
      else if ((name === 'w:tab' || name === 'w:br' || name === 'w:cr') && open && run) add(name === 'w:tab' ? ' ' : NL);
      else if ((name === 'w:ins' || name === 'w:del') && !selfClosing) {
        var step = open ? 1 : -1;
        if (name === 'w:ins') ins += step; else del += step;
      } else if (name === 'w:tbl') {
        table += open ? 1 : -1;
        if (open && table === 1) { tableNo++; rowNo = 0; }
      } else if (name === 'w:tr' && table === 1) {
        if (open) { cells = []; rowNo++; } else if (cells) {
          if (cells.some(function (c) { return c; })) {
            out.emit(group, group + ', tabulka ' + tableNo + ', ř. ' + rowNo, cells.join(' | '));
          }
          cells = null;
        }
      } else if (name === 'w:tc' && table === 1) {
        if (open) cell = ''; else if (cells) { cells.push(cell); cell = null; }
      } else if (name === 'w:p' && !open) {
        var text = render();
        if (table && cell !== null) cell += (cell && text ? ' ' : '') + text;
        else if (text) out.emit(group, group + ', odst. ' + (++paragraphs), text);
      }
    });
  }

  function readDocx(bytes) {
    var z = unzip(bytes);
    var named = function (re, label) {
      return z.names.filter(function (n) { return re.test(n); }).sort().map(function (n) { return [n, label]; });
    };
    var parts = [['word/document.xml', 'dokument']].concat(named(/^word[/]header[0-9]*[.]xml$/, 'záhlaví'),
      named(/^word[/]footer[0-9]*[.]xml$/, 'zápatí'), [['word/footnotes.xml', 'poznámky pod čarou'], ['word/comments.xml', 'komentáře']]);
    var out = sink();
    var stats = { ins: 0, del: 0, hidden: 0 };
    return parts.reduce(function (done, part) {
      return done.then(function () { return z.text(part[0]); }).then(function (xml) {
        if (xml) docxPart(xml, part[1], out, stats);
      });
    }, Promise.resolve()).then(function () {
      if (stats.ins || stats.del) {
        out.warnings.push('Dokument má sledované změny (vloženo ' + stats.ins + '×, smazáno ' + stats.del + '×); ' +
          'viditelný text nemusí být ten podepsaný.');
      }
      if (stats.hidden) out.warnings.push('Dokument obsahuje skrytý text (' + stats.hidden + '×).');
      var comments = out.lines.filter(function (l) { return l.group === 'komentáře'; }).length;
      if (comments) out.warnings.push('Dokument má komentáře (' + comments + ' odst.).');
      return out;
    });
  }

  // -- XLSX

  function column(ref) { return String(ref || '').replace(/[0-9]+$/, ''); }

  function letters(n) {
    var s = '';
    for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  }

  function sharedStrings(xml) {
    var list = [];
    var si = null;
    var inT = false;
    var phonetic = false;
    walk(xml || '', function (kind, name, value, selfClosing) {
      if (kind === 'text') { if (si !== null && inT && !phonetic) si += value; return; }
      var open = kind === 'open';
      if (name === 'si') { if (open) si = ''; else { list.push(si); si = null; } }
      else if (name === 't') inT = open && !selfClosing;
      else if (name === 'rPh') phonetic = open && !selfClosing;
    });
    return list;
  }

  function xlsxSheet(xml, sheet, strings, out) {
    var group = 'list ' + sheet.name + (sheet.hidden ? ' (skrytý list)' : '');
    var row = null;
    var c = null;
    var into = null;
    var hiddenCols = [];
    var merged = [];
    var stats = { rows: 0, formulas: 0 };
    walk(xml, function (kind, name, value) {
      if (kind === 'text') { if (c && into) c[into] += value; return; }
      var open = kind === 'open';
      if (name === 'col' && open && attr(value, 'hidden') === '1') {
        for (var k = Number(attr(value, 'min')); k <= Number(attr(value, 'max')) && k < 16384; k++) hiddenCols.push(letters(k));
      } else if (name === 'row') {
        if (open) row = { r: attr(value, 'r'), hidden: attr(value, 'hidden') === '1', cells: [] };
        else if (row) {
          if (row.cells.length) {
            if (row.hidden) stats.rows++;
            out.emit(group, 'list ' + sheet.name + ', ř. ' + row.r, 'ř. ' + row.r + (row.hidden ? ' (skrytý řádek)' : '') + ': ' +
              row.cells.join(' | '));
          }
          row = null;
        }
      } else if (name === 'c') {
        if (open) c = { r: attr(value, 'r'), t: attr(value, 't'), v: '', f: '', is: '', hasV: false };
        else if (c && row) {
          var v = c.t === 's' ? strings[Number(c.v)] : c.t === 'inlineStr' ? c.is : c.t === 'b' ? (c.v === '1' ? 'PRAVDA' : 'NEPRAVDA')
            : c.t === 'e' ? '#chyba ' + c.v : c.v;
          if (!c.hasV && c.t !== 'inlineStr' && c.f) { v = '(vzorec bez uložené hodnoty: ' + c.f + ')'; stats.formulas++; }
          if (v !== undefined && v !== '') row.cells.push(column(c.r) + ' ' + v);
          c = null;
        }
      } else if (name === 'v' || name === 'f') {
        into = open ? name : null;
        if (open && name === 'v' && c) c.hasV = true;
      } else if (name === 't' && c && c.t === 'inlineStr') into = open ? 'is' : null;
      else if (name === 'mergeCell' && open) merged.push(attr(value, 'ref'));
    });
    var where = 'list ' + sheet.name + ': ';
    if (hiddenCols.length) out.warnings.push(where + 'skryté sloupce: ' + hiddenCols.join(', ') + '.');
    if (stats.rows) out.warnings.push(where + 'skryté řádky: ' + stats.rows + '.');
    if (merged.length) out.warnings.push(where + 'sloučené buňky: ' + merged.slice(0, 20).join(', ') + '.');
    if (stats.formulas) out.warnings.push(where + 'vzorce bez uložené hodnoty: ' + stats.formulas + '.');
  }

  function readXlsx(bytes) {
    var z = unzip(bytes);
    var out = sink();
    var sheets = [];
    var targets = {};
    var strings = [];
    return Promise.all([z.text('xl/workbook.xml'), z.text('xl/_rels/workbook.xml.rels'), z.text('xl/sharedStrings.xml')])
      .then(function (xml) {
        walk(xml[0] || '', function (kind, name, value) {
          if (kind === 'open' && name === 'sheet') {
            var state = attr(value, 'state');
            sheets.push({ name: attr(value, 'name'), hidden: Boolean(state && state !== 'visible'), rid: attr(value, 'r:id') });
          }
        });
        walk(xml[1] || '', function (kind, name, value) {
          if (kind === 'open' && name === 'Relationship') {
            var target = attr(value, 'Target');
            targets[attr(value, 'Id')] = target.charAt(0) === '/' ? target.slice(1) : 'xl/' + target;
          }
        });
        strings = sharedStrings(xml[2]);
        return sheets.reduce(function (done, s) {
          return done.then(function () { return z.text(targets[s.rid]); }).then(function (sheetXml) {
            if (sheetXml) xlsxSheet(sheetXml, s, strings, out);
          });
        }, Promise.resolve());
      }).then(function () {
        var hidden = sheets.filter(function (s) { return s.hidden; });
        if (hidden.length) out.warnings.unshift('Sešit má skrytý list: ' + hidden.map(function (s) { return s.name; }).join(', ') + '.');
        out.sheets = sheets.map(function (s) { return { name: s.name, hidden: s.hidden }; });
        out.note = 'Čísla jsou uložené hodnoty bez formátu (desetinná tečka, datum jako číslo dne).';
        return out;
      });
  }

  // -- TXT / CSV

  function readText(bytes) {
    var text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      text = new TextDecoder('windows-1250').decode(bytes);
    }
    var out = sink();
    (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(NL).forEach(function (line, i) {
      line = line.replace(/\s+$/, '');
      if (line.trim()) out.emit('text', 'ř. ' + (i + 1), line);
    });
    return out;
  }

  // -- PDF (text layer only)

  // PDF values: numbers, booleans, null, names as "/Name", strings {str},
  // references {ref}, operators {op}, arrays and dictionaries.
  function lexer(s, i) { return { s: s, i: i || 0 }; }
  var DELIMS = '()<>[]{}/%';

  function space(L) {
    var s = L.s;
    for (;;) {
      var c = s.charCodeAt(L.i);
      if (c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0) L.i++;
      else if (c === 37) { while (L.i < s.length && s.charCodeAt(L.i) !== 10 && s.charCodeAt(L.i) !== 13) L.i++; }
      else return;
    }
  }

  function word(L) {
    var s = L.s;
    var start = L.i;
    while (L.i < s.length) {
      var c = s.charCodeAt(L.i);
      if (c <= 32 || DELIMS.indexOf(s.charAt(L.i)) !== -1) break;
      L.i++;
    }
    return s.slice(start, L.i);
  }

  var ESCAPES = { n: 10, r: 13, t: 9, b: 8, f: 12 };

  function literal(L) {
    var s = L.s;
    var out = '';
    var depth = 1;
    L.i++;
    while (L.i < s.length) {
      var ch = s.charAt(L.i++);
      if (ch === BS) {
        var e = s.charAt(L.i++);
        if (ESCAPES[e]) out += String.fromCharCode(ESCAPES[e]);
        else if (/[0-7]/.test(e)) {
          var oct = e;
          while (oct.length < 3 && /[0-7]/.test(s.charAt(L.i))) oct += s.charAt(L.i++);
          out += String.fromCharCode(parseInt(oct, 8) & 255);
        } else if (e === String.fromCharCode(13)) { if (s.charCodeAt(L.i) === 10) L.i++; } else if (e !== NL) out += e;
      } else if (ch === '(') { depth++; out += ch; } else if (ch === ')') {
        if (--depth === 0) break;
        out += ch;
      } else out += ch;
    }
    return { str: out };
  }

  function hexString(text) {
    var h = text.replace(/[^0-9a-fA-F]/g, '');
    if (h.length % 2) h += '0';
    var out = '';
    for (var i = 0; i < h.length; i += 2) out += String.fromCharCode(parseInt(h.substr(i, 2), 16));
    return out;
  }

  function value(L) {
    space(L);
    var s = L.s;
    var c = s.charAt(L.i);
    if (c === '/') {
      L.i++;
      return '/' + word(L).replace(/#([0-9a-fA-F]{2})/g, function (all, h) { return String.fromCharCode(parseInt(h, 16)); });
    }
    if (c === '(') return literal(L);
    if (c === '<' && s.charAt(L.i + 1) === '<') {
      L.i += 2;
      var dict = {};
      for (;;) {
        space(L);
        if (L.i >= s.length) return dict;
        if (s.charAt(L.i) === '>') { L.i += 2; return dict; }
        var key = value(L);
        if (typeof key !== 'string') return dict;
        dict[key.slice(1)] = value(L);
      }
    }
    if (c === '<') {
      var close = s.indexOf('>', L.i);
      var text = s.slice(L.i + 1, close);
      L.i = close + 1;
      return { str: hexString(text) };
    }
    if (c === '[') {
      L.i++;
      var list = [];
      for (;;) {
        space(L);
        if (L.i >= s.length) return list;
        if (s.charAt(L.i) === ']') { L.i++; return list; }
        list.push(value(L));
      }
    }
    if (c === ']' || c === '>' || c === ')' || c === '{' || c === '}') { L.i++; return { op: c }; }
    var w = word(L);
    if (/^[+-]?([0-9]+[.]?[0-9]*|[.][0-9]+)$/.test(w)) {
      var at = L.i;
      var m = /^\s+([0-9]+)\s+R(?=[\s/<>[\]()]|$)/.exec(s.slice(at, at + 32));
      if (m && /^[0-9]+$/.test(w)) { L.i = at + m[0].length; return { ref: Number(w) }; }
      return Number(w);
    }
    if (w === 'true' || w === 'false') return w === 'true';
    if (w === 'null') return null;
    if (!w) { L.i++; return { op: '' }; }
    return { op: w };
  }

  function latin1(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return s;
  }

  function binary(text) {
    var b = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) b[i] = text.charCodeAt(i) & 255;
    return b;
  }

  function ascii85(text) {
    var t = text.replace(/\s+/g, '').replace(/^<~/, '').replace(/~>.*$/, '').replace(/z/g, '!!!!!');
    var out = '';
    for (var i = 0; i < t.length; i += 5) {
      var n = Math.min(5, t.length - i);
      var v = 0;
      for (var k = 0; k < 5; k++) v = v * 85 + (k < n ? t.charCodeAt(i + k) - 33 : 84);
      for (var j = 0; j < n - 1; j++) out += String.fromCharCode((v >>> (24 - 8 * j)) & 255);
    }
    return out;
  }

  function pdfFile(s) {
    var objects = {};
    var re = /([0-9]+)\s+([0-9]+)\s+obj(?=[\s<[(/])/g;
    var m;
    while ((m = re.exec(s))) {
      var L = lexer(s, re.lastIndex);
      var v = value(L);
      var o = { v: v };
      space(L);
      if (s.substr(L.i, 6) === 'stream') {
        var start = L.i + 6;
        if (s.charCodeAt(start) === 13) start++;
        if (s.charCodeAt(start) === 10) start++;
        var len = v && typeof v.Length === 'number' ? v.Length : -1;
        var end = len >= 0 && s.substr(start + len, 12).replace(/^\s+/, '').slice(0, 9) === 'endstream' ? start + len
          : s.indexOf('endstream', start);
        if (end < 0) end = s.length;
        o.stream = s.slice(start, end);
        if (len < 0) o.stream = o.stream.replace(/(?:\x0d\x0a|\x0a|\x0d)$/, '');
        re.lastIndex = end;
      }
      objects[m[1]] = o;
    }
    return objects;
  }

  function pdfReader(bytes) {
    var s = latin1(bytes);
    var objects = pdfFile(s);
    var get = function (v, depth) {
      for (depth = depth || 0; v && v.ref !== undefined && depth < 20; depth++) v = objects[v.ref] ? objects[v.ref].v : null;
      return v;
    };
    var decode = function (o) {
      var filters = [].concat(get(o.v.Filter) || []);
      return filters.reduce(function (done, f) {
        return done.then(function (data) {
          if (f === '/FlateDecode' || f === '/Fl') return inflate(binary(data), 'deflate').then(latin1);
          if (f === '/ASCII85Decode' || f === '/A85') return ascii85(data);
          if (f === '/ASCIIHexDecode' || f === '/AHx') return hexString(data.replace(/>.*$/, ''));
          throw fail('PDF_FILTER', 'nepodporované kódování ' + f);
        });
      }, Promise.resolve(o.stream || ''));
    };
    // Objects packed in object streams (PDF 1.5+).
    var packed = Object.keys(objects).filter(function (k) { var v = objects[k].v; return v && v.Type === '/ObjStm'; });
    return packed.reduce(function (done, k) {
      return done.then(function () { return decode(objects[k]); }).then(function (data) {
        var dict = objects[k].v;
        var nums = data.slice(0, dict.First).trim().split(/\s+/).map(Number);
        for (var i = 0; i + 1 < nums.length && i < 2 * dict.N; i += 2) {
          if (!objects[nums[i]]) objects[nums[i]] = { v: value(lexer(data, dict.First + nums[i + 1])) };
        }
      }, function () { return null; });
    }, Promise.resolve()).then(function () {
      return { s: s, objects: objects, get: get, decode: decode };
    });
  }

  // Glyph names (fonts without a Unicode map): "uni010D", "ccaron" (composed), some punctuation;
  // other names fall back to the code (ASCII).
  var ACCENTS = { acute: 0x301, caron: 0x30c, ring: 0x30a, dieresis: 0x308, grave: 0x300, circumflex: 0x302, cedilla: 0x327 };
  var GLYPHS = { endash: 0x2013, emdash: 0x2014, quotedblbase: 0x201e, quotedblleft: 0x201c, quotedblright: 0x201d,
    quoteleft: 0x2018, quoteright: 0x2019, bullet: 0x2022, ellipsis: 0x2026, section: 0xa7, degree: 0xb0, Euro: 0x20ac };
  function glyph(name) {
    var n = String(name).slice(1);
    var m = /^uni([0-9A-F]{4})$/.exec(n);
    if (m) return String.fromCharCode(parseInt(m[1], 16));
    if (GLYPHS[n]) return String.fromCharCode(GLYPHS[n]);
    if (n.length === 1) return n;
    if (ACCENTS[n.slice(1)]) return (n.charAt(0) + String.fromCharCode(ACCENTS[n.slice(1)])).normalize('NFC');
    return null;
  }

  // WinAnsi bytes 0x80–0x9F that differ from Latin-1.
  var WIN = { 128: 0x20ac, 130: 0x201a, 132: 0x201e, 133: 0x2026, 138: 0x160, 142: 0x17d, 145: 0x2018, 146: 0x2019, 147: 0x201c,
    148: 0x201d, 149: 0x2022, 150: 0x2013, 151: 0x2014, 154: 0x161, 158: 0x17e };

  function utf16(hex) {
    var out = '';
    if (hex.length <= 2) return String.fromCharCode(parseInt(hex, 16));
    for (var i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
    return out;
  }

  function cmap(text) {
    var map = {};
    var bytes = [];
    var re = /begin(codespacerange|bfchar|bfrange)([^]*?)end(?:codespacerange|bfchar|bfrange)/g;
    var m;
    while ((m = re.exec(text))) {
      var tokens = m[2].match(/<[0-9a-fA-F]*>|\[|\]/g) || [];
      var hexOf = function (t) { return t.slice(1, -1); };
      var i = 0;
      while (i < tokens.length) {
        if (m[1] === 'codespacerange') { bytes.push(hexOf(tokens[i]).length / 2); i += 2; }
        else if (m[1] === 'bfchar') { map[parseInt(hexOf(tokens[i]), 16)] = utf16(hexOf(tokens[i + 1])); i += 2; }
        else {
          var lo = parseInt(hexOf(tokens[i]), 16);
          var hi = parseInt(hexOf(tokens[i + 1]), 16);
          if (tokens[i + 2] === '[') {
            for (i += 3; tokens[i] !== ']' && i < tokens.length; i++, lo++) map[lo] = utf16(hexOf(tokens[i]));
            i++;
          } else {
            var dst = utf16(hexOf(tokens[i + 2]));
            for (var c = lo; c <= hi && c - lo < 65536; c++) {
              map[c] = dst.slice(0, -1) + String.fromCharCode(dst.charCodeAt(dst.length - 1) + c - lo);
            }
            i += 3;
          }
        }
      }
    }
    return { map: map, bytes: bytes.length ? Math.min.apply(null, bytes) : 1 };
  }

  // How a font's codes become text: its ToUnicode map, else its encoding.
  function font(pdf, dict) {
    var f = { bytes: dict.Subtype === '/Type0' ? 2 : 1, map: {}, encoding: null };
    var tu = dict.ToUnicode && dict.ToUnicode.ref !== undefined ? pdf.objects[dict.ToUnicode.ref] : null;
    var ready = tu && tu.stream !== undefined ? pdf.decode(tu).then(function (text) {
      var c = cmap(text);
      f.map = c.map;
      if (f.bytes === 1) f.bytes = c.bytes;
    }) : Promise.resolve();
    // Glyph widths (1/1000 of the font size), to tell a word gap from kerning.
    var simple = pdf.get(dict.Widths);
    var cid = dict.DescendantFonts ? pdf.get((pdf.get(dict.DescendantFonts) || [])[0]) : null;
    if (simple) {
      f.widths = {};
      simple.forEach(function (wd, i) { f.widths[(dict.FirstChar || 0) + i] = pdf.get(wd); });
    } else if (cid) {
      f.widths = {};
      f.dw = typeof cid.DW === 'number' ? cid.DW : 1000;
      var list = pdf.get(cid.W) || [];
      for (var i = 0; i < list.length;) {
        var next = pdf.get(list[i + 1]);
        if (Array.isArray(next)) { next.forEach(function (wd, k) { f.widths[list[i] + k] = pdf.get(wd); }); i += 2; }
        else { for (var c = list[i]; c <= next && c - list[i] < 65536; c++) f.widths[c] = list[i + 2]; i += 3; }
      }
    }
    return ready.then(function () {
      if (f.bytes === 1) {
        var enc = pdf.get(dict.Encoding);
        var subset = /^[/][A-Z]{6}[+]/.test(dict.BaseFont || '');
        if (enc || !subset) {
          f.encoding = {};
          var diffs = enc && enc.Differences ? pdf.get(enc.Differences) : [];
          var code = 0;
          (diffs || []).forEach(function (d) {
            if (typeof d === 'number') code = d;
            else { var g = glyph(d); if (g) f.encoding[code] = g; code++; }
          });
        }
      }
      return f;
    });
  }

  // {text, width}: the characters of a shown string and its advance in 1/1000 em.
  function decodeText(f, str, stats) {
    var out = '';
    var width = 0;
    for (var i = 0; i + f.bytes <= str.length; i += f.bytes) {
      var code = f.bytes === 2 ? str.charCodeAt(i) * 256 + str.charCodeAt(i + 1) : str.charCodeAt(i);
      if (f.widths) width += typeof f.widths[code] === 'number' ? f.widths[code] : f.dw || 500;
      var ch = f.map[code];
      if (ch === undefined && f.encoding) {
        ch = f.encoding[code];
        if (ch === undefined && code >= 32 && code !== 127) ch = String.fromCharCode(WIN[code] || code);
      }
      if (ch === undefined) { stats.bad++; ch = BAD; }
      stats.chars++;
      out += ch;
    }
    return { text: out, width: width };
  }

  // The text of one content stream (and the forms it draws), line by line.
  function contentText(pdf, data, resources, page, depth) {
    var fonts = {};
    var fontDicts = (resources && pdf.get(resources.Font)) || {};
    var xobjects = (resources && pdf.get(resources.XObject)) || {};
    return Promise.all(Object.keys(fontDicts).map(function (k) {
      var d = pdf.get(fontDicts[k]);
      return d ? font(pdf, d).then(function (f) { fonts[k] = f; }) : null;
    })).then(function () {
      var L = lexer(data);
      var args = [];
      var current = null;
      var forms = [];
      // Lines follow the text's height on the page; on one line a space goes
      // where the next text starts clearly after the previous one ends (with
      // glyph widths; without them, wherever the text was moved).
      var x = 0;
      var y = 0;
      var lx = 0;
      var ly = 0;
      var a = 1;
      var d = 1;
      var size = 10;
      var leading = 0;
      var endX = null;
      var lineY = null;
      var moved = false;
      var newline = function () {
        if (page.line.trim()) page.lines.push(page.line.trim());
        page.line = '';
        lineY = null;
      };
      var to = function (nx, ny) { x = lx = nx; y = ly = ny; moved = true; };
      var show = function (str) {
        if (!current || !str || str.str === undefined) return;
        if (lineY !== null && Math.abs(y - lineY) > 1) newline();
        else if (page.line && page.line.slice(-1) !== ' ' && (current.widths ? x - endX > 0.15 * size * Math.abs(a) : moved)) {
          page.line += ' ';
        }
        var t = decodeText(current, str.str, page.stats);
        page.line += t.text;
        x += t.width / 1000 * size * a;
        endX = x;
        moved = false;
        lineY = y;
      };
      while (L.i < data.length) {
        var v = value(L);
        if (!v || v.op === undefined) { args.push(v); continue; }
        var op = v.op;
        if (op === 'Tf') { current = fonts[String(args[0]).slice(1)] || null; size = Math.abs(args[1]) || size; }
        else if (op === 'BT') { a = 1; d = 1; to(0, 0); }
        else if (op === 'Tm') { a = args[0] || 1; d = args[3] || 1; to(args[4], args[5]); }
        else if (op === 'Td' || op === 'TD') {
          if (op === 'TD') leading = -args[1];
          to(lx + args[0] * a, ly + args[1] * d);
        } else if (op === 'TL') leading = args[0];
        else if (op === 'T*') to(lx, ly - (leading || size) * d);
        else if (op === 'Tj') show(args[0]);
        else if (op === "'" || op === '"') { to(lx, ly - (leading || size) * d); show(args[args.length - 1]); }
        else if (op === 'TJ') {
          (Array.isArray(args[0]) ? args[0] : []).forEach(function (part) {
            if (typeof part !== 'number') show(part);
            else {
              x -= part / 1000 * size * a;
              if (part < -200) moved = true;
            }
          });
        } else if (op === 'Do') {
          var x = xobjects[String(args[0]).slice(1)];
          var xo = x && x.ref !== undefined ? pdf.objects[x.ref] : null;
          if (xo && xo.v && xo.v.Subtype === '/Image') page.images++;
          else if (xo && xo.v && xo.v.Subtype === '/Form' && depth < 4) forms.push(xo);
        } else if (op === 'BI') {
          var at = data.slice(L.i).search(/\sID\s/);
          var stop = at < 0 ? -1 : data.slice(L.i + at + 4).search(/\sEI(?=\s|$)/);
          L.i = at < 0 || stop < 0 ? data.length : L.i + at + 4 + stop + 3;
          page.images++;
        }
        args = [];
      }
      newline();
      return forms.reduce(function (done, xo) {
        return done.then(function () { return pdf.decode(xo); }).then(function (inner) {
          return contentText(pdf, inner, pdf.get(xo.v.Resources) || resources, page, depth + 1);
        });
      }, Promise.resolve());
    });
  }

  function pdfPages(pdf) {
    var catalog = null;
    Object.keys(pdf.objects).forEach(function (k) {
      var v = pdf.objects[k].v;
      if (v && v.Type === '/Catalog') catalog = v;
    });
    var pages = [];
    var visit = function (node, resources, depth) {
      node = pdf.get(node);
      if (!node || depth > 30) return;
      var res = node.Resources ? pdf.get(node.Resources) : resources;
      if (node.Kids) (pdf.get(node.Kids) || []).forEach(function (k) { visit(k, res, depth + 1); });
      else pages.push({ dict: node, resources: res });
    };
    if (catalog) visit(catalog.Pages, null, 0);
    return pages;
  }

  function streamsOf(pdf, contents) {
    var c = contents;
    if (c && c.ref !== undefined) {
      var o = pdf.objects[c.ref];
      if (o && o.stream !== undefined) return [o];
      c = o ? o.v : null;
    }
    return (Array.isArray(c) ? c : []).map(function (r) { return r && pdf.objects[r.ref]; }).filter(Boolean);
  }

  function readPdf(bytes) {
    var out = sink();
    return pdfReader(bytes).then(function (pdf) {
      if (/[/]Encrypt[\s/<]/.test(pdf.s)) return { unreadable: 'PDF je zašifrované', warnings: [] };
      var pages = pdfPages(pdf);
      if (!pages.length) return { unreadable: 'v PDF jsem nenašel žádné strany', warnings: [] };
      var stats = { chars: 0, bad: 0 };
      var scans = [];
      var broken = [];
      return pages.reduce(function (done, p, i) {
        var page = { lines: [], line: '', images: 0, stats: stats };
        return done.then(function () {
          return Promise.all(streamsOf(pdf, p.dict.Contents).map(pdf.decode));
        }).then(function (parts) {
          return contentText(pdf, parts.join(NL), p.resources, page, 0);
        }).catch(function () { broken.push(i + 1); }).then(function () {
          page.lines.forEach(function (l) { out.emit('strana ' + (i + 1), 'strana ' + (i + 1), l); });
          if (!page.lines.length && page.images) scans.push(i + 1);
        });
      }, Promise.resolve()).then(function () {
        out.pages = pages.length;
        if (!out.lines.length) {
          return { unreadable: scans.length ? 'jde o sken (strany jsou obrázky bez textu)' : 'v PDF není žádný text', warnings: [] };
        }
        if (stats.bad > stats.chars * 0.02) {
          return { unreadable: 'písmo v PDF nemá převod na znaky, text by vyšel zkomolený (hlavně česká písmena)', warnings: [] };
        }
        if (stats.bad) out.warnings.push(stats.bad + ' znaků se nepodařilo převést (v textu jako ' + BAD + ').');
        if (scans.length) {
          out.needsFolderPages = scans;
          out.warnings.push('Strany ' + scans.join(', ') + ' jsou jen obrázek (sken); ty přečtu jen ze souboru v pracovní složce.');
        }
        if (broken.length) out.warnings.push('Strany ' + broken.join(', ') + ' se nepodařilo přečíst.');
        return out;
      });
    });
  }
  // -- end of PDF (scripts/stamp.js copies the PDF part into verejne-zdroje.js)

  iaud.listFiles = listFiles;
  iaud.readFile = readFile;
  iaud.findInFile = findInFile;
  // For iaud-filewrite.js.
  core.files = { documents: documents, pickFile: pickFile, publicFile: publicFile, attachedTo: attachedTo, docsBase: docsBase,
    download: download, TYPES: TYPES, loose: loose, sizeLabel: sizeLabel };

  // The self-check covers this whole function as the browser parsed it.
  var source = String(installFiles);
  iaud.extensions[NAME] = 'délka ' + source.length + ', hash ' + core.fnv1a(source);
  if (isModule) module.exports = iaud;
  return NAME + ' ' + VERSION + ' loaded, ' + iaud.extensions[NAME];
})(typeof window !== 'undefined' ? window : globalThis);
