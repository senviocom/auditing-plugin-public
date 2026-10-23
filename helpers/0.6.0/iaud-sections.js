// iaud-sections: adding, renaming and removing the repeatable sekce of a
// procedure (#28). Claude passes this whole file to the browser's JavaScript
// tool after references/iaud.js and references/iaud-write.js, the first time a
// task changes a sekce. It extends window.iaud (same version only) and
// evaluates to "iaud-sections <version> loaded, délka <n>, hash <h>".
// Same rails as saveAnswers (iaud-write): allowlist → role → procedure in
// progress → dry run (preview) → the user's "ano" → one write → read back →
// progress, never repeated. Removing a sekce also deletes its answers (V8 §5).
(function installSections(root) {
  'use strict';

  var VERSION = '0.6.0';
  var NAME = 'iaud-sections';

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

  // section.add and section.rename: name ≤ 256 chars after NFC (the app's schema).
  var MAX_NAME = 256;
  var NL = String.fromCharCode(10);
  var CR = String.fromCharCode(13);

  var ACTIONS = { add: 'section.add', rename: 'section.rename', remove: 'section.remove' };
  var ACTION_LABELS = {
    add: 'nová sekce',
    rename: 'přejmenování sekce',
    remove: 'smazání sekce i se všemi jejími odpověďmi',
  };
  var REMOVE_WARNING = 'Smazáním sekce iAuditing smaže i všechny její odpovědi, popisy a připojení příloh. ' +
    'Vrátit to nejde.';

  function fail(code, message) { return core.apiError(code, message); }

  function bySequence(x, y) { return (x.sequence || 0) - (y.sequence || 0); }

  function cleanName(name) {
    return name.normalize('NFC').trim();
  }

  // Why a name can't be used, or null. iAuditing itself allows empty and
  // repeated names (a new sekce is "Sekce" until renamed); the plugin doesn't,
  // because the user and Claude tell sekce apart by name.
  function nameProblem(name, sections, except) {
    if (typeof name !== 'string' || core.isBlank(name)) return 'název sekce chybí; napište, jak se má sekce jmenovat.';
    var clean = cleanName(name);
    if (clean.indexOf(NL) !== -1 || clean.indexOf(CR) !== -1) return 'název sekce musí být na jednom řádku.';
    if (clean.length > MAX_NAME) return 'název sekce má ' + clean.length + ' znaků, iAuditing jich přijme nejvýš 256.';
    var same = sections.filter(function (s) { return s !== except && writing.loose(s.name) === writing.loose(clean); });
    if (same.length) return 'sekce s názvem „' + clean + '“ už v proceduře je; zvolte prosím jiný název, ať se sekce nepletou.';
    return null;
  }

  // The procedure's one repeatable form and the questions that repeat per sekce.
  function repeatableForm(ctx) {
    var forms = ctx.forms.filter(function (f) {
      return f.form.details && f.form.details.repeatable && f.form.details.repeatRange;
    });
    if (!forms.length) throw fail('NO_SECTIONS', 'Procedura ' + ctx.number + ' nemá opakované sekce.');
    if (forms.length > 1) {
      throw fail('NOT_EDITABLE', 'Procedura ' + ctx.number + ' má víc opakovaných částí; sekce v ní prosím upravte ve webu.');
    }
    var f = forms[0];
    var range = f.form.details.repeatRange;
    var questions = (f.form.questions || []).slice().sort(bySequence).slice(range[0], range[1]);
    var unknown = questions.filter(function (q) { return !core.isHeading(q) && core.readOnlyReason(q); });
    if (unknown.length) {
      throw fail('NOT_EDITABLE', 'V opakované části procedury ' + ctx.number + ' jsou otázky, které nelze upravit ' +
        'přes Clauda; sekce v ní prosím upravte ve webu.');
    }
    return { f: f, questions: questions, sections: (f.form.sections || []).slice().sort(bySequence) };
  }

  // The sekce by its ID (from showProcedure) or by its name, if only one fits.
  function findSection(sections, wanted) {
    var text = String(wanted === undefined || wanted === null ? '' : wanted).trim();
    if (/^\d+$/.test(text)) {
      return { hit: sections.filter(function (s) { return s.sectionId === Number(text); })[0] || null, text: text };
    }
    var hits = sections.filter(function (s) { return text && writing.loose(s.name) === writing.loose(text); });
    return { hit: hits.length === 1 ? hits[0] : null, many: hits.length > 1, text: text };
  }

  // The form as it will be after the change, for the predicted progress.
  function formAfter(form, kind, data) {
    var copy = {};
    Object.keys(form).forEach(function (k) { copy[k] = form[k]; });
    if (kind === 'add') copy.sections = (form.sections || []).concat([{ sectionId: -1, name: data.name, sequence: data.sequence }]);
    if (kind === 'remove') {
      copy.sections = (form.sections || []).filter(function (s) { return s.sectionId !== data.sectionId; });
      copy.answers = (form.answers || []).filter(function (a) { return a.sectionId !== data.sectionId; });
    }
    return copy;
  }

  // What removing a sekce loses: its answer rows, by question as showProcedure numbers them.
  function lostWith(at, section, options) {
    var rows = (at.f.form.answers || []).filter(function (a) { return a.sectionId === section.sectionId; });
    var part = at.f.shown.parts.filter(function (p) { return p.section && p.section.sectionId === section.sectionId; })[0];
    var items = [];
    (part ? part.items : []).forEach(function (i) {
      if (i.heading || !core.findAnswer(rows, i.questionId, section.sectionId)) return;
      var out = { no: i.no, question: i.question, answered: i.answered };
      ['answer', 'description', 'comment', 'attachments'].forEach(function (k) { if (i[k]) out[k] = i[k]; });
      items.push(out);
    });
    var attachments = 0;
    rows.forEach(function (a) { attachments += (a.attachments || []).length; });
    return {
      answers: rows.filter(function (a) { return !core.isBlank(a.answer); }).length,
      rows: rows.length,
      attachments: attachments,
      items: items,
    };
  }

  // The change as a preview (for the user) and the data of the one write.
  function plan(kind, ctx, args, options) {
    var at = repeatableForm(ctx);
    var out = { kind: kind, at: at, problems: [], section: null };
    var show = function (name) { return core.redacted(name, options); };
    var data = { formId: at.f.component.componentId };
    if (kind === 'add') {
      var addProblem = nameProblem(args.name, at.sections, null);
      if (addProblem) { out.problems.push('Nová sekce: ' + addProblem); return out; }
      var last = 0;
      at.sections.forEach(function (s) { if (s.sequence > last) last = s.sequence; });
      data.name = cleanName(args.name);
      data.sequence = last + 1;
      out.section = { sectionId: null, name: data.name, sequence: data.sequence };
    } else {
      var found = findSection(at.sections, args.section);
      if (!found.hit) {
        out.problems.push(found.many
          ? 'Názvu „' + found.text + '“ odpovídá víc sekcí; řekněte, kterou myslíte (podle čísla sekce).'
          : 'Sekci „' + found.text + '“ jsem v proceduře ' + ctx.number + ' nenašel.');
        return out;
      }
      var s = found.hit;
      data.sectionId = s.sectionId;
      out.target = s;
      out.section = { sectionId: s.sectionId, name: show(s.name) };
      if (kind === 'rename') {
        var renameProblem = nameProblem(args.name, at.sections, s);
        if (!renameProblem && cleanName(args.name) === s.name) renameProblem = 'sekce se už takto jmenuje.';
        if (renameProblem) { out.problems.push('Sekce ' + s.sectionId + ': ' + renameProblem); return out; }
        data.newName = cleanName(args.name);
        out.section.newName = data.newName;
      } else {
        out.lost = lostWith(at, s, options);
      }
    }
    out.data = data;
    return out;
  }

  // What the confirmation stands for: the change and the form's sekce (and,
  // for a removal, every answer row that would go), exactly as previewed.
  function signature(ctx, p) {
    var rows = p.kind === 'remove' ? (p.at.f.form.answers || []).filter(function (a) { return a.sectionId === p.data.sectionId; })
      .map(function (a) { return [a.answerId, a.answer, a.description, a.comment, (a.attachments || []).length]; }) : null;
    return [p.kind, ctx.audit.auditId, ctx.procedure.procedureId, p.data,
      p.at.sections.map(function (s) { return [s.sectionId, s.name, s.sequence]; }), rows];
  }

  // Whether the read-back form shows the change done.
  function done(p, form, reply) {
    var sections = form.sections || [];
    var byId = function (id) { return sections.filter(function (s) { return s.sectionId === id; })[0] || null; };
    if (p.kind === 'add') {
      var known = p.at.sections.map(function (s) { return s.sectionId; });
      var s = reply && typeof reply.sectionId === 'number' ? byId(reply.sectionId) : sections.filter(function (x) {
        return known.indexOf(x.sectionId) === -1 && x.name === p.data.name;
      })[0];
      return s && s.name === p.data.name ? s : null;
    }
    var target = byId(p.data.sectionId);
    if (p.kind === 'rename') return target && target.name === p.data.newName ? target : null;
    var left = (form.answers || []).filter(function (a) { return a.sectionId === p.data.sectionId; });
    return !target && !left.length ? p.target : null;
  }

  // The one write, then the read-back and the progress fix (PLAN §5).
  function write(ctx, p) {
    var started = Date.now();
    var cid = p.at.f.component.componentId;
    var report = { ok: false, action: p.kind, actionLabel: ACTION_LABELS[p.kind], auditId: ctx.audit.auditId,
      procedureId: ctx.procedure.procedureId, number: ctx.number, section: p.section, progress: { patched: false } };
    if (p.lost) report.lost = { answers: p.lost.answers, rows: p.lost.rows, attachments: p.lost.attachments };
    var reply = null;
    var failed = null;
    var unread = null;
    var body = { payload: { action: ACTIONS[p.kind], data: p.data } };
    return core.apiSend('PATCH', ctx.base + '/components/' + cid + '/update', body).then(function (res) {
      reply = res && res.result ? res.result.data : null;
    }, function (err) {
      failed = err;
    }).then(function () {
      return writing.loadForms(ctx, {}).catch(function (err) { unread = err; return null; });
    }).then(function (after) {
      if (!after) { report.readBack = 'neověřeno'; return null; }
      var f = after.filter(function (x) { return x.component.componentId === cid; })[0];
      var s = f ? done(p, f.form, reply) : null;
      if (failed) {
        report.readBack = s ? 'provedeno' : 'neprovedeno';
        // The change happened although its reply failed: the counter follows it.
        return s ? writing.fixProgress(ctx, after, [{ componentId: cid }], report) : null;
      }
      report.readBack = s ? 'OK' : 'NESOUHLASÍ';
      if (!s) return null;
      report.ok = true;
      if (p.kind === 'add') report.section = { sectionId: s.sectionId, name: s.name, sequence: s.sequence };
      var first = p.at.questions.filter(function (q) { return !core.isHeading(q); })[0];
      report.open = p.kind === 'remove' || !first
        ? { auditId: ctx.audit.auditId, procedureId: ctx.procedure.procedureId }
        : { auditId: ctx.audit.auditId, procedureId: ctx.procedure.procedureId, questionId: first.questionId, sectionId: s.sectionId };
      return writing.fixProgress(ctx, after, [{ componentId: cid }], report);
    }).then(function () {
      var label = report.section && (report.section.newName || report.section.name);
      if (unread) {
        report.message = 'Změnu jsem odeslal, ale nepodařilo se ji ověřit (' + unread.message + '). Dál nic neměním; ' +
          'zkontrolujte prosím proceduru v iAuditingu.';
      } else if (failed) {
        report.error = failed.message;
        report.code = failed.code;
        report.uncertain = Boolean(failed.uncertain);
        report.message = 'Změna sekce se nepovedla (' + failed.message + ')' + (report.uncertain
          ? ' a není jisté, jestli se provedla (kontrola: ' + report.readBack + ')' : '') + '. Dál nic neměním.';
      } else if (!report.ok) {
        report.message = 'Kontrola po uložení nesouhlasí; dál nic neměním. Zkontrolujte prosím proceduru v iAuditingu.';
      } else {
        report.message = (p.kind === 'add' ? 'Sekce „' + label + '“ je přidaná'
          : p.kind === 'rename' ? 'Sekce je přejmenovaná na „' + label + '“'
            : 'Sekce „' + label + '“ je smazaná i se svými odpověďmi (vyplněné: ' + p.lost.answers + ', řádky: ' + p.lost.rows + ')') +
          ', kontrola po uložení sedí.';
      }
      if (!report.ok && !report.progress.before) {
        report.progress.note = 'Počítadlo postupu jsem neupravil; iAuditing ho přepočítá, až se procedura otevře.';
      }
      report.ms = Date.now() - started;
      return report;
    });
  }

  function change(kind, engagement, procedure, args, options) {
    options = options || {};
    var changed = 'sekce nebo odpovědi v iAuditingu, nebo to, co se má změnit';
    return writing.guarded(engagement, options, 's', changed, function () {
      return writing.openForWrite(engagement, procedure, options).then(function (ctx) {
        var p = plan(kind, ctx, args, options);
        return { problems: p.problems, sig: p.problems.length ? null : signature(ctx, p), perform: function () { return write(ctx, p); },
          preview: function () { return preview(ctx, p, kind); } };
      });
    });
  }

  function preview(ctx, p, kind) {
    var out = {
      auditId: ctx.audit.auditId,
      client: ctx.audit.client && ctx.audit.client.name,
      procedureId: ctx.procedure.procedureId,
      number: ctx.number,
      name: ctx.procedure.name || (ctx.procedure.template || {}).name,
      action: kind,
      actionLabel: ACTION_LABELS[kind],
      section: p.section,
      sections: p.at.sections.length,
      progress: { before: writing.progressText(p.at.f.component),
        after: p.problems.length ? null : writing.progressText(core.computeProgress(formAfter(p.at.f.form, kind, p.data))) },
    };
    if (p.lost) {
      out.lost = p.lost;
      out.warning = REMOVE_WARNING;
    }
    return out;
  }

  // Adds a sekce named `name` after the last one. {dryRun: true} gives the
  // preview with `confirm`; the write needs {confirm} from it, once.
  function addSection(engagement, procedure, name, options) {
    return change('add', engagement, procedure, { name: name }, options);
  }

  // Renames a sekce, given by its ID (sectionId) or its current name.
  function renameSection(engagement, procedure, section, name, options) {
    return change('rename', engagement, procedure, { section: section, name: name }, options);
  }

  // Removes a sekce and, with it, all its answers. The preview lists them.
  function removeSection(engagement, procedure, section, options) {
    return change('remove', engagement, procedure, { section: section }, options);
  }

  iaud.addSection = addSection;
  iaud.renameSection = renameSection;
  iaud.removeSection = removeSection;

  // The self-check covers this whole function as the browser parsed it.
  var source = String(installSections);
  iaud.extensions[NAME] = 'délka ' + source.length + ', hash ' + core.fnv1a(source);
  if (isModule) module.exports = iaud;
  return NAME + ' ' + VERSION + ' loaded, ' + iaud.extensions[NAME];
})(typeof window !== 'undefined' ? window : globalThis);
