// iaud-procedure: actions on a whole procedure: the AI Shrnutí (#29) and
// submitting for review (#30). Loaded after iaud.js and iaud-write.js (same
// version); evaluates to "iaud-procedure <version> loaded, délka <n>, hash <h>".
// Rails as in iaud-write: allowlist → role → in progress → preview → "ano" →
// one action → read back, never repeated (PLAN §5).
(function installProcedure(root) {
  'use strict';

  var VERSION = '0.6.0';
  var NAME = 'iaud-procedure';

  var isModule = typeof module === 'object' && module.exports;
  var iaud = isModule ? require('./iaud-write.js') : root.iaud;
  if (!iaud || !iaud._internal) {
    return NAME + ': nejdřív je potřeba načíst iaud.js a iaud-write.js (verze ' + VERSION + ').';
  }
  if (iaud.version !== VERSION) {
    return NAME + ' ' + VERSION + ': načtené iaud.js je jiné verze (' + iaud.version + '). Načtěte znovu všechny soubory.';
  }
  var core = iaud._internal;
  var writing = core.write;
  if (!writing || !iaud.extensions['iaud-write']) {
    return NAME + ': nejdřív je potřeba načíst iaud-write.js (verze ' + VERSION + ').';
  }

  function fail(code, message) { return core.apiError(code, message); }

  // -- Procedure-level rails (confirmations: writing.guarded of iaud-write)

  // The rails of a change to a whole procedure: those of the zakázka, then a
  // procedure in progress (the app also lets a reviewer edit "V revizi"; the
  // plugin doesn't). Resolves to {audit, procedure, number, name, base}.
  function openProcedureForChange(engagement, procedure) {
    var ctx;
    return writing.openAuditForWrite(engagement).then(function (opened) {
      ctx = opened;
      return core.apiGet('audits/audit/' + ctx.audit.auditId + '/procedures/list');
    }).then(function (list) {
      var p = core.findProcedure(list, procedure, ctx.audit);
      ctx.procedure = p;
      ctx.number = core.procedureNumber(p.displayId || (p.template || {}).displayId);
      ctx.name = p.name || (p.template || {}).name;
      ctx.base = core.procedureBase(ctx.audit, p);
      if (p.status !== 'in_progress') {
        throw fail('NOT_EDITABLE', 'Procedura ' + ctx.number + ' je ve stavu „' + core.procedureStatus(p) +
          '“; teď v ní nic měnit nejde.');
      }
      return ctx;
    });
  }

  var CHANGED = 'v iAuditingu nebo v tom, co se má změnit';

  function head(ctx, action, label) {
    return { auditId: ctx.audit.auditId, client: ctx.audit.client && ctx.audit.client.name, procedureId: ctx.procedure.procedureId,
      number: ctx.number, name: ctx.name, action: action, actionLabel: label };
  }

  // -- Shrnutí (#29): summary/get → {procedureId, summary}; summary/update
  // PATCH {summary} (≤ 30 000 chars after NFC); summary/generate POST without
  // a body streams the AI's answer (AI SDK UI message stream, PLAN §2).

  var MAX_SUMMARY = 30000;
  var OVERWRITE = 'Nové Shrnutí trvale přepíše současné. Současné je celé v tomto náhledu, takže ho jde později vrátit.';

  function readSummary(ctx) {
    return core.apiGet(ctx.base + '/summary/get').then(function (s) {
      if (!s || typeof s.summary !== 'string' && s.summary !== null) {
        throw fail('UNEXPECTED', 'iAuditing vrátil Shrnutí v nečekané podobě; nic neměním.');
      }
      return s.summary || '';
    });
  }

  function shown(text, options) {
    return options.redact && text ? core.redacted(text, options) : text;
  }

  function summaryInfo(text, options) {
    return { summary: shown(text, options), chars: text.length, empty: core.isBlank(text) };
  }

  function fileCounts(ctx) {
    return core.apiGet('audits/audit/' + ctx.audit.auditId + '/documents/list').then(function (list) {
      var active = (list || []).filter(function (d) { return d.status === 'active'; });
      return { count: active.length, embedded: active.filter(function (d) { return d.embedStatus === 'embedded'; }).length };
    });
  }

  // A generation outlives one JavaScript call (Cowork stops at ~45 s, V5): it
  // runs in the page, kept on window; the same call with the same
  // confirmation picks it up later (`pending` until then), never a second one.
  iaud.summaryWaitMs = 30000;
  iaud.summaryMaxMs = 240000;
  var runs = root.__iaudSummaryRuns || (root.__iaudSummaryRuns = {});
  var starting = Object.create(null);

  function running(procedureId) {
    return Object.keys(runs).some(function (k) { return runs[k].procedureId === procedureId && !runs[k].done; });
  }

  function busy(ctx) {
    return fail('BUSY', 'Shrnutí procedury ' + ctx.number + ' se právě generuje. Počkejte, až doběhne ' +
      '(stejné volání se stejným potvrzením), a teprve pak dělejte další změnu Shrnutí.');
  }

  // Reads server-sent events ("data: {json}" blocks, "[DONE]" at the end) and
  // hands each parsed chunk to onChunk.
  var NL = String.fromCharCode(10);
  var CR = String.fromCharCode(13);
  var LINE = new RegExp(CR + '?' + NL);
  var BLANK_LINE = new RegExp(CR + '?' + NL + CR + '?' + NL);

  function readEvents(body, onChunk) {
    var reader = body.getReader();
    var decoder = new TextDecoder();
    var buf = '';
    var event = function (block) {
      var data = block.split(LINE).filter(function (l) { return l.indexOf('data:') === 0; })
        .map(function (l) { return l.slice(5).replace(/^ /, ''); }).join(NL);
      if (!data || data === '[DONE]') return;
      var chunk;
      try { chunk = JSON.parse(data); } catch (e) { return; }
      if (chunk && typeof chunk === 'object') onChunk(chunk);
    };
    var drain = function () {
      var m;
      while ((m = BLANK_LINE.exec(buf))) {
        event(buf.slice(0, m.index));
        buf = buf.slice(m.index + m[0].length);
      }
    };
    var next = function () {
      return reader.read().then(function (step) {
        if (step.done) {
          buf += decoder.decode();
          drain();
          if (buf.trim()) event(buf);
          return null;
        }
        buf += decoder.decode(step.value, { stream: true });
        drain();
        return next();
      });
    };
    return next();
  }

  // One chunk of the AI SDK UI message stream: the text is the text parts
  // joined in order (as the app's editor shows it); reasoning is left out.
  function onChunk(run, c) {
    var part;
    if (c.type === 'text-start' || (c.type === 'text-delta' && !run.byId[c.id])) {
      part = { text: '' };
      run.byId[c.id] = part;
      run.parts.push(part);
    }
    if (c.type === 'text-delta' && typeof c.delta === 'string') {
      run.byId[c.id].text += c.delta;
      run.chars += c.delta.length;
      run.phase = 'píše shrnutí';
    }
    if ((c.type === 'tool-input-start' || c.type === 'tool-input-available') && c.toolName) {
      if (run.tools.indexOf(c.toolName) === -1) run.tools.push(c.toolName);
      run.phase = 'prochází dokumenty zakázky';
    }
    if (c.type === 'error') run.error = String(c.errorText || 'chyba bez popisu');
    if (c.type === 'abort') run.error = 'generování se přerušilo';
    if (c.type === 'finish' && c.finishReason) run.finishReason = c.finishReason;
  }

  // POST summary/generate (no body, like the app) and the whole stream.
  function stream(ctx, run) {
    var uncertain = function (err) { err.uncertain = true; return err; };
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () {
      run.timedOut = true;
      if (controller) controller.abort();
    }, iaud.summaryMaxMs);
    return core.throttle().then(function () {
      return fetch('/api/v2/' + ctx.base + '/summary/generate', { method: 'POST', signal: controller ? controller.signal : undefined });
    }).catch(function () {
      throw uncertain(fail('NETWORK', 'Spojení s iAuditingem se přerušilo a nevím, jestli se shrnutí generovalo.'));
    }).then(function (r) {
      var type = r.headers.get('content-type') || '';
      if (r.status === 401 || (r.redirected && type.indexOf('html') !== -1)) {
        throw fail('LOGGED_OUT', 'Nejste přihlášen/a do iAuditingu. Přihlaste se v Chrome a znovu importujte přihlášení ' +
          'do panelu Prohlížeč (v Claude Desktop: import uložených přihlášení z Chrome).');
      }
      if (type.indexOf('application/json') !== -1) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          var e = (j && j.error) || {};
          var err = fail(e.code || 'HTTP_' + r.status, 'iAuditing vrátil chybu ' + r.status + (e.code ? ' ' + e.code : '') + ': ' +
            (e.czech || e.message || 'bez popisu') + '.');
          if (r.ok) err.uncertain = true;
          throw err;
        });
      }
      if (!r.ok || !r.body || type.indexOf('html') !== -1) {
        throw uncertain(fail('UNEXPECTED', 'iAuditing odpověděl na generování neočekávaně (HTTP ' + r.status + ', ' + (type || 'bez typu') + ').'));
      }
      run.phase = 'připravuje podklady';
      return readEvents(r.body, function (c) { onChunk(run, c); }).catch(function (e) {
        throw uncertain(fail(run.timedOut ? 'TIMEOUT' : 'NETWORK', run.timedOut
          ? 'Generování trvalo déle než ' + Math.round(iaud.summaryMaxMs / 60000) + ' minuty, zastavil jsem ho.'
          : 'Spojení se během generování přerušilo (' + e.message + ').'));
      });
    }).then(function (res) {
      clearTimeout(timer);
      return res;
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }

  // After the stream: store the text the way the app does (it saves the
  // finished text with summary/update unless iAuditing already has it), then
  // read it back. Never rejects: every outcome is a report.
  function finishGeneration(ctx, run, previous, options, streamError) {
    var report = head(ctx, 'generate', run.label);
    report.previous = summaryInfo(previous, options);
    report.tools = run.tools;
    report.finishReason = run.finishReason;
    report.open = { auditId: ctx.audit.auditId, procedureId: ctx.procedure.procedureId };
    var raw = run.parts.map(function (p) { return p.text; }).join('');
    var text = raw.normalize('NFC');
    var problem = streamError ? streamError.message : run.error ? 'umělá inteligence iAuditingu nahlásila chybu: ' + run.error
      : core.isBlank(text) ? 'umělá inteligence iAuditingu nevrátila žádný text' : null;
    var stored;
    var done = function (ok, readBack, message) {
      report.ok = ok;
      report.readBack = readBack;
      report.message = message;
      return report;
    };
    if (problem) {
      report.error = problem;
      report.uncertain = Boolean(streamError && streamError.uncertain);
      if (streamError && streamError.code) report.code = streamError.code;
      return readSummary(ctx).then(function (now) {
        var same = now === previous;
        report.stored = summaryInfo(now, options);
        return done(false, same ? 'beze změny' : 'změněno', 'Generování Shrnutí se nepovedlo (' + problem + '). ' + (same
          ? 'Uložené Shrnutí je beze změny.' : 'Uložené Shrnutí se ale změnilo; zkontrolujte ho prosím v iAuditingu.') +
          ' Znovu to nezkouším.');
      });
    }
    report.summary = shown(text, options);
    report.chars = text.length;
    return readSummary(ctx).then(function (now) {
      if (now === text || now === raw) {
        report.savedBy = 'iAuditing';
        return done(true, 'OK', 'Nové Shrnutí je vygenerované a uložené (' + text.length + ' znaků), kontrola sedí.');
      }
      if (now !== previous) {
        report.stored = summaryInfo(now, options);
        return done(false, 'NESOUHLASÍ', 'Shrnutí se v iAuditingu během generování změnilo jinak, než jsem čekal; ' +
          'nic dalšího neukládám. Zkontrolujte ho prosím v iAuditingu.');
      }
      if (text.length > MAX_SUMMARY) {
        return done(false, 'neuloženo', 'Vygenerované Shrnutí má ' + text.length + ' znaků, iAuditing jich uloží nejvýš 30 000; ' +
          'neuložil jsem ho, uložené Shrnutí je beze změny.');
      }
      report.savedBy = 'plugin';
      return core.apiSend('PATCH', ctx.base + '/summary/update', { summary: text }).then(function () {
        return readSummary(ctx);
      }, function (err) {
        report.error = err.message;
        report.code = err.code;
        report.uncertain = Boolean(err.uncertain);
        return readSummary(ctx).then(function (after) {
          stored = after;
          return null;
        });
      }).then(function (after) {
        if (report.error) {
          report.stored = summaryInfo(stored, options);
          return done(false, stored === text ? 'uloženo' : stored === previous ? 'neuloženo' : 'nejasné',
            'Shrnutí se vygenerovalo, ale uložení se nepovedlo (' + report.error + '). Znovu to nezkouším.');
        }
        return after === text
          ? done(true, 'OK', 'Nové Shrnutí je vygenerované a uložené (' + text.length + ' znaků), kontrola sedí.')
          : done(false, 'NESOUHLASÍ', 'Kontrola po uložení Shrnutí nesouhlasí; dál nic neměním. Zkontrolujte ho prosím v iAuditingu.');
      });
    });
  }

  function startRun(ctx, previous, options, label) {
    var run = { procedureId: ctx.procedure.procedureId, number: ctx.number, label: label, done: false, started: Date.now(),
      parts: [], byId: {}, tools: [], chars: 0, error: null, finishReason: null, phase: 'začíná' };
    run.promise = stream(ctx, run).then(function () {
      return finishGeneration(ctx, run, previous, options, null);
    }, function (err) {
      return finishGeneration(ctx, run, previous, options, err);
    }).catch(function (err) {
      var report = head(ctx, 'generate', label);
      report.ok = false;
      report.error = err.message;
      report.message = 'Po generování se nepodařilo ověřit, co je v iAuditingu uložené (' + err.message + '). ' +
        'Znovu to nezkouším; zkontrolujte prosím Shrnutí v iAuditingu.';
      return report;
    }).then(function (report) {
      report.ms = Date.now() - run.started;
      run.report = report;
      run.done = true;
      return report;
    });
    return run;
  }

  // The run's report, or {pending: true} if it isn't done within summaryWaitMs.
  function settle(run) {
    if (run.done) return Promise.resolve(run.report);
    var timer;
    var late = new Promise(function (resolve) { timer = setTimeout(function () { resolve(null); }, iaud.summaryWaitMs); });
    return Promise.race([run.promise, late]).then(function (report) {
      clearTimeout(timer);
      if (report) return report;
      return { pending: true, action: 'generate', number: run.number, phase: run.phase, chars: run.chars,
        seconds: Math.round((Date.now() - run.started) / 1000),
        message: 'Shrnutí procedury ' + run.number + ' se ještě generuje (' + run.phase + ', zatím ' + run.chars + ' znaků). ' +
          'Zavolejte prosím stejnou funkci se stejným potvrzením za chvíli; generování neopakuji.' };
    });
  }

  var GENERATE_LABEL = 'vygenerování nového Shrnutí umělou inteligencí iAuditingu a jeho uložení';

  // The app's "Shrnout": {dryRun: true} gives the preview (the current
  // Shrnutí in full) with `confirm`; {confirm} starts the generation once,
  // and the same call again returns its result (or `pending`).
  function generateSummary(engagement, procedure, options) {
    options = options || {};
    var token = options.confirm;
    var own = function (map) { return typeof token === 'string' && Object.prototype.hasOwnProperty.call(map, token); };
    if (!options.dryRun && own(runs)) return settle(runs[token]);
    if (!options.dryRun && own(starting)) return starting[token];
    var result = writing.guarded(engagement, options, 'g', CHANGED, function () {
      var ctx;
      return openProcedureForChange(engagement, procedure).then(function (opened) {
        ctx = opened;
        if (running(ctx.procedure.procedureId)) throw busy(ctx);
        return readSummary(ctx);
      }).then(function (current) {
        return { problems: [], sig: ['generate', ctx.audit.auditId, ctx.procedure.procedureId, current], perform: function () {
          runs[token] = startRun(ctx, current, options, GENERATE_LABEL);
          return settle(runs[token]);
        }, preview: function () {
          return fileCounts(ctx).then(function (files) {
            var preview = head(ctx, 'generate', GENERATE_LABEL);
            preview.status = core.procedureStatus(ctx.procedure);
            preview.progress = writing.progressText(writing.sum(ctx.procedure.components || []));
            preview.files = files;
            preview.current = summaryInfo(current, options);
            if (!preview.current.empty) preview.warning = OVERWRITE;
            return preview;
          });
        } };
      });
    });
    // A second call while this one starts gets the same result, never a second run.
    if (!options.dryRun && typeof token === 'string') starting[token] = result;
    return result;
  }

  var UPDATE_LABELS = { update: 'úprava Shrnutí', clear: 'vymazání Shrnutí' };
  var CLEAR_WARNING = 'Shrnutí bude prázdné. S prázdným Shrnutím iAuditing nedovolí odeslat proceduru ke kontrole.';

  // Replaces the Shrnutí with `text` (all of it; '' empties it), e.g. to
  // restore a kept text. {dryRun: true}: preview (old and new in full) with
  // `confirm`; {confirm} saves it once and reads it back.
  function updateSummary(engagement, procedure, text, options) {
    options = options || {};
    if (typeof text !== 'string') {
      return Promise.reject(fail('BAD_TEXT', 'Nové Shrnutí předávám jako text (prázdný text Shrnutí vymaže).'));
    }
    var wanted = text.normalize('NFC');
    return writing.guarded(engagement, options, 'u', CHANGED, function () {
      var ctx;
      return openProcedureForChange(engagement, procedure).then(function (opened) {
        ctx = opened;
        if (running(ctx.procedure.procedureId)) throw busy(ctx);
        return readSummary(ctx);
      }).then(function (old) {
        var action = wanted === '' ? 'clear' : 'update';
        var problems = [];
        if (wanted === old) problems.push('Shrnutí už má přesně tento text; není co měnit.');
        if (wanted.length > MAX_SUMMARY) problems.push('Nové Shrnutí má ' + wanted.length + ' znaků, iAuditing jich přijme nejvýš 30 000.');
        return { problems: problems, sig: ['update', ctx.audit.auditId, ctx.procedure.procedureId, old, wanted],
          perform: function () { return saveSummary(ctx, action, old, wanted, options); }, preview: function () {
            var preview = head(ctx, action, UPDATE_LABELS[action]);
            preview.old = summaryInfo(old, options);
            preview.new = summaryInfo(wanted, options);
            if (action === 'clear') preview.warning = CLEAR_WARNING;
            if (wanted !== text) preview.note = 'Písmena s diakritikou uložím v jednotném zápisu, jak to iAuditing dělá.';
            return preview;
          } };
      });
    });
  }

  // The one summary/update, then the read-back (PLAN §5).
  function saveSummary(ctx, action, old, wanted, options) {
    var started = Date.now();
    var report = head(ctx, action, UPDATE_LABELS[action]);
    report.previous = summaryInfo(old, options);
    report.chars = wanted.length;
    report.open = { auditId: ctx.audit.auditId, procedureId: ctx.procedure.procedureId };
    var failed = null;
    return core.apiSend('PATCH', ctx.base + '/summary/update', { summary: wanted }).catch(function (err) {
      failed = err;
    }).then(function () {
      return readSummary(ctx).catch(function (err) { report.unread = err.message; return null; });
    }).then(function (now) {
      var same = now === wanted;
      if (now === null) {
        report.readBack = 'neověřeno';
      } else if (failed) {
        report.readBack = same ? 'uloženo' : now === old ? 'neuloženo' : 'nejasné';
      } else {
        report.readBack = same ? 'OK' : 'NESOUHLASÍ';
      }
      if (now !== null && !same) report.stored = summaryInfo(now, options);
      report.ok = !failed && report.readBack === 'OK';
      if (failed) {
        report.error = failed.message;
        report.code = failed.code;
        report.uncertain = Boolean(failed.uncertain);
      }
      report.message = report.ok
        ? (action === 'clear' ? 'Shrnutí je vymazané' : 'Shrnutí je uložené (' + wanted.length + ' znaků)') + ', kontrola po uložení sedí.'
        : failed ? 'Uložení Shrnutí se nepovedlo (' + failed.message + ')' + (report.uncertain
          ? ' a není jisté, jestli se uložilo (kontrola: ' + report.readBack + ')' : '') + '. Znovu to nezkouším.'
          : now === null ? 'Shrnutí jsem odeslal, ale nepodařilo se ho ověřit (' + report.unread + '). Dál nic neměním.'
            : 'Kontrola po uložení Shrnutí nesouhlasí; dál nic neměním. Zkontrolujte ho prosím v iAuditingu.';
      report.ms = Date.now() - started;
      return report;
    });
  }

  // -- Submitting for review (#30): PATCH …/status/submit {preparedAt,
  // preparedBy} like the app's "Dokončit" (PLAN §2). iAuditing refuses an
  // unfinished procedure or an empty Shrnutí; the preview stops at both.

  var SUBMIT_LABEL = 'odeslání procedury ke kontrole';
  var SUBMIT_NOTE = 'Po odeslání už v proceduře nepůjde nic měnit, dokud ji revizor nevrátí (nebo ji sami nevrátíte ' +
    've webovém rozhraní tlačítkem „Vrátit“).';

  function czechDate(iso) { return core.displayAnswer('date', String(iso).slice(0, 10)); }

  function plural(n, one, few, many) { return n === 1 ? one : n >= 2 && n <= 4 ? few : many; }

  // What the preview shows and the confirmation covers.
  function submitState(ctx, options) {
    var s = { audit: ctx.audit.auditId, procedure: ctx.procedure.procedureId };
    return core.apiGet('audits/audit/' + s.audit + '/team/me').then(function (me) {
      s.me = me && me.staffId;
      return readSummary(ctx);
    }).then(function (summary) {
      s.summaryHash = core.fnv1a(summary);
      s.summary = { chars: summary.length, empty: core.isBlank(summary) };
      return iaud.readAnswers(s.audit, [s.procedure], { redact: options.redact });
    }).then(function (read) {
      var p = read.procedures[0];
      var brief = function (i) {
        var out = { no: i.no, question: i.question };
        if (i.section) out.section = i.section;
        if (i.draft && !i.empty) out.source = i.mark.source;
        return out;
      };
      var items = p.items.filter(function (i) { return !i.heading && !i.hidden; });
      s.progress = p.progress;
      s.readOnly = p.readOnly;
      s.unanswered = items.filter(function (i) { return i.empty; }).map(brief);
      s.drafts = items.filter(function (i) { return !i.empty && i.draft; }).map(brief);
      s.keys = items.map(function (i) { return [i.questionId, i.sectionId, i.empty, i.draft]; });
      // The app's defaults: the stored values, else today (local date) and the user.
      s.preparedAt = ctx.procedure.preparedAt ? String(ctx.procedure.preparedAt).slice(0, 10) : new Date().toLocaleDateString('sv-SE');
      s.preparedBy = ctx.procedure.preparedBy || s.me;
      s.prepared = { by: s.preparedBy === s.me ? 'vy' : 'jiný člen týmu', at: s.preparedAt };
      return s;
    });
  }

  // {dryRun: true} gives the preview with `confirm`; {confirm} sends
  // status/submit once and reads the status back.
  function submitProcedure(engagement, procedure, options) {
    options = options || {};
    return writing.guarded(engagement, options, 'p', CHANGED, function () {
      var ctx;
      return openProcedureForChange(engagement, procedure).then(function (opened) {
        ctx = opened;
        if (running(ctx.procedure.procedureId)) throw busy(ctx);
        return submitState(ctx, options);
      }).then(function (s) {
        return submitPlan(ctx, s);
      });
    });
  }

  // The problems, warnings and confirmation of a submit from its state.
  function submitPlan(ctx, s) {
    var problems = [];
    var warnings = [];
    var n = s.unanswered.length;
    if (n) {
      problems.push('Procedura není hotová: zůstávají nevyplněné ' + n + ' ze ' + s.progress.split('/')[1] +
        ' otázek. iAuditing ji ke kontrole nepřijme; nejdřív je potřeba je vyplnit.');
    }
    if (s.summary.empty) {
      problems.push('Shrnutí je prázdné; s prázdným Shrnutím iAuditing proceduru nepřijme. Nejdřív ho vygenerujte nebo napište.');
    }
    if (ctx.audit.deadline && s.preparedAt > String(ctx.audit.deadline).slice(0, 10)) {
      problems.push('Datum přípravy (' + czechDate(s.preparedAt) + ') je po termínu zakázky (' + czechDate(ctx.audit.deadline) +
        '); takové odeslání iAuditing nepřijme.');
    }
    if (s.drafts.length) {
      warnings.push(s.drafts.length + ' ' + plural(s.drafts.length, 'odpověď je stále označená', 'odpovědi jsou stále označené',
        'odpovědí je stále označeno') + ' jako návrh k ověření ([NÁVRH – ověřit]); před odesláním je prosím potvrďte nebo opravte.');
    }
    var stored = writing.sum(ctx.procedure.components || []);
    if (stored.total && writing.progressText(stored) !== s.progress) {
      warnings.push('Počítadlo postupu v iAuditingu ukazuje ' + writing.progressText(stored) + ', podle odpovědí je to ' + s.progress +
        '; iAuditing může odeslání odmítnout, dokud ho nepřepočítá (stačí otevřít proceduru ve webu).');
    }
    if (s.readOnly) warnings.push('Část procedury je jen ve webovém rozhraní; zkontrolujte prosím tam, že je hotová.');
    warnings.push(SUBMIT_NOTE);
    return { problems: problems, sig: ['submit', s.audit, s.procedure, s.progress, s.keys, s.summaryHash, s.preparedAt, s.preparedBy],
      perform: function () { return sendSubmit(ctx, s); }, preview: function () {
        var preview = head(ctx, 'submit', SUBMIT_LABEL);
        preview.status = core.procedureStatus(ctx.procedure);
        ['progress', 'unanswered', 'drafts', 'summary', 'prepared'].forEach(function (k) { preview[k] = s[k]; });
        preview.warnings = warnings;
        return preview;
      } };
  }

  // The one status/submit, then the status read back (PLAN §5).
  function sendSubmit(ctx, s) {
    var started = Date.now();
    var report = head(ctx, 'submit', SUBMIT_LABEL);
    report.prepared = s.prepared;
    report.open = { auditId: ctx.audit.auditId, procedureId: ctx.procedure.procedureId };
    var failed = null;
    var answer = null;
    return core.apiSend('PATCH', ctx.base + '/status/submit', { preparedAt: s.preparedAt, preparedBy: s.preparedBy }).then(function (res) {
      answer = res;
    }, function (err) {
      failed = err;
    }).then(function () {
      return core.apiGet(ctx.base + '/get').catch(function (err) { report.unread = err.message; return null; });
    }).then(function (now) {
      var sent = now && now.status === 'under_review';
      if (now) report.status = core.procedureStatus(now);
      if (!now) report.readBack = 'neověřeno';
      else if (failed) report.readBack = sent ? 'odesláno' : now.status === 'in_progress' ? 'neodesláno' : 'nejasné';
      // Only the status read back counts; the reply's shape was never seen live (extra info only).
      else report.readBack = sent ? 'OK' : 'NESOUHLASÍ';
      if (answer && answer.newStatus) report.newStatus = answer.newStatus;
      report.ok = !failed && report.readBack === 'OK';
      if (failed) {
        report.error = failed.message;
        report.code = failed.code;
        report.uncertain = Boolean(failed.uncertain);
      }
      report.message = report.ok
        ? 'Procedura ' + ctx.number + ' je odeslaná ke kontrole (stav „' + report.status + '“), kontrola sedí.'
        : failed ? 'Odeslání ke kontrole se nepovedlo (' + failed.message + ')' + (now ? '; procedura je ve stavu „' + report.status + '“' : '') +
          '. Znovu to nezkouším.'
          : !now ? 'Proceduru jsem odeslal, ale nepodařilo se ověřit její stav (' + report.unread + '). Dál nic neměním.'
            : 'Kontrola po odeslání nesouhlasí: procedura je ve stavu „' + report.status + '“. Dál nic neměním; zkontrolujte ji prosím v iAuditingu.';
      report.ms = Date.now() - started;
      return report;
    });
  }

  iaud.generateSummary = generateSummary;
  iaud.updateSummary = updateSummary;
  iaud.submitProcedure = submitProcedure;

  // The self-check covers this whole function as the browser parsed it.
  var source = String(installProcedure);
  iaud.extensions[NAME] = 'délka ' + source.length + ', hash ' + core.fnv1a(source);
  if (isModule) module.exports = iaud;
  return NAME + ' ' + VERSION + ' loaded, ' + iaud.extensions[NAME];
})(typeof window !== 'undefined' ? window : globalThis);
