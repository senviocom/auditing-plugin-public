// iaud-write: the write part of the iauditing plugin's helper. Claude passes
// this whole file to the browser's JavaScript tool after references/iaud.js,
// the first time a task needs to change something in iAuditing. It extends
// window.iaud (same version only) and evaluates to "iaud-write <version>
// loaded, délka <n>, hash <h>", which the skill compares with SKILL.md.
// Every write: allowlist → role → dry run (preview) → the user's "ano" →
// write → read back → progress, at the core's pace, never repeated (PLAN §5).
(function installWrite(root) {
  'use strict';

  var VERSION = '0.6.0';
  var NAME = 'iaud-write';

  var isModule = typeof module === 'object' && module.exports;
  var iaud = isModule ? require('./iaud.js') : root.iaud;
  if (!iaud || !iaud._internal) {
    return NAME + ': nejdřív je potřeba načíst iaud.js (verze ' + VERSION + ').';
  }
  if (iaud.version !== VERSION) {
    return NAME + ' ' + VERSION + ': načtené iaud.js je jiné verze (' + iaud.version + '). Načtěte znovu oba soubory.';
  }
  var core = iaud._internal;

  // During development only the test engagement may be written (CLAUDE.md).
  // Opening the plugin to the user's other engagements is Senvio's decision.
  var WRITE_ALLOWLIST = [{ auditId: '26d7112b-9bec-44ee-8000-48d150f3b161', client: 'PROBIS Audit a.s.' }];

  // Roles that carry audit:procedure:prepare; each inherits the ones below it (V8 §9).
  var PREPARE_ROLES = ['assistant-auditor', 'reviewer', 'audit-manager', 'auditor'];

  var MAX_FIELD = 16384;
  var MAX_ITEMS = 40;
  var NL = String.fromCharCode(10);

  // The source line in description (PLAN §4, #17): the tag first, then the
  // source; a draft the auditor confirmed in chat has no tag (#20). The
  // core's splitDescription reads it back.
  var MARKS = { fact: '[FAKT] ', draft: '[NÁVRH – ověřit] ', confirmed: '' };
  var KIND_LABELS = { fact: 'fakt', draft: 'návrh – ověřit', confirmed: 'potvrzeno auditorem' };

  var ACTION_LABELS = {
    created: 'nová odpověď',
    updated: 'přepsání odpovědi',
    cleared: 'vymazání odpovědi',
    source: 'jen označení zdroje',
    unchanged: 'beze změny',
  };
  var CLEAR_NOTE = 'Odpověď se vymaže. Prázdný řádek odpovědi v iAuditingu zůstane (smazat ho nejde), ' +
    'v aplikaci vypadá jako nevyplněná otázka.';

  function reason(text) { return new Error(text); }

  // "Ano" / "ne" / "true" → true/false; anything else → null.
  var YES = ['ano', 'true', 'yes'];
  var NO = ['ne', 'false', 'no'];
  function yesNo(answer) {
    var word = core.normalizeName(answer);
    return YES.indexOf(word) !== -1 ? true : NO.indexOf(word) !== -1 ? false : null;
  }

  // The options of a select question, each once (152 lists one twice, V8 §4).
  function optionsOf(q) {
    var out = [];
    (q.selectOptions || []).forEach(function (o) {
      if (typeof o === 'string' && o !== '' && out.indexOf(o) === -1) out.push(o);
    });
    if (!out.length) throw reason('otázka nemá žádné možnosti na výběr; použijte web.');
    return out;
  }

  // Case and spacing (incl. the non-breaking space, which \s covers) don't matter.
  function loose(text) {
    return String(text).normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function quoteList(list) {
    return list.map(function (o) { return '„' + o + '“'; }).join(', ');
  }

  // The option the user meant, exactly as iAuditing lists it: the same text
  // first, then the same text up to case and spaces, if only one option fits.
  function matchOption(input, options) {
    var same = options.filter(function (o) { return o === input || o.normalize('NFC') === input; });
    if (same.length === 1) return same[0];
    var key = loose(input);
    var near = options.filter(function (o) { return loose(o) === key; });
    if (near.length === 1) return near[0];
    if (near.length > 1) {
      throw reason('„' + oneLine(input) + '“ odpovídá víc možností (' + quoteList(near) + '); napište prosím, kterou přesně.');
    }
    throw reason('možnost „' + oneLine(input) + '“ u otázky není. Na výběr je: ' + options.join(', ') + '.');
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  // "31. 12. 2026", "31.12.2026" or "2026-12-31" → "2026-12-31"; a day that
  // doesn't exist (31. 2.) or a year outside 1900–2100 → null.
  function parseDate(text) {
    var s = String(text).replace(/\s+/g, ' ').trim();
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    var y, mo, d;
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; } else {
      m = /^(\d{1,2}) ?\. ?(\d{1,2}) ?\. ?(\d{4})$/.exec(s);
      if (!m) return null;
      d = +m[1]; mo = +m[2]; y = +m[3];
    }
    if (y < 1900 || y > 2100) return null;
    var date = new Date(Date.UTC(y, mo - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
    return y + '-' + pad(mo) + '-' + pad(d);
  }

  // A stored answer as the app shows it in the form (dates as 31.12.2026).
  function readable(type, stored) {
    var d = type === 'date' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(stored);
    if (d) return d[3] + '.' + d[2] + '.' + d[1];
    return core.displayAnswer(type, stored);
  }

  // How an answer is stored, per question type (V8 §4): the stored string, or
  // a thrown Czech reason. yes_no_na, short_text and unknown types stay
  // read-only until one is seen live (PLAN §2); readOnlyReason refuses them.
  var WRITERS = {
    text: function (answer) { return answer; },
    yes_no: function (answer) {
      var v = yesNo(answer);
      if (v === null) throw reason('u otázky Ano/Ne zapíšu jen „Ano“, nebo „Ne“ (zadáno „' + oneLine(answer) + '“).');
      return v ? 'true' : 'false';
    },
    single_select: function (answer, q) {
      return matchOption(answer, optionsOf(q));
    },
    // In the order the app lists the options (not the order typed), each once:
    // the stored text then doesn't depend on how the user said it.
    multi_select: function (answer, q) {
      var options = optionsOf(q);
      if (options.some(function (o) { return o.indexOf(';') !== -1; })) {
        throw reason('některá možnost obsahuje středník, takže ji neumím bezpečně zapsat; použijte web.');
      }
      var chosen = answer.split(';').filter(function (part) { return !core.isBlank(part); }).map(function (part) {
        return matchOption(part, options);
      });
      if (!chosen.length) throw reason('nevybrali jste žádnou možnost (víc možností oddělte středníkem).');
      return options.filter(function (o) { return chosen.indexOf(o) !== -1; }).join(';');
    },
    date: function (answer) {
      var iso = parseDate(answer);
      if (!iso) throw reason('„' + oneLine(answer) + '“ není platné datum; napište ho jako 31. 12. 2026.');
      return iso;
    },
  };

  function fail(code, message) { return core.apiError(code, message); }

  function withMark(auditor, line) {
    if (!line) return auditor;
    return auditor === '' ? line : auditor + NL + NL + line;
  }

  function oneLine(text) {
    return String(text || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  }

  function allowed(auditId) {
    return WRITE_ALLOWLIST.some(function (a) { return a.auditId === auditId; });
  }

  // Before any request: an ID or name that can't be on the allowlist is refused.
  function mayBeAllowed(engagement) {
    var id = String(engagement || '').trim().toLowerCase();
    var name = core.normalizeName(engagement);
    return WRITE_ALLOWLIST.some(function (a) {
      return a.auditId === id || (name && core.normalizeName(a.client).indexOf(name) !== -1);
    });
  }

  function notAllowed() {
    return fail('NOT_ALLOWED', 'Zapisovat do iAuditingu teď smím jen do zakázky ' +
      WRITE_ALLOWLIST.map(function (a) { return a.client; }).join(', ') +
      ' (zkušební verze pluginu). Tuto změnu prosím udělejte ve webovém rozhraní iAuditingu.');
  }

  // -- Confirmations, shared by every change of every helper file. A dry run
  // issues one for exactly what it showed; a change takes it once, at its very
  // first check, before any request, so two calls with the same one can't both
  // write. If the state then differs from the preview, it stays spent.
  var issued = Object.create(null);
  var used = Object.create(null);
  var counter = 0;

  function issue(prefix, sig) {
    var token = prefix + (++counter) + '-' + core.fnv1a(sig);
    issued[token] = { prefix: prefix, sig: sig };
    return token;
  }

  // Takes the confirmation for a change of this kind; null, or why not.
  function take(token, prefix) {
    var t = typeof token === 'string' ? issued[token] : null;
    if (!t || t.prefix !== prefix) {
      return fail('NEEDS_PREVIEW', 'Bez náhledu potvrzeného uživatelem nic nezměním; nejdřív je potřeba náhled.');
    }
    if (used[token]) {
      return fail('PREVIEW_USED', 'Tento náhled už byl použitý; změnu neopakuji. Pro další změnu je potřeba nový náhled.');
    }
    used[token] = true;
    return null;
  }

  // The rails of every change around prepare(), which resolves to {problems,
  // sig, preview, perform}: a dry run returns preview() with `confirm`; a
  // change takes the confirmation first and calls perform() only if nothing
  // differs from the preview (else PREVIEW_CHANGED with the caller's text).
  function guarded(engagement, options, prefix, changedText, prepare) {
    options = options || {};
    if (!mayBeAllowed(engagement)) return Promise.reject(notAllowed());
    var token = options.confirm;
    if (!options.dryRun) {
      var refused = take(token, prefix);
      if (refused) return Promise.reject(refused);
    }
    return prepare().then(function (plan) {
      var sig = plan.problems.length ? null : JSON.stringify(plan.sig);
      if (!options.dryRun) {
        if (sig === null || issued[token].sig !== sig) {
          throw fail('PREVIEW_CHANGED', 'Od potvrzeného náhledu se něco změnilo (' + changedText + '). Nic jsem nezměnil; ' +
            'udělejte nový náhled a nechte si ho znovu potvrdit.');
        }
        core.markChanged();
        return plan.perform();
      }
      return Promise.resolve(plan.preview()).then(function (preview) {
        preview.dryRun = true;
        preview.ok = !plan.problems.length;
        preview.problems = plan.problems;
        preview.confirm = sig === null ? null : issue(prefix, sig);
        return preview;
      });
    });
  }

  function signature(ctx) {
    return [ctx.audit.auditId, ctx.procedure.procedureId, ctx.plans.map(function (p) {
      return [p.componentId, p.key, p.answerId, p.oldAnswer, p.oldDescription, p.data ? [p.data.answer, p.data.description] : null];
    })];
  }

  function where(row) {
    return (row.no ? 'Otázka ' + row.no : 'Položka ' + row.index) + (row.section ? ' (sekce ' + row.section + ')' : '');
  }

  // The form slot of an item: the question, its component and its shown item.
  function locate(item, forms) {
    var hit = null;
    forms.forEach(function (f) {
      (f.form.questions || []).forEach(function (q) { if (q.questionId === item.questionId) hit = { f: f, q: q }; });
    });
    if (!hit) return { problem: 'otázka ' + item.questionId + ' v této proceduře není.' };
    var slots = [];
    hit.f.shown.parts.forEach(function (part) {
      part.items.forEach(function (i) { if (i.questionId === item.questionId) slots.push({ item: i, section: part.section }); });
    });
    var slot = slots.filter(function (s) { return s.item.sectionId === item.sectionId; })[0];
    var out = { f: hit.f, q: hit.q, slot: slot };
    if (slot) return out;
    var reason = slots.length && slots.every(function (s) { return s.item.sectionId === null; })
      ? 'otázka není v opakované části, sekce se u ní neuvádí.'
      : !slots.length ? 'otázka se vyplňuje po sekcích a procedura zatím žádnou sekci nemá.'
        : item.sectionId === null ? 'otázka se vyplňuje v každé sekci zvlášť; řekněte, ve které sekci.'
          : 'sekce ' + item.sectionId + ' v proceduře není.';
    out.problem = reason;
    out.no = slots.length ? slots[0].item.no : null;
    return out;
  }

  // One item of the batch as a preview row (for the user) and a plan (for the write).
  function planItem(item, index, ctx, options) {
    item = item || {};
    var row = { index: index + 1, no: null, section: null, questionId: item.questionId,
      sectionId: item.sectionId === undefined ? null : item.sectionId };
    var plan = { row: row, key: core.itemKey(item.questionId, row.sectionId) };
    var problem = function (text) { row.problem = where(row) + ': ' + text; return plan; };
    if (row.sectionId !== null && !/^\d+$/.test(String(row.sectionId))) return problem('neplatné číslo sekce.');
    if (row.sectionId !== null) row.sectionId = Number(row.sectionId);
    var at = locate({ questionId: item.questionId, sectionId: row.sectionId }, ctx.forms);
    if (at.q) row.question = at.q.question;
    if (at.slot) {
      row.no = at.slot.item.no;
      row.section = at.slot.section ? at.slot.section.name : null;
    } else if (at.no) row.no = at.no;
    if (!at.q) return problem(at.problem);
    var readOnly = core.readOnlyReason(at.q);
    if (readOnly) return problem(readOnly);
    var writer = WRITERS[at.q.type];
    if (!writer) return problem('otázky typu „' + core.TYPE_LABELS[at.q.type] + '“ zatím neumím zapsat; použijte web.');
    if (at.problem) return problem(at.problem);
    row.type = core.TYPE_LABELS[at.q.type];
    if (typeof item.answer !== 'string') return problem('odpověď musí být text (prázdný text odpověď vymaže).');
    var stored;
    try {
      stored = core.isBlank(item.answer) ? '' : writer(item.answer.normalize('NFC'), at.q);
    } catch (e) {
      return problem(e.message);
    }
    var clear = stored === '';
    var existing = core.findAnswer(at.f.form.answers || [], at.q.questionId, row.sectionId);
    var oldAnswer = existing ? existing.answer || '' : '';
    var oldDescription = existing ? existing.description || '' : '';
    var split = core.splitDescription(oldDescription);
    var source = oneLine(item.source);
    // A confirmation in chat keeps the source already on the line unless given.
    if (!source && item.kind === 'confirmed' && split.mark) source = oneLine(split.mark.source);
    if (!clear) {
      if (!source) return problem('chybí zdroj odpovědi (dokument a strana, rejstřík se stavem k datu, nebo „uživatel v chatu“).');
      if (!Object.prototype.hasOwnProperty.call(MARKS, item.kind)) {
        return problem('chybí, jestli jde o fakt ze zdroje, návrh k ověření, nebo návrh, který auditor potvrdil.');
      }
      row.kind = item.kind;
      row.kindLabel = KIND_LABELS[item.kind];
      row.source = source;
      row.mark = MARKS[item.kind] + 'Zdroj: ' + source;
    }
    if (ctx.keys[plan.key]) return problem('otázka je v dávce dvakrát.');
    ctx.keys[plan.key] = true;
    var description = withMark(split.auditor, clear ? null : row.mark);
    if (stored.length > MAX_FIELD) return problem('odpověď má ' + stored.length + ' znaků, iAuditing jich přijme nejvýš 16 384.');
    if (description.length > MAX_FIELD) {
      return problem('popis se zdrojem by měl ' + description.length + ' znaků, iAuditing jich přijme nejvýš 16 384.');
    }
    var oldBlank = core.isBlank(oldAnswer);
    var action = clear ? (oldBlank ? 'unchanged' : 'cleared') : oldBlank ? 'created' : oldAnswer === stored ? 'unchanged' : 'updated';
    if (action === 'unchanged' && description !== oldDescription) action = 'source';
    row.action = action;
    row.actionLabel = ACTION_LABELS[action];
    row.overwrite = action === 'updated' || action === 'cleared';
    // Closed answers (Ano/Ne, a choice, a date) are shown even with redact,
    // like listQuestions does; free text is the client's and stays in the page.
    var show = function (text) {
      if (core.isBlank(text)) return '';
      return options.redact && at.q.type === 'text' ? core.redacted(text, options) : readable(at.q.type, text);
    };
    row.old = show(oldAnswer);
    row.new = show(stored);
    if (at.q.type === 'multi_select') {
      row.oldOptions = oldAnswer ? oldAnswer.split(';') : [];
      row.newOptions = stored ? stored.split(';') : [];
    }
    row.description = options.redact ? core.redacted(description, options) : description;
    if (oldDescription !== '' && description !== oldDescription) row.oldDescription = options.redact ? core.redacted(oldDescription, options) : oldDescription;
    if (action === 'cleared') row.note = CLEAR_NOTE;
    plan.componentId = at.f.component.componentId;
    plan.answerId = existing ? existing.answerId : null;
    plan.oldAnswer = oldAnswer;
    plan.oldDescription = oldDescription;
    if (action !== 'unchanged') {
      plan.data = existing
        ? { answerId: existing.answerId, questionId: at.q.questionId, sectionId: row.sectionId, answer: stored,
          description: description, comment: existing.comment || '' }
        : { formId: plan.componentId, questionId: at.q.questionId, sectionId: row.sectionId, answer: stored,
          description: description, comment: '' };
    }
    return plan;
  }

  function progressText(p) {
    return p ? p.progress + '/' + p.total : null;
  }

  function sum(list) {
    var s = { progress: 0, total: 0 };
    list.forEach(function (p) { s.progress += p.progress || 0; s.total += p.total || 0; });
    return s;
  }

  // The progress the forms will have once the planned answers are stored.
  function predictProgress(ctx) {
    return sum(ctx.forms.map(function (f) {
      var answers = (f.form.answers || []).slice();
      ctx.plans.forEach(function (p) {
        if (!p.data || p.componentId !== f.component.componentId) return;
        var a = core.findAnswer(answers, p.data.questionId, p.data.sectionId);
        if (a) answers[answers.indexOf(a)] = { questionId: a.questionId, sectionId: a.sectionId, answer: p.data.answer };
        else answers.push({ questionId: p.data.questionId, sectionId: p.data.sectionId, answer: p.data.answer });
      });
      var copy = {};
      Object.keys(f.form).forEach(function (k) { copy[k] = f.form[k]; });
      copy.answers = answers;
      return core.computeProgress(copy);
    }));
  }

  function publicRow(row) {
    var out = {};
    Object.keys(row).forEach(function (k) { if (k !== 'index' && row[k] !== undefined) out[k] = row[k]; });
    return out;
  }

  function loadForms(ctx, options) {
    var forms = (ctx.procedure.components || []).filter(function (c) { return c.componentType === 'form'; });
    if (!forms.length) throw fail('NOT_EDITABLE', 'Tato procedura nemá formulář s otázkami; použijte prosím web.');
    return Promise.all(forms.map(function (c) {
      return core.apiGet(ctx.base + '/components/' + c.componentId + '/data').then(function (d) {
        return { component: c, form: d.data, shown: core.showForm(c, d.data, options) };
      });
    }));
  }

  function storedProgress(ctx) {
    return core.apiGet(ctx.base + '/get').then(function (p) {
      var byId = {};
      (p.components || []).forEach(function (c) { byId[c.componentId] = c; });
      return byId;
    });
  }

  // Sends the planned saves one by one, stops at the first error, reads every
  // touched form back and then fixes the progress counters like the app does
  // (also after an error: what was saved is real, V8 §6).
  function write(ctx) {
    var started = Date.now();
    var todo = ctx.plans.filter(function (p) { return p.data; });
    var sent = [];
    var failed = null;
    var chain = Promise.resolve();
    todo.forEach(function (p) {
      chain = chain.then(function () {
        if (failed) return null;
        var body = { payload: { action: 'question.save', data: p.data } };
        return core.apiSend('PATCH', ctx.base + '/components/' + p.componentId + '/update', body).then(function (res) {
          p.savedId = res && res.result && res.result.data ? res.result.data.answerId : null;
          sent.push(p);
        }, function (err) {
          failed = { plan: p, error: err };
        });
      });
    });
    var report = { ok: false, auditId: ctx.audit.auditId, procedureId: ctx.procedure.procedureId, number: ctx.number,
      saved: [], failed: null, notSent: [], progress: { patched: false } };
    var brief = function (p) { return { no: p.row.no, section: p.row.section, question: p.row.question }; };
    var unread = null;
    return chain.then(function () {
      return loadForms(ctx, {}).catch(function (err) { unread = err; return null; });
    }).then(function (after) {
      if (!after) {
        // The saves went out but can't be checked: say so, change nothing more.
        report.saved = sent.map(function (p) {
          var out = brief(p);
          out.action = p.row.action;
          out.readBack = 'neověřeno';
          return out;
        });
        if (failed) report.failed = { no: failed.plan.row.no, section: failed.plan.row.section, error: failed.error.message,
          uncertain: Boolean(failed.error.uncertain), readBack: 'neověřeno' };
        return null;
      }
      var answerOf = function (p) {
        var f = after.filter(function (x) { return x.component.componentId === p.componentId; })[0];
        return core.findAnswer((f && f.form.answers) || [], p.data.questionId, p.data.sectionId);
      };
      var matches = function (a, p) { return a && a.answer === p.data.answer && (a.description || '') === p.data.description; };
      report.saved = sent.map(function (p) {
        var out = brief(p);
        out.action = p.row.action;
        out.actionLabel = p.row.actionLabel;
        out.readBack = matches(answerOf(p), p) ? 'OK' : 'NESOUHLASÍ';
        return out;
      });
      if (failed) {
        var f = brief(failed.plan);
        f.error = failed.error.message;
        f.code = failed.error.code;
        f.uncertain = Boolean(failed.error.uncertain);
        var a = answerOf(failed.plan);
        f.readBack = matches(a, failed.plan) ? 'uloženo' : (a ? a.answer || '' : '') === failed.plan.oldAnswer ? 'neuloženo' : 'nejasné';
        report.failed = f;
        var at = todo.indexOf(failed.plan);
        report.notSent = todo.slice(at + 1).map(brief);
      }
      var allRead = report.saved.every(function (s) { return s.readBack === 'OK'; });
      report.ok = !failed && allRead;
      var first = sent[0] || (failed && failed.plan);
      if (first) {
        report.open = { auditId: ctx.audit.auditId, procedureId: ctx.procedure.procedureId,
          questionId: first.data.questionId, sectionId: first.data.sectionId };
      }
      var touched = sent.concat(failed ? [failed.plan] : []);
      return touched.length ? fixProgress(ctx, after, touched, report) : null;
    }).then(function () {
      var n = todo.length;
      if (unread) {
        report.message = 'Odesláno ' + sent.length + ' z ' + n + ', uložení je ale neověřené (' + unread.message +
          '). Dál nic neměním; zkontrolujte prosím proceduru v iAuditingu.';
        report.ms = Date.now() - started;
        return report;
      }
      report.message = !n ? 'Nic se nemění, nic jsem neposílal.'
        : report.ok ? 'Uloženo ' + n + ' z ' + n + ', kontrola po uložení sedí.'
          : 'Uloženo ' + report.saved.length + ' z ' + n + '. ' + (report.failed
            ? where(report.failed) + ': zápis se nepovedl (' + report.failed.error + ')' +
              (report.failed.uncertain ? ' a není jisté, jestli se uložil (kontrola: ' + report.failed.readBack + ')' : '') +
              '. Zbylé jsem neposílal.'
            : 'Kontrola po uložení nesouhlasí; dál nic neměním.');
      if (!report.progress.before && !report.ok && report.saved.length) {
        report.progress.note = 'Počítadlo postupu jsem neupravil; iAuditing ho přepočítá, až se procedura otevře.';
      }
      report.ms = Date.now() - started;
      return report;
    });
  }

  function fixProgress(ctx, after, sent, report) {
    var touched = {};
    sent.forEach(function (p) { touched[p.componentId] = true; });
    var forms = after.filter(function (f) { return touched[f.component.componentId]; });
    return storedProgress(ctx).then(function (stored) {
      var before = sum(forms.map(function (f) { return stored[f.component.componentId]; }));
      var stale = forms.filter(function (f) {
        var c = core.computeProgress(f.form);
        var s = stored[f.component.componentId] || {};
        f.computed = c;
        return c.progress !== s.progress || c.total !== s.total;
      });
      report.progress = { before: progressText(before), after: progressText(before), patched: false };
      if (!stale.length) return null;
      var chain = Promise.resolve();
      stale.forEach(function (f) {
        chain = chain.then(function () {
          return core.apiSend('PATCH', ctx.base + '/components/' + f.component.componentId + '/progress', f.computed);
        });
      });
      return chain.then(function () {
        report.progress.patched = true;
        return storedProgress(ctx);
      }).then(function (again) {
        var now = sum(forms.map(function (f) { return again[f.component.componentId]; }));
        report.progress.after = progressText(now);
        var expected = sum(forms.map(function (f) { return f.computed; }));
        if (now.progress !== expected.progress || now.total !== expected.total) {
          report.progress.note = 'iAuditing ukazuje ' + progressText(now) + ', čekal jsem ' + progressText(expected) + '.';
        }
      }, function (err) {
        report.progress.note = 'Počítadlo postupu se nepodařilo upravit (' + err.message + '); ' +
          'iAuditing ho přepočítá, až se procedura otevře.';
      });
    });
  }

  // The rails of the zakázka (PLAN §5): the allowlist (also before any
  // request), an active unlocked zakázka, a role that may fill in. Resolves to
  // {audit}; iaud-files.js uses it for Soubory, which belong to no procedure.
  function openAuditForWrite(engagement) {
    if (!mayBeAllowed(engagement)) return Promise.reject(notAllowed());
    var ctx = {};
    return core.findAudit(engagement).then(function (a) {
      if (!allowed(a.auditId)) throw notAllowed();
      if (a.locked || a.status !== 'active') {
        throw fail('NOT_EDITABLE', 'Zakázka ' + core.auditLabel(a) + ' je uzamčená nebo archivovaná; zapisovat do ní nejde.');
      }
      ctx.audit = a;
      return core.auditRole(a.auditId);
    }).then(function (role) {
      if (PREPARE_ROLES.indexOf(role) === -1) {
        throw fail('NO_ROLE', 'Na této zakázce nemáte roli, která smí vyplňovat odpovědi (vaše role: ' + core.roleLabel(role) +
          '). Nic jsem nezapsal.');
      }
      return ctx;
    });
  }

  // The rails every write passes before its preview: those of the zakázka,
  // then a procedure in progress. Resolves to {audit, procedure, number, base, forms}.
  function openForWrite(engagement, procedure, options) {
    var ctx;
    return openAuditForWrite(engagement).then(function (opened) {
      ctx = opened;
      return core.apiGet('audits/audit/' + ctx.audit.auditId + '/procedures/list');
    }).then(function (list) {
      var p = core.findProcedure(list, procedure, ctx.audit);
      ctx.procedure = p;
      ctx.number = core.procedureNumber(p.displayId || (p.template || {}).displayId);
      ctx.base = core.procedureBase(ctx.audit, p);
      if (p.status !== 'in_progress') {
        throw fail('NOT_EDITABLE', 'Procedura ' + ctx.number + ' je ve stavu „' + core.procedureStatus(p) +
          '“; teď v ní nic měnit nejde.');
      }
      return loadForms(ctx, options);
    }).then(function (forms) {
      ctx.forms = forms;
      return ctx;
    });
  }

  // Saves answers of one procedure as a batch. items: [{questionId, sectionId?,
  // answer, source, kind: "fact" | "draft" | "confirmed"}]; an empty answer
  // clears it; "confirmed" without a source keeps the line's source.
  // {dryRun: true} returns the preview with `confirm`; the write itself needs
  // {confirm} from that preview, unused, with every row unchanged since.
  function saveAnswers(engagement, procedure, items, options) {
    options = options || {};
    if (!Array.isArray(items) || !items.length || items.length > MAX_ITEMS) {
      return Promise.reject(fail('BAD_ITEMS', 'Odpovědi předávám jako seznam o 1 až ' + MAX_ITEMS + ' položkách.'));
    }
    return guarded(engagement, options, 'n', 'odpovědi v iAuditingu nebo to, co se má zapsat', function () {
      return openForWrite(engagement, procedure, options).then(function (ctx) {
        ctx.keys = {};
        ctx.plans = items.map(function (item, i) { return planItem(item, i, ctx, options); });
        var problems = ctx.plans.map(function (p) { return p.row.problem; }).filter(Boolean);
        return { problems: problems, sig: signature(ctx), perform: function () { return write(ctx); }, preview: function () {
          var stored = sum(ctx.forms.map(function (f) { return f.component; }));
          return {
            auditId: ctx.audit.auditId,
            client: ctx.audit.client && ctx.audit.client.name,
            procedureId: ctx.procedure.procedureId,
            number: ctx.number,
            name: ctx.procedure.name || (ctx.procedure.template || {}).name,
            rows: ctx.plans.map(function (p) { return publicRow(p.row); }),
            writes: ctx.plans.filter(function (p) { return p.data; }).length,
            progress: { before: progressText(stored), after: problems.length ? null : progressText(predictProgress(ctx)) },
          };
        } };
      });
    });
  }

  iaud.saveAnswers = saveAnswers;
  core.writeAllowlist = WRITE_ALLOWLIST.map(function (a) { return a.auditId; });
  // For iaud-sections.js and iaud-files.js: the same rails, read-back and progress fix.
  core.write = { openForWrite: openForWrite, openAuditForWrite: openAuditForWrite, loadForms: loadForms, fixProgress: fixProgress,
    storedProgress: storedProgress, progressText: progressText, sum: sum, oneLine: oneLine, loose: loose, guarded: guarded };

  // The self-check covers this whole function as the browser parsed it.
  var source = String(installWrite);
  iaud.extensions[NAME] = 'délka ' + source.length + ', hash ' + core.fnv1a(source);
  if (isModule) module.exports = iaud;
  return NAME + ' ' + VERSION + ' loaded, ' + iaud.extensions[NAME];
})(typeof window !== 'undefined' ? window : globalThis);
