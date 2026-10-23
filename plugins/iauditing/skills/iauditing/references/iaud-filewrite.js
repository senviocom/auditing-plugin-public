// iaud-filewrite: changes in the zakázka's Soubory (#24): upload a file, attach
// it to an answer or detach it, rename or delete it. Claude passes this whole
// file to the browser's JavaScript tool after iaud.js, iaud-write.js and
// iaud-files.js; it evaluates to "iaud-filewrite <version> loaded, délka <n>,
// hash <h>". Every change has the rails of iaud-write (PLAN §5): allowlist →
// role → preview → the user's "ano" → one write → read back, never repeated.
// A file to upload never passes through Claude: the page asks iAuditing for an
// upload URL and Claude's shell sends the file there with curl (uploadFile),
// then the page confirms it and reads it back (finishUpload).
(function installFileWrite(root) {
  'use strict';

  var VERSION = '0.6.0';
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

  // iAuditing's own limit (frontend schema, app 1.2.6: ERR_API_STORAGE_TOO_BIG).
  var MAX_UPLOAD = 52428800;
  var UPLOAD_YOURSELF = 'Nahrajte ho prosím do Souborů sami ve webovém rozhraní iAuditingu (přetažením do Souborů); ' +
    'připojit ho k otázce pak můžu já.';
  // iAuditing takes text/plain at storage/upload but refused it at confirm
  // (ERR_API_STORAGE_UNSUPPORTED_MIMETYPE, VERIFY.md V5); CSV is plain text too.
  var NOT_UPLOADED = { txt: true, csv: true };

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
      return 'iAuditing přijme od Clauda jen soubory PDF, DOCX, XLSX, PPTX, ODT, PNG, JPEG, TIFF a HEIC (název „' + n + '“).';
    }
    return null;
  }

  function toBase64(buf) {
    var bytes = new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(s);
  }

  function digest(bytes) { return crypto.subtle.digest('SHA-256', bytes); }

  function hexToBase64(hex) {
    var s = '';
    for (var i = 0; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    return btoa(s);
  }

  function hasControl(s) {
    for (var i = 0; i < s.length; i++) if (s.charCodeAt(i) < 32) return true;
    return false;
  }

  // Why this file from the workspace folder can't be uploaded, or null. The
  // file is {name, path, size, sha256}: the name in Soubory, its absolute path
  // in Claude's shell, its size in bytes and its hex SHA-256.
  function fileProblem(file) {
    var problem = nameProblem(file.name);
    if (problem) return problem;
    if (NOT_UPLOADED[extension(file.name)]) return 'soubory TXT a CSV iAuditing při nahrání od Clauda odmítá. ' + UPLOAD_YOURSELF;
    if (typeof file.path !== 'string' || file.path.charAt(0) !== '/' || hasControl(file.path)) {
      return 'chybí celá cesta k souboru ve složce (začíná „/“).';
    }
    if (!(Number.isInteger(file.size) && file.size > 0)) return 'chybí velikost souboru v bajtech, změřená ve složce.';
    if (file.size > MAX_UPLOAD) {
      return 'soubor má ' + files.sizeLabel(file.size) + ', iAuditing přijme nejvýš ' + files.sizeLabel(MAX_UPLOAD) + '.';
    }
    if (!/^[0-9a-f]{64}$/.test(file.sha256)) return 'chybí kontrolní součet SHA-256 celého souboru, spočítaný ve složce.';
    return null;
  }

  // One shell word in single quotes; an inner ' becomes '\''.
  var SQ = String.fromCharCode(39);
  function shellWord(s) { return SQ + String(s).split(SQ).join(SQ + String.fromCharCode(92) + SQ + SQ) + SQ; }

  // The curl PUT Claude runs in its shell: it prints only the HTTP code.
  function curlCommand(path, url, headers) {
    var out = 'curl -sS -o /dev/null -w ' + shellWord('%{http_code}') + ' --max-time 600 -X PUT --data-binary @' + shellWord(path);
    Object.keys(headers).forEach(function (k) { out += ' -H ' + shellWord(k + ': ' + headers[k]); });
    return out + ' ' + shellWord(url);
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

  // Uploads a file from Claude's workspace folder into the zakázka's Soubory
  // without its bytes passing through Claude. After the confirmed preview the
  // page asks iAuditing for an upload URL (valid 180 s) and returns `command`,
  // a curl PUT with the signed headers, for Claude's shell; finishUpload then
  // confirms the file and reads it back (V5).
  function uploadFile(engagement, file, options) {
    file = file || {};
    var want = { name: typeof file.name === 'string' ? file.name.normalize('NFC') : file.name, path: file.path,
      size: Number(file.size), sha256: String(file.sha256 || '').toLowerCase() };
    return guarded(engagement, options, function () {
      var problem = fileProblem(want);
      if (problem) return Promise.reject(fail('BAD_FILE', 'Soubor nenahraji: ' + problem));
      return openAudit(engagement).then(function (ctx) {
        var same = ctx.docs.filter(function (d) { return files.loose(d.name) === files.loose(want.name); });
        var problems = same.length ? ['V Souborech už je soubor se stejným názvem „' + same[0].name + '“; ' +
          'nový prosím pojmenujte jinak, ať se nepletou.'] : [];
        var contentType = MIME[extension(want.name)];
        var preview = head('upload', ctx);
        preview.file = brief({ name: want.name, mimetype: contentType, size: want.size });
        return {
          problems: problems,
          sig: ['upload', ctx.audit.auditId, want.name, want.path, want.size, want.sha256, same.map(function (d) { return d.storageId; })],
          preview: preview,
          perform: function () { return requestSlot(ctx, want, contentType); },
        };
      });
    });
  }

  // Uploads waiting for Claude's curl, by storageId.
  var pending = {};

  function requestSlot(ctx, file, contentType) {
    var r = reportOf('upload', ctx);
    var base64Sha = hexToBase64(file.sha256);
    return core.apiGet('staff/me/get').then(function (me) {
      if (!me || !me.userId) throw fail('UNEXPECTED', 'iAuditing nevrátil, kdo je přihlášený.');
      var headers = { 'Content-Type': contentType, 'x-amz-checksum-sha256': base64Sha, 'if-none-match': '*',
        'x-amz-meta-uploaderid': me.userId, 'x-amz-meta-tenantid': tenant() };
      return core.apiSend('POST', 'storage/upload', { name: file.name, contentType: contentType, size: file.size,
        auditId: ctx.audit.auditId, sha256: base64Sha }).then(function (slot) {
        pending[slot.storageId] = { ctx: ctx, file: file, base64Sha: base64Sha };
        r.ok = true;
        r.done = false;
        r.storageId = slot.storageId;
        r.command = curlCommand(file.path, slot.uploadUrl, headers);
        r.message = 'iAuditing připravil místo pro soubor „' + file.name + '“; posílám ho tam přímo ze složky.';
        return r;
      });
    }).catch(function (err) {
      // A slot that is never confirmed doesn't show up in Soubory (V5).
      r.error = err.message;
      r.code = err.code;
      r.uploadYourself = true;
      r.message = 'Nahrání se nepovedlo (' + err.message + '); v Souborech nic nepřibylo. ' + UPLOAD_YOURSELF;
      return r;
    });
  }

  // Finishes an upload after Claude ran `command`: httpStatus is the code curl
  // printed. Confirms the file in Soubory and reads it back by downloading it
  // and comparing its SHA-256. Each upload is finished once.
  function finishUpload(storageId, result) {
    var p = pending[storageId];
    if (!p) {
      // Finished already, or the page reloaded since uploadFile (pending lives in the page only).
      return Promise.reject(fail('NOT_PENDING', 'Nahrání souboru ' + storageId + ' tady nečeká na dokončení (skončilo, nebo se ' +
        'stránka mezitím znovu načetla); nic neměním. Podívejte se prosím do Souborů. Pokud tam soubor není: ' + UPLOAD_YOURSELF));
    }
    delete pending[storageId];
    var ctx = p.ctx;
    var name = p.file.name;
    var r = reportOf('upload', ctx);
    r.done = true;
    var code = Number(result && result.httpStatus);
    if (code !== 200) {
      // Blocked on the way (a sandbox proxy prints 000), refused or expired:
      // the unconfirmed slot never shows up in Soubory, and Claude doesn't
      // try another route.
      r.uploadYourself = true;
      r.message = 'Soubor „' + name + '“ se mi ze složky do iAuditingu poslat nepodařilo (curl: ' + (code || '000') +
        '); v Souborech nic nepřibylo. ' + UPLOAD_YOURSELF;
      return Promise.resolve(r);
    }
    var confirmed = false;
    return core.apiSend('POST', files.docsBase(ctx.audit) + '/' + storageId + '/confirm', { name: name }).then(function () {
      confirmed = true;
      return relisted(ctx);
    }).then(function (docs) {
      var d = docs && docs.filter(function (x) { return x.storageId === storageId; })[0];
      if (!d || d.name !== name || d.size !== p.file.size) {
        r.readBack = docs ? 'NESOUHLASÍ' : 'neověřeno';
        return null;
      }
      r.file = files.publicFile(d);
      return files.download(ctx.audit, d).then(digest).then(function (hash) {
        r.readBack = toBase64(hash) === p.base64Sha ? 'OK' : 'NESOUHLASÍ';
      });
    }).then(function () {
      r.ok = r.readBack === 'OK';
      r.message = r.ok ? 'Soubor „' + name + '“ je v Souborech zakázky, kontrola po nahrání sedí (stažený obsah je shodný).'
        : 'Soubor jsem odeslal, ale kontrola po nahrání nesouhlasí (' + r.readBack + '). Dál nic neměním; zkontrolujte prosím Soubory.';
      return r;
    }, function (err) {
      if (confirmed) return failed(r, err, 'Kontrola po nahrání');
      failed(r, err, 'Dokončení nahrání');
      // A refused confirm leaves nothing in Soubory; an uncertain one may have.
      r.uploadYourself = true;
      r.message += r.uncertain ? ' Pokud soubor v Souborech není: ' + UPLOAD_YOURSELF : ' V Souborech nic nepřibylo. ' + UPLOAD_YOURSELF;
      return r;
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

  iaud.uploadFile = uploadFile;
  iaud.finishUpload = finishUpload;
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
