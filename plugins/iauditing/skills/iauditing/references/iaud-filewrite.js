// iaud-filewrite: changes in the zakázka's Soubory (#24): upload a file, attach
// it to an answer or detach it, rename or delete it. Claude passes this whole
// file to the browser's JavaScript tool after iaud.js, iaud-write.js and
// iaud-files.js; it evaluates to "iaud-filewrite <version> loaded, délka <n>,
// hash <h>". Every change has the rails of iaud-write (PLAN §5): allowlist →
// role → preview → the user's "ano" → one write → read back, never repeated.
// A file to upload reaches the page as base64 in parts (stageFile), checked
// against the SHA-256 Claude computed in the workspace folder.
(function installFileWrite(root) {
  'use strict';

  var VERSION = '0.5.1';
  var NAME = 'iaud-filewrite';

  var isModule = typeof module === 'object' && module.exports;
  if (isModule) require('./iaud-write.js');
  var iaud = isModule ? require('./iaud-files.js') : root.iaud;
  if (!iaud || !iaud._internal) {
    return NAME + ': nejdřív je potřeba načíst iaud.js, iaud-write.js a iaud-files.js (verze ' + VERSION + ').';
  }
  if (iaud.version !== VERSION) {
    return NAME + ' ' + VERSION + ': načtené iaud.js je jiné verze (' + iaud.version + '). Načtěte znovu všechny soubory.';
  }
  var core = iaud._internal;
  var writing = core.write;
  var files = core.files;
  if (!writing || !iaud.extensions['iaud-write']) return NAME + ': nejdřív je potřeba načíst iaud-write.js (verze ' + VERSION + ').';
  if (!files || !iaud.extensions['iaud-files']) return NAME + ': nejdřív je potřeba načíst iaud-files.js (verze ' + VERSION + ').';

  // Each part of base64 goes through one JavaScript call; the whole file has to
  // pass through Claude's own output, so it stays small (VERIFY.md V5).
  var MAX_UPLOAD = 100000;
  var MAX_PART = 60000;
  var MAX_PARTS = 10;
  var BIG = 'Větší soubor prosím nahrajte do Souborů sami ve webovém rozhraní iAuditingu (přetažením do Souborů); ' +
    'připojit ho k otázce pak můžu já.';

  // The app's rules for a file name (frontend schema, app 1.2.6): 3–128 chars
  // after NFC, none of <>:"/\|?*% or control characters, no leading space, no
  // trailing dot or space, not a reserved device name.
  var BAD_CHARS = '<>:' + String.fromCharCode(34) + '/' + String.fromCharCode(92) + '|?*%';
  var RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
  var MIME = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odt: 'application/vnd.oasis.opendocument.text', csv: 'text/csv', txt: 'text/plain', png: 'image/png', jpg: 'image/jpeg',
    jpeg: 'image/jpeg', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', heif: 'image/heif' };

  var LABELS = {
    upload: 'nahrání souboru do Souborů zakázky',
    attach: 'připojení souboru k otázce',
    detach: 'odpojení souboru od otázky (soubor v Souborech zůstane)',
    rename: 'přejmenování souboru v Souborech',
    remove: 'smazání souboru ze Souborů',
  };
  var DELETE_WARNING = 'Soubor se ze Souborů zakázky smaže. Vrátit to nejde.';

  function fail(code, message) { return core.apiError(code, message); }

  function extension(name) {
    var m = /[.]([A-Za-z0-9]+)$/.exec(name);
    return m ? m[1].toLowerCase() : '';
  }

  // Why the app would refuse this name, or null.
  function nameProblem(name) {
    if (typeof name !== 'string') return 'název souboru chybí.';
    var n = name.normalize('NFC');
    if (n.length < 3 || n.length > 128) return 'název souboru musí mít 3 až 128 znaků (má ' + n.length + ').';
    for (var i = 0; i < n.length; i++) {
      if (n.charCodeAt(i) < 32 || BAD_CHARS.indexOf(n.charAt(i)) !== -1) {
        return 'název souboru nesmí obsahovat znaky ' + BAD_CHARS.split('').join(' ') + '.';
      }
    }
    if (/^\s|[. ]$/.test(n) || RESERVED.test(n)) return 'název souboru nesmí začínat mezerou ani končit tečkou nebo mezerou.';
    if (!MIME[extension(n)]) {
      return 'iAuditing přijme jen soubory PDF, DOCX, XLSX, PPTX, ODT, CSV, TXT, PNG, JPEG, TIFF a HEIC (název „' + n + '“).';
    }
    return null;
  }

  function toHex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
  }

  function toBase64(buf) {
    var bytes = new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(s);
  }

  function digest(bytes) { return crypto.subtle.digest('SHA-256', bytes); }

  // -- staging: the file's bytes, in this page only

  var staged = {};

  // One part of a file from the workspace folder: {name, part, parts, data
  // (base64), sha256 (hex, of the whole file)}. When all parts are in, the file
  // is decoded and checked; nothing is sent to iAuditing.
  function stageFile(input) {
    input = input || {};
    var name = typeof input.name === 'string' ? input.name.normalize('NFC') : input.name;
    var problem = nameProblem(name);
    if (problem) return Promise.reject(fail('BAD_NAME', 'Soubor nenahraji: ' + problem));
    var parts = Number(input.parts);
    var part = Number(input.part);
    if (!(parts >= 1 && parts <= MAX_PARTS && part >= 1 && part <= parts) || typeof input.data !== 'string' ||
      input.data.length > MAX_PART || !/^[A-Za-z0-9+/=\s]*$/.test(input.data)) {
      return Promise.reject(fail('BAD_PART', 'Část souboru je poškozená nebo moc velká (jedna část nejvýš ' + MAX_PART +
        ' znaků, nejvýš ' + MAX_PARTS + ' částí).'));
    }
    if (!/^[0-9a-fA-F]{64}$/.test(String(input.sha256 || ''))) {
      return Promise.reject(fail('BAD_PART', 'Chybí kontrolní součet celého souboru, spočítaný ve složce.'));
    }
    var s = staged[name];
    if (!s || s.parts !== parts || s.sha256 !== String(input.sha256).toLowerCase() || part === 1) {
      s = staged[name] = { parts: parts, sha256: String(input.sha256 || '').toLowerCase(), data: [] };
    }
    s.data[part - 1] = input.data.replace(/\s+/g, '');
    var received = s.data.filter(function (x) { return typeof x === 'string'; }).length;
    var out = { name: name, received: received, parts: parts, complete: false };
    if (received < parts) return Promise.resolve(out);
    var binary = atob(s.data.join(''));
    if (binary.length > MAX_UPLOAD) {
      delete staged[name];
      return Promise.reject(fail('TOO_BIG', 'Soubor má ' + files.sizeLabel(binary.length) + '; přes chat přenesu nejvýš ' +
        files.sizeLabel(MAX_UPLOAD) + '. ' + BIG));
    }
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return digest(bytes).then(function (hash) {
      if (toHex(hash) !== s.sha256) {
        delete staged[name];
        throw fail('BAD_TRANSFER', 'Soubor „' + name + '“ nedorazil celý nebo beze změny (kontrolní součet nesedí). Pošlete ho prosím znovu.');
      }
      s.bytes = bytes;
      s.base64Sha = toBase64(hash);
      out.complete = true;
      out.size = bytes.length;
      out.sizeLabel = files.sizeLabel(bytes.length);
      out.type = (files.TYPES[MIME[extension(name)]] || {}).label;
      return out;
    });
  }

  // -- the confirmation, shared by every change

  // prepare() resolves to {problems, sig, preview, perform}: the shared rails
  // of iaud-write (a dry run gives the preview with `confirm`; the change needs
  // that confirm, once, with nothing changed since).
  function guarded(engagement, options, prepare) {
    return writing.guarded(engagement, options, 'f', 'v Souborech nebo u otázky', function () {
      return prepare().then(function (plan) {
        return { problems: plan.problems, sig: plan.sig, preview: function () { return plan.preview; }, perform: function () {
          var started = Date.now();
          return plan.perform().then(function (report) {
            report.ms = Date.now() - started;
            return report;
          });
        } };
      });
    });
  }

  function openAudit(engagement) {
    return writing.openAuditForWrite(engagement).then(function (ctx) {
      return files.documents(ctx.audit).then(function (docs) {
        ctx.docs = docs;
        return ctx;
      });
    });
  }

  function brief(d) {
    return { name: d.name, type: (files.TYPES[d.mimetype] || { label: d.mimetype }).label, size: d.size, sizeLabel: files.sizeLabel(d.size || 0) };
  }

  function head(kind, ctx) {
    return { action: kind, actionLabel: LABELS[kind], auditId: ctx.audit.auditId, client: ctx.audit.client && ctx.audit.client.name };
  }

  function relisted(ctx) {
    return files.documents(ctx.audit).catch(function () { return null; });
  }

  function reportOf(kind, ctx) {
    var r = head(kind, ctx);
    r.ok = false;
    return r;
  }

  // What went wrong, said plainly, with the uncertain case named.
  function failed(r, err, what) {
    r.error = err.message;
    r.code = err.code;
    r.uncertain = Boolean(err.uncertain);
    r.message = what + ' se nepovedlo (' + err.message + ')' + (r.uncertain ? '; není jisté, jestli se to provedlo, ' +
      'zkontrolujte prosím Soubory v iAuditingu' : '') + '. Dál nic neměním.';
    return r;
  }

  // -- upload

  function tenant() {
    var m = /^([a-z0-9-]+)[.]iauditing[.]cz$/.exec((root.location && root.location.hostname) || '');
    if (!m) throw fail('NOT_ON_IAUDITING', 'Prohlížeč není na stránce iAuditingu vaší firmy.');
    return m[1];
  }

  // Uploads a staged file (stageFile) into the zakázka's Soubory: upload slot
  // (180 s) → PUT with the signed headers → confirm → read back (V5).
  function uploadFile(engagement, name, options) {
    var key = typeof name === 'string' ? name.normalize('NFC') : name;
    return guarded(engagement, options, function () {
      var s = staged[key];
      if (!s || !s.bytes) {
        return Promise.reject(fail('NOT_STAGED', 'Soubor „' + name + '“ ještě není v prohlížeči celý; ' +
          'nejdřív je potřeba ho do prohlížeče předat po částech.'));
      }
      return openAudit(engagement).then(function (ctx) {
        var same = ctx.docs.filter(function (d) { return files.loose(d.name) === files.loose(key); });
        var problems = same.length ? ['V Souborech už je soubor se stejným názvem „' + same[0].name + '“; ' +
          'nový prosím pojmenujte jinak, ať se nepletou.'] : [];
        var contentType = MIME[extension(key)];
        var preview = head('upload', ctx);
        preview.file = brief({ name: key, mimetype: contentType, size: s.bytes.length });
        return {
          problems: problems,
          sig: ['upload', ctx.audit.auditId, key, s.sha256, same.map(function (d) { return d.storageId; })],
          preview: preview,
          perform: function () { return upload(ctx, key, s, contentType); },
        };
      });
    });
  }

  function upload(ctx, name, s, contentType) {
    var r = reportOf('upload', ctx);
    var sid = null;
    var stage = 'slot';
    return core.apiGet('staff/me/get').then(function (me) {
      if (!me || !me.userId) throw fail('UNEXPECTED', 'iAuditing nevrátil, kdo je přihlášený.');
      var headers = { 'Content-Type': contentType, 'x-amz-checksum-sha256': s.base64Sha, 'if-none-match': '*',
        'x-amz-meta-uploaderid': me.userId, 'x-amz-meta-tenantid': tenant() };
      return core.apiSend('POST', 'storage/upload', { name: name, contentType: contentType, size: s.bytes.length,
        auditId: ctx.audit.auditId, sha256: s.base64Sha }).then(function (slot) {
        sid = slot.storageId;
        stage = 'put';
        return fetch(slot.uploadUrl, { method: 'PUT', headers: headers, body: s.bytes }).catch(function () {
          throw fail('NETWORK', 'spojení s úložištěm se přerušilo');
        });
      });
    }).then(function (put) {
      if (!put.ok) throw fail('UPLOAD', 'úložiště soubor nepřijalo (HTTP ' + put.status + ')');
      stage = 'confirm';
      return core.apiSend('POST', files.docsBase(ctx.audit) + '/' + sid + '/confirm', { name: name });
    }).then(function () {
      return relisted(ctx);
    }).then(function (docs) {
      var d = docs && docs.filter(function (x) { return x.storageId === sid; })[0];
      if (!d || d.name !== name || d.size !== s.bytes.length) {
        r.readBack = docs ? 'NESOUHLASÍ' : 'neověřeno';
        return null;
      }
      r.file = files.publicFile(d);
      return files.download(ctx.audit, d).then(digest).then(function (hash) {
        r.readBack = toBase64(hash) === s.base64Sha ? 'OK' : 'NESOUHLASÍ';
      });
    }).then(function () {
      r.ok = r.readBack === 'OK';
      r.message = r.ok ? 'Soubor „' + name + '“ je v Souborech zakázky, kontrola po nahrání sedí (stažený obsah je shodný).'
        : 'Soubor jsem odeslal, ale kontrola po nahrání nesouhlasí (' + r.readBack + '). Dál nic neměním; zkontrolujte prosím Soubory.';
      if (r.ok) delete staged[name];
      return r;
    }, function (err) {
      if (stage !== 'confirm' && !err.uncertain) {
        r.message = 'Nahrání se nepovedlo (' + err.message + '); v Souborech nic nepřibylo. Dál nic neměním.';
        r.error = err.message;
        return r;
      }
      return failed(r, err, 'Dokončení nahrání');
    });
  }

  // -- attach and detach

  // The answer slot of {questionId, sectionId} in the procedure's forms.
  function slotOf(ctx, at) {
    var sectionId = at.sectionId === undefined || at.sectionId === null ? null : Number(at.sectionId);
    var out = { sectionId: sectionId };
    ctx.forms.forEach(function (f) {
      (f.form.questions || []).forEach(function (q) { if (q.questionId === at.questionId) { out.f = f; out.q = q; } });
    });
    if (!out.q) { out.problem = 'Otázka ' + at.questionId + ' v proceduře ' + ctx.number + ' není.'; return out; }
    var reason = core.readOnlyReason(out.q);
    if (reason) { out.problem = reason; return out; }
    out.f.shown.parts.forEach(function (part) {
      part.items.forEach(function (i) {
        if (i.questionId === at.questionId && i.sectionId === sectionId) out.item = { no: i.no, section: part.section && part.section.name };
      });
    });
    if (!out.item) out.problem = 'Otázka ' + at.questionId + ' nemá v proceduře ' + ctx.number + ' místo pro sekci ' + sectionId + '.';
    out.row = core.findAnswer(out.f.form.answers || [], at.questionId, sectionId);
    return out;
  }

  function attachment(kind, engagement, procedure, at, file, options) {
    at = at || {};
    return guarded(engagement, options, function () {
      var ctx;
      return writing.openForWrite(engagement, procedure, {}).then(function (opened) {
        ctx = opened;
        return files.documents(ctx.audit);
      }).then(function (docs) {
        var d = files.pickFile(docs, file);
        var slot = slotOf(ctx, at);
        var problems = slot.problem ? [slot.problem] : [];
        var current = slot.row ? (slot.row.attachments || []).map(function (a) { return a.storageId; }) : [];
        var has = current.indexOf(d.storageId) !== -1;
        if (!problems.length && kind === 'attach' && has) problems.push('Soubor „' + d.name + '“ už je k této otázce připojený.');
        if (!problems.length && kind === 'detach' && !has) problems.push('Soubor „' + d.name + '“ k této otázce připojený není.');
        var preview = head(kind, ctx);
        preview.number = ctx.number;
        preview.question = slot.q ? { no: slot.item ? slot.item.no : null, question: slot.q.question,
          section: slot.item ? slot.item.section : null } : null;
        preview.file = brief(d);
        preview.attachments = current.map(function (id) {
          var x = docs.filter(function (y) { return y.storageId === id; })[0];
          return x ? x.name : 'soubor, který už v Souborech není';
        });
        preview.createsRow = kind === 'attach' && !slot.row;
        if (preview.createsRow) {
          preview.note = 'Otázka zatím nemá řádek odpovědi; vytvořím prázdný řádek (jako to dělá aplikace). Odpověď zůstane ' +
            'nevyplněná a prázdný řádek smazat nejde.';
        }
        return {
          problems: problems,
          sig: [kind, ctx.audit.auditId, ctx.procedure.procedureId, at.questionId, slot.sectionId, slot.row ? slot.row.answerId : null,
            current, d.storageId],
          preview: preview,
          perform: function () { return attachWrite(kind, ctx, slot, d); },
        };
      });
    });
  }

  function attachWrite(kind, ctx, slot, d) {
    var r = reportOf(kind, ctx);
    var cid = slot.f.component.componentId;
    var path = ctx.base + '/components/' + cid + '/update';
    r.number = ctx.number;
    r.file = brief(d);
    r.open = { auditId: ctx.audit.auditId, procedureId: ctx.procedure.procedureId, questionId: slot.q.questionId, sectionId: slot.sectionId };
    var answerId = slot.row ? slot.row.answerId : null;
    var created = Promise.resolve();
    if (!answerId) {
      created = core.apiSend('PATCH', path, { payload: { action: 'question.save', data: { formId: cid, questionId: slot.q.questionId,
        sectionId: slot.sectionId, answer: '', description: '', comment: '' } } }).then(function (res) {
        answerId = res && res.result && res.result.data ? res.result.data.answerId : null;
        if (!answerId) throw fail('UNEXPECTED', 'iAuditing nevrátil řádek odpovědi');
        r.createdRow = true;
      });
    }
    var action = kind === 'attach' ? 'question.attachment.add' : 'question.attachment.remove';
    return created.then(function () {
      return core.apiSend('PATCH', path, { payload: { action: action, data: { answerId: answerId, storageId: d.storageId } } });
    }).then(function () {
      return writing.loadForms(ctx, {}).catch(function () { return null; });
    }).then(function (after) {
      var f = after && after.filter(function (x) { return x.component.componentId === cid; })[0];
      var row = f && core.findAnswer(f.form.answers || [], slot.q.questionId, slot.sectionId);
      var has = Boolean(row && (row.attachments || []).some(function (a) { return a.storageId === d.storageId; }));
      r.readBack = !after ? 'neověřeno' : has === (kind === 'attach') ? 'OK' : 'NESOUHLASÍ';
      r.ok = r.readBack === 'OK';
      r.message = r.ok ? 'Soubor „' + d.name + '“ je ' + (kind === 'attach' ? 'připojený k otázce' : 'od otázky odpojený') +
        ', kontrola po uložení sedí.' : 'Změnu jsem odeslal, ale kontrola nesouhlasí (' + r.readBack + '). Dál nic neměním.';
      return r;
    }, function (err) {
      return failed(r, err, kind === 'attach' ? 'Připojení souboru' : 'Odpojení souboru');
    });
  }

  // Attaches a file from Soubory (storageId or name) to the answer of
  // {questionId, sectionId} in a procedure; detachFile removes the link only.
  function attachFile(engagement, procedure, at, file, options) { return attachment('attach', engagement, procedure, at, file, options); }
  function detachFile(engagement, procedure, at, file, options) { return attachment('detach', engagement, procedure, at, file, options); }

  // -- rename and delete (only on the user's explicit request)

  function renameFile(engagement, file, newName, options) {
    var wanted = typeof newName === 'string' ? newName.normalize('NFC').trim() : newName;
    return guarded(engagement, options, function () {
      return openAudit(engagement).then(function (ctx) {
        var d = files.pickFile(ctx.docs, file);
        var problem = nameProblem(wanted);
        if (!problem && extension(wanted) !== extension(d.name)) problem = 'nový název musí mít stejnou příponu (.' + extension(d.name) + ').';
        if (!problem && wanted === d.name) problem = 'soubor se už takto jmenuje.';
        if (!problem && ctx.docs.some(function (x) { return x !== d && files.loose(x.name) === files.loose(wanted); })) {
          problem = 'soubor s názvem „' + wanted + '“ už je v Souborech.';
        }
        var preview = head('rename', ctx);
        preview.file = brief(d);
        preview.newName = wanted;
        return {
          problems: problem ? ['Přejmenování: ' + problem] : [],
          sig: ['rename', ctx.audit.auditId, d.storageId, d.name, wanted],
          preview: preview,
          perform: function () {
            var r = reportOf('rename', ctx);
            return core.apiSend('PATCH', files.docsBase(ctx.audit) + '/' + d.storageId + '/rename', { newName: wanted }).then(function () {
              return relisted(ctx);
            }).then(function (docs) {
              var now = docs && docs.filter(function (x) { return x.storageId === d.storageId; })[0];
              r.readBack = !docs ? 'neověřeno' : now && now.name === wanted ? 'OK' : 'NESOUHLASÍ';
              r.ok = r.readBack === 'OK';
              r.file = now ? files.publicFile(now) : brief(d);
              r.message = r.ok ? 'Soubor je přejmenovaný na „' + wanted + '“, kontrola sedí.'
                : 'Přejmenování jsem odeslal, ale kontrola nesouhlasí (' + r.readBack + '). Dál nic neměním.';
              return r;
            }, function (err) { return failed(r, err, 'Přejmenování'); });
          },
        };
      });
    });
  }

  function deleteFile(engagement, file, options) {
    return guarded(engagement, options, function () {
      var ctx;
      var d;
      return openAudit(engagement).then(function (opened) {
        ctx = opened;
        d = files.pickFile(ctx.docs, file);
        return core.apiGet(files.docsBase(ctx.audit) + '/' + d.storageId + '/references');
      }).then(function (refs) {
        var where = files.attachedTo(refs, ctx.audit);
        var problems = [];
        if (where.length) {
          problems.push('Soubor „' + d.name + '“ je připojený k otázkám (procedury ' + where.map(function (x) { return x.procedure; }).join(', ') +
            '); nejdřív ho od nich odpojte, pak ho jde smazat.');
        }
        if (refs && refs.standardAccounts && refs.standardAccounts.length) problems.push('Soubor používá import účetních dat; smažte ho ve webu.');
        var preview = head('remove', ctx);
        preview.file = brief(d);
        preview.warning = DELETE_WARNING;
        return {
          problems: problems,
          sig: ['remove', ctx.audit.auditId, d.storageId, d.name, d.size, where.length],
          preview: preview,
          perform: function () {
            var r = reportOf('remove', ctx);
            r.file = brief(d);
            return core.apiSend('DELETE', files.docsBase(ctx.audit) + '/' + d.storageId + '/delete').then(function () {
              return relisted(ctx);
            }).then(function (docs) {
              r.readBack = !docs ? 'neověřeno' : docs.some(function (x) { return x.storageId === d.storageId; }) ? 'NESOUHLASÍ' : 'OK';
              r.ok = r.readBack === 'OK';
              r.message = r.ok ? 'Soubor „' + d.name + '“ je ze Souborů smazaný, kontrola sedí.'
                : 'Smazání jsem odeslal, ale kontrola nesouhlasí (' + r.readBack + '). Dál nic neměním.';
              return r;
            }, function (err) { return failed(r, err, 'Smazání'); });
          },
        };
      });
    });
  }

  iaud.stageFile = stageFile;
  iaud.uploadFile = uploadFile;
  iaud.attachFile = attachFile;
  iaud.detachFile = detachFile;
  iaud.renameFile = renameFile;
  iaud.deleteFile = deleteFile;

  // The self-check covers this whole function as the browser parsed it.
  var source = String(installFileWrite);
  iaud.extensions[NAME] = 'délka ' + source.length + ', hash ' + core.fnv1a(source);
  if (isModule) module.exports = iaud;
  return NAME + ' ' + VERSION + ' loaded, ' + iaud.extensions[NAME];
})(typeof window !== 'undefined' ? window : globalThis);
