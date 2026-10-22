// iaud: the iAuditing helper of the iauditing plugin. The page loads it with
// the skill's loader (a script tag with this file's SHA-384, from the public
// repo); failing that, Claude passes this whole file to the browser's
// JavaScript tool. It installs window.iaud and evaluates to a short "loaded"
// message with the helper's length and hash, which the skill compares with
// the values in SKILL.md.
// It calls iAuditing's internal API (/api/v2) with the user's own session.
// This file only reads; writes live in iaud-write.js, which extends window.iaud
// through iaud._internal. Results are reduced before they leave the page.
// A full page reload removes it, so the skill never reloads this tab (changes
// are shown in a second tab). (Caching the source in sessionStorage was
// dropped: Cowork denies the eval, V3.)
(function install(root) {
  'use strict';

  var VERSION = '0.5.0';

  // The iAuditing version this helper was tested against (PLAN.md §6).
  var TESTED_APP_VERSION = '1.2.6';

  var ROLE_LABELS = {
    auditor: 'Auditor',
    'audit-manager': 'Manažer zakázky',
    reviewer: 'Revizor',
    'assistant-auditor': 'Asistent auditora',
    viewer: 'Jen prohlížení',
  };

  var STATUS_LABELS = {
    active: 'aktivní',
    archived: 'archivovaná',
  };

  // A procedure's status, with the app's own labels.
  var PROCEDURE_STATUS_LABELS = {
    in_progress: 'Rozpracováno',
    under_review: 'V revizi',
    approved: 'Schváleno',
  };

  var LOGGED_OUT = 'Nejste přihlášen/a do iAuditingu. Přihlaste se v Chrome a znovu importujte přihlášení ' +
    'do panelu Prohlížeč (v Claude Desktop: import uložených přihlášení z Chrome).';

  var iaud = {
    version: VERSION,
    testedAppVersion: TESTED_APP_VERSION,
    loadedAt: new Date().toISOString(),
    // V8: about 3 requests per second never failed; at about 4/s one reply was HTML.
    minIntervalMs: 340,
    retryDelayMs: 1500,
  };

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // Requests queue up, and each waits until minIntervalMs after the one
  // before was really sent (a late timer can't squeeze two together), so
  // even parallel calls keep the pace.
  var queue = Promise.resolve();
  var lastSent = 0;
  function throttle() {
    queue = queue.then(function () {
      return wait(lastSent + iaud.minIntervalMs - Date.now()).then(function () { lastSent = Date.now(); });
    });
    return queue;
  }

  function apiError(code, message, status) {
    var err = new Error(message);
    err.code = code;
    if (status !== undefined) err.status = status;
    return err;
  }

  function isJson(r) {
    return (r.headers.get('content-type') || '').indexOf('application/json') !== -1;
  }

  // Why a reply that isn't JSON came back. A login page (2xx/3xx HTML or a
  // redirect) means the session is gone; a 5xx page is iAuditing's own trouble.
  function nonJsonError(r) {
    if (r.status === 403 || r.redirected || r.status < 400) {
      return apiError('LOGGED_OUT', LOGGED_OUT, r.status);
    }
    if (r.status >= 500) {
      return apiError('SERVER_ERROR', 'iAuditing má teď potíže (HTTP ' + r.status + '). Zkuste to prosím za chvíli znovu.', r.status);
    }
    return apiError('UNEXPECTED', 'iAuditing odpověděl neočekávaně (HTTP ' + r.status + ', ' +
      (r.headers.get('content-type') || 'bez typu') + ').', r.status);
  }

  // GET of a same-origin URL with the session cookie, returning the parsed
  // JSON. A non-JSON reply is retried once after a pause.
  function getJson(url, retried) {
    return throttle().then(function () {
      return fetch(url).catch(function () {
        throw apiError('NETWORK', 'Nepodařilo se spojit s iAuditingem. Zkontrolujte připojení k internetu. ' +
          'Pokud jste se mezitím odhlásil/a, přihlaste se v Chrome a znovu importujte přihlášení.');
      });
    }).then(function (r) {
      if (r.status === 401) throw apiError('LOGGED_OUT', LOGGED_OUT, r.status);
      if (!isJson(r)) {
        if (!retried) {
          return wait(iaud.retryDelayMs).then(function () { return getJson(url, true); });
        }
        throw nonJsonError(r);
      }
      return r.json().catch(function () {
        throw apiError('UNEXPECTED', 'iAuditing poslal poškozenou odpověď (HTTP ' + r.status + ').', r.status);
      }).then(function (parsed) {
        return { status: r.status, ok: r.ok, json: parsed };
      });
    });
  }

  // Replies look like {data, error}; errors are {data: null, error: {code, message, czech?}}.
  function unwrap(r) {
    var json = r.json || {};
    if (!r.ok || json.error) {
      var e = json.error || {};
      throw apiError(e.code || 'HTTP_' + r.status, 'iAuditing vrátil chybu ' + r.status +
        (e.code ? ' ' + e.code : '') + ': ' + (e.czech || e.message || 'bez popisu') + '.', r.status);
    }
    return json.data;
  }

  // A read from /api/v2.
  function apiGet(path) {
    return getJson('/api/v2/' + path).then(unwrap);
  }

  // A write (PATCH/POST) to /api/v2, sent like the app: a pre-stringified JSON
  // body without a Content-Type, so the browser sends text/plain (V8 §2). Same
  // pace as reads, but never retried: a second question.save could save twice.
  // After a lost connection or a reply that isn't JSON it is unknown whether the
  // write happened, so the error carries uncertain: true.
  function apiSend(method, path, body) {
    var uncertain = function (err) { err.uncertain = true; return err; };
    return throttle().then(function () {
      return fetch('/api/v2/' + path, { method: method, body: JSON.stringify(body) }).catch(function () {
        throw uncertain(apiError('NETWORK', 'Spojení s iAuditingem se přerušilo a nevím, jestli se změna uložila.'));
      });
    }).then(function (r) {
      if (r.status === 401) throw apiError('LOGGED_OUT', LOGGED_OUT, r.status);
      if (!isJson(r)) throw uncertain(nonJsonError(r));
      return r.json().catch(function () {
        throw uncertain(apiError('UNEXPECTED', 'iAuditing poslal poškozenou odpověď (HTTP ' + r.status + ').', r.status));
      }).then(function (parsed) {
        return unwrap({ status: r.status, ok: r.ok, json: parsed });
      });
    });
  }

  // Our role on one engagement (null without one).
  function auditRole(auditId) {
    return apiGet('audits/audit/' + auditId + '/team/me').then(function (me) {
      return (me && me.auditRole) || null;
    });
  }

  function firmOf(hostname) {
    var m = /^([a-z0-9-]+)\.iauditing\.cz$/.exec(hostname || '');
    if (!m || ['www', 'login', 'auth'].indexOf(m[1]) !== -1) return null;
    return m[1];
  }

  function majorMinorPatch(version) {
    return String(version || '').split('-')[0];
  }

  // First-run check (SETUP.md §4): the page, the login, who and where we are,
  // and the app version. Returns {ok, firm, user, firmRole, appVersion,
  // problems, warnings}; problems and warnings are plain Czech for the user.
  function check() {
    var report = {
      ok: false,
      firm: null,
      user: null,
      firmRole: null,
      appVersion: null,
      testedAppVersion: TESTED_APP_VERSION,
      problems: [],
      warnings: [],
    };
    var hostname = root.location && root.location.hostname;
    report.firm = firmOf(hostname);
    if (!report.firm) {
      report.problems.push('Prohlížeč není na stránce iAuditingu vaší firmy (je na ' + (hostname || 'neznámé stránce') +
        '). Otevřete v panelu Prohlížeč adresu https://<vaše-firma>.iauditing.cz.');
      return Promise.resolve(report);
    }
    return apiGet('staff/me/get').then(function (me) {
      report.user = [me.firstName, me.lastName].filter(Boolean).join(' ');
      report.firmRole = me.role || null;
      return getJson('/_app/version.json').then(function (r) {
        return r.json && r.json.version;
      }, function () {
        return null;
      });
    }).then(function (appVersion) {
      report.appVersion = appVersion || null;
      if (!appVersion) {
        report.warnings.push('Nepodařilo se zjistit verzi iAuditingu. Plugin je vyzkoušený na verzi ' +
          TESTED_APP_VERSION + '; když něco nebude sedět, zastavím se a řeknu vám to.');
      } else if (majorMinorPatch(appVersion) !== TESTED_APP_VERSION) {
        report.warnings.push('iAuditing má jinou verzi (' + appVersion + ') než tu, na které je plugin vyzkoušený (' +
          TESTED_APP_VERSION + '). Čtení by mělo fungovat; když něco nebude sedět, zastavím se a řeknu vám to.');
      }
      report.ok = true;
      return report;
    }, function (err) {
      report.problems.push(err.message);
      report.errorCode = err.code;
      return report;
    });
  }

  function roleLabel(role) {
    if (!role) return 'bez role (jen čtení)';
    return ROLE_LABELS[role] || 'neznámá role „' + role + '“';
  }

  function statusLabel(audit) {
    var label = STATUS_LABELS[audit.status] || String(audit.status);
    return audit.locked ? label + ', uzamčená' : label;
  }

  function progressLabel(p) {
    if (!p || typeof p.total !== 'number') return null;
    return 'dokončeno ' + p.complete + ' z ' + p.total + ' procedur, schváleno ' + p.approved;
  }

  // The firm's engagements with our role on each (one team/me per engagement,
  // at the throttled pace). Only the fields the user needs leave the page.
  function listAudits() {
    return apiGet('audits/list').then(function (audits) {
      return Promise.all(audits.map(function (a) {
        return auditRole(a.auditId).then(function (code) {
          return { code: code, label: roleLabel(code) };
        }).catch(function (err) {
          if (err.code === 'LOGGED_OUT' || err.code === 'NETWORK') throw err;
          return { code: null, label: 'nepodařilo se zjistit' };
        }).then(function (role) {
          return {
            auditId: a.auditId,
            client: a.client && a.client.name,
            year: a.year,
            deadline: a.deadline ? String(a.deadline).slice(0, 10) : null,
            status: statusLabel(a),
            roleCode: role.code,
            role: role.label,
            progress: progressLabel(a.progress),
          };
        });
      }));
    }).then(function (list) {
      return list.sort(function (x, y) { return String(x.client).localeCompare(String(y.client), 'cs'); });
    });
  }

  // "PROBIS Audit, a. s." → "probis audit a s": no case, diacritics or punctuation.
  // The accents are dropped by code point (U+0300–U+036F after NFD) rather than
  // with a unicode-escape regex: Claude passes this file inside JSON, which would
  // decode such an escape and break the self-check (Cowork run of #14).
  function normalizeName(text) {
    var nfd = String(text || '').normalize('NFD');
    var plain = '';
    for (var i = 0; i < nfd.length; i++) {
      var code = nfd.charCodeAt(i);
      if (code < 0x300 || code > 0x36f) plain += nfd.charAt(i);
    }
    return plain.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function auditLabel(a) {
    return (a.client && a.client.name) + ' (' + a.year + ')';
  }

  // The engagement by its ID or by (part of) the client's name, from audits/list,
  // so the user never has to handle IDs. Several matches are an error naming them.
  function findAudit(engagement) {
    return apiGet('audits/list').then(function (audits) {
      var byId = audits.filter(function (a) { return a.auditId === engagement; });
      if (byId.length) return byId[0];
      var query = normalizeName(engagement);
      var names = audits.map(function (a) { return normalizeName(a.client && a.client.name); });
      var exact = audits.filter(function (a, i) { return query && names[i] === query; });
      var matches = exact.length ? exact : audits.filter(function (a, i) { return query && names[i].indexOf(query) !== -1; });
      if (matches.length === 1) return matches[0];
      if (!matches.length) {
        throw apiError('NOT_FOUND', 'Zakázku „' + engagement + '“ jsem mezi zakázkami vaší firmy nenašel.');
      }
      throw apiError('AMBIGUOUS', 'Názvu „' + engagement + '“ odpovídá víc zakázek: ' +
        matches.map(auditLabel).join(', ') + '. Kterou myslíte?');
    });
  }

  function bySequence(x, y) { return (x.sequence || 0) - (y.sequence || 0); }

  // V8 §6: saves through the API don't update the stored counters; the app
  // recomputes them when someone opens the form.
  var STALE_NOTE = 'Postup (vyplněno/celkem) je údaj, který si iAuditing ukládá; nemusí být aktuální, ' +
    'dokud někdo proceduru neotevře. Přesný stav jedné procedury umím spočítat zvlášť.';

  function procedureStatus(p) {
    var label = PROCEDURE_STATUS_LABELS[p.status] || 'neznámý stav „' + p.status + '“';
    return p.isReturned ? label + ', vráceno k přepracování' : label;
  }

  // Stored progress over all components, as "vyplněno/celkem", or null.
  function progressOf(components) {
    if (!components.length) return null;
    var done = 0;
    var total = 0;
    components.forEach(function (c) { done += c.progress || 0; total += c.total || 0; });
    return { done: done, total: total };
  }

  // approved / underReview / inProgress / notStarted / other, for the summary.
  function stageOf(p, progress) {
    if (p.status === 'approved') return 'approved';
    if (p.status === 'under_review') return 'underReview';
    if (p.status !== 'in_progress') return 'other';
    if (!p.isReturned && !(progress && progress.done > 0)) return 'notStarted';
    return 'inProgress';
  }

  // V9: only a procedure made of one form is something we know how to read;
  // any other component type is left to the web app.
  function isPlainForm(components) {
    return components.length === 1 && components[0].componentType === 'form';
  }

  var NO_PHASE = { phaseId: 'none', name: 'Bez fáze', sequence: 99 };

  // The procedures of one engagement (ID or client name), grouped by phase in
  // the app's order, with a Czech summary. Uses the stored counters only: no
  // per-procedure requests. People and dates stay in the page.
  function listProcedures(engagement) {
    var audit;
    return findAudit(engagement).then(function (a) {
      audit = a;
      return apiGet('audits/audit/' + a.auditId + '/procedures/list');
    }).then(function (procedures) {
      var phases = [];
      var byPhase = {};
      var webOnly = 0;
      var counts = { total: 0, approved: 0, underReview: 0, inProgress: 0, notStarted: 0, other: 0 };
      // A procedure's own name/displayId/sequence/phase override the template's (all null in V9).
      var shown = procedures.map(function (p) {
        var t = p.template || {};
        return { p: p, name: p.name || t.name, displayId: p.displayId || t.displayId,
          sequence: p.sequence !== null && p.sequence !== undefined ? p.sequence : t.sequence, phase: p.phase || t.phase || NO_PHASE };
      });
      shown.sort(bySequence).forEach(function (s) {
        var p = s.p;
        var ph = s.phase;
        if (!byPhase[ph.phaseId]) {
          byPhase[ph.phaseId] = { phase: ph.name, sequence: ph.sequence, procedures: [] };
          phases.push(byPhase[ph.phaseId]);
        }
        var components = p.components || [];
        var progress = progressOf(components);
        counts.total++;
        counts[stageOf(p, progress)]++;
        var item = {
          procedureId: p.procedureId,
          number: s.displayId ? String(s.displayId).replace(/^Procedura\s+/, '') : null,
          name: s.name,
          statusCode: p.status,
          status: procedureStatus(p),
          progress: progress && progress.done + '/' + progress.total,
        };
        if (!isPlainForm(components)) {
          item.webOnly = 'jen ve webovém rozhraní';
          webOnly++;
        }
        byPhase[ph.phaseId].procedures.push(item);
      });
      phases.sort(bySequence);
      return {
        auditId: audit.auditId,
        client: audit.client && audit.client.name,
        ico: (audit.client && audit.client.ico) || null,
        year: audit.year,
        summary: 'Celkem ' + counts.total + ' procedur: schváleno ' + counts.approved + ', v revizi ' + counts.underReview +
          ', rozpracováno ' + counts.inProgress + ', nezahájeno ' + counts.notStarted +
          (counts.other ? ', jiný stav ' + counts.other : '') + '.',
        counts: counts,
        note: STALE_NOTE,
        webOnly: webOnly,
        phases: phases.map(function (ph) { return { phase: ph.phase, procedures: ph.procedures }; }),
      };
    });
  }

  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  function checkId(id, what) {
    if (!UUID.test(String(id))) throw apiError('BAD_ID', 'Neplatné ID ' + what + ': ' + id);
  }

  // A click on an in-app link is routed by the app itself without a page
  // reload, so iaud stays loaded.
  function clickLink(href) {
    var link = root.document.createElement('a');
    link.setAttribute('href', href);
    root.document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function currentPath() {
    return (root.location && root.location.pathname) || '';
  }

  // Opens the engagement in the tab so the user can watch.
  function openAudit(auditId) {
    checkId(auditId, 'zakázky');
    var path = '/audit/' + auditId;
    var here = currentPath();
    if (here === path || here.indexOf(path + '/') === 0) return 'Zakázka už je v prohlížeči otevřená.';
    clickLink(path);
    return 'Otevírám zakázku v prohlížeči.';
  }

  // The procedure's address, or with {questionId, sectionId} one question in it
  // (?questionKey={questionId}-{sectionId}, which also opens a section, V8).
  function procedureHref(auditId, procedureId, at) {
    checkId(auditId, 'zakázky');
    checkId(procedureId, 'procedury');
    at = at || {};
    var path = '/audit/' + auditId + '/procedure/' + procedureId;
    if (!at.questionId) return path;
    checkId(at.questionId, 'otázky');
    var sectionId = at.sectionId === undefined ? null : at.sectionId;
    if (sectionId !== null && !/^\d+$/.test(String(sectionId))) throw apiError('BAD_ID', 'Neplatné ID sekce: ' + sectionId);
    return path + '?questionKey=' + itemKey(at.questionId, sectionId);
  }

  // Set by every change (iaud-write.js), before its first request.
  var changed = false;
  function markChanged() {
    changed = true;
  }

  // Opens the procedure with an in-app link. The app caches a form it has
  // shown once, also across in-app navigation, so after a change in this tab
  // it would show the old answers: then only freshView shows it (V8, V3).
  function openProcedure(auditId, procedureId, at) {
    var href = procedureHref(auditId, procedureId, at);
    if (changed) {
      throw apiError('STALE_TAB', 'Tato karta po změně ukazuje staré odpovědi, proceduru proto ukážu v kartě s náhledem.');
    }
    var path = href.split('?')[0];
    if (href === path && currentPath() === path) return 'Procedura už je v prohlížeči otevřená.';
    clickLink(href);
    return 'Otevírám proceduru v prohlížeči.';
  }

  // After a change: the address Claude opens in a second tab of the Browser
  // pane, where a full load shows the saved state. This tab is never reloaded,
  // so the helpers are sent only once per task (a re-send was what the safety
  // classifier stopped, V3). If this tab shows a form, it goes to the zakázka,
  // so the user doesn't type into old answers.
  function freshView(auditId, procedureId, at) {
    var href = procedureHref(auditId, procedureId, at);
    if (currentPath().indexOf('/procedure/') !== -1) clickLink('/audit/' + auditId);
    return {
      url: root.location.origin + href,
      message: 'Uložený stav ukazuji v samostatné kartě s náhledem. Karta, ve které pracuji, ukazuje jen přehled zakázky; ' +
        'odpovědi v ní se po změně neobnovují.',
    };
  }

  // Question types we know (V9), with a Czech label; title/subtitle are headings.
  var TYPE_LABELS = {
    text: 'Text',
    yes_no: 'Ano/Ne',
    single_select: 'Výběr jedné možnosti',
    multi_select: 'Výběr více možností',
    date: 'Datum',
  };
  var HEADING_TYPES = ['title', 'subtitle'];

  var WEB_ONLY = 'nelze upravit přes Clauda, použijte web';

  // Why Claude must not write this question, or null. What we haven't seen
  // live is left to the web app (PLAN §2): unknown types (yes_no_na and
  // short_text exist only in the app's code), conditions and risks.
  function readOnlyReason(question) {
    if (isHeading(question)) return 'Jde o nadpis, nemá odpověď.';
    if (!TYPE_LABELS[question.type]) return 'Otázka má neznámý typ „' + question.type + '“: ' + WEB_ONLY + '.';
    if (question.condition) return 'Otázka se zobrazuje podle podmínky: ' + WEB_ONLY + '.';
    if (question.risks) return 'Odpověď může spouštět rizika: ' + WEB_ONLY + '.';
    return null;
  }

  function isBlank(answer) {
    return !answer || /^\s*$/.test(answer);
  }

  function isHeading(question) {
    return HEADING_TYPES.indexOf(question.type) !== -1;
  }

  // An item's key, as the app builds it for ?questionKey= (V8).
  function itemKey(questionId, sectionId) {
    return questionId + '-' + sectionId;
  }

  // A stored answer as the app shows it: yes_no "true"/"false", multi_select
  // joined with ";", date YYYY-MM-DD (V8).
  function displayAnswer(type, answer) {
    if (type === 'yes_no') return answer === 'true' ? 'Ano' : answer === 'false' ? 'Ne' : answer;
    if (type === 'multi_select') return answer.split(';').join(', ');
    var d = type === 'date' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(answer);
    if (d) return Number(d[3]) + '. ' + Number(d[2]) + '. ' + d[1];
    return answer;
  }

  // With {redact: true} (dev sessions, CLAUDE.md) text written by people is
  // replaced by its length, so no answers leave the page.
  function redacted(text, options) {
    if (!options.redact) return text;
    var n = String(text).length;
    return '[' + n + (n === 1 ? ' znak' : n >= 2 && n <= 4 ? ' znaky' : ' znaků') + ']';
  }

  function findAnswer(answers, questionId, sectionId) {
    for (var i = 0; i < answers.length; i++) {
      if (answers[i].questionId === questionId && answers[i].sectionId === sectionId) return answers[i];
    }
    return null;
  }

  // One question (or heading) of the form, for the user.
  function showItem(question, no, sectionId, form, shown, options) {
    if (isHeading(question)) return { heading: question.question, level: question.type };
    var a = findAnswer(form.answers || [], question.questionId, sectionId) || {};
    var item = { no: no, questionId: question.questionId, sectionId: sectionId, question: question.question,
      type: TYPE_LABELS[question.type] || question.type };
    if (question.selectOptions && question.selectOptions.length) item.options = question.selectOptions;
    if (question.instructions) item.instructions = question.instructions;
    item.answered = !isBlank(a.answer);
    if (item.answered) item.answer = options.redact ? redacted(a.answer, options) : displayAnswer(question.type, a.answer);
    if (!isBlank(a.description)) item.description = redacted(a.description, options);
    if (!isBlank(a.comment)) item.comment = redacted(a.comment, options);
    if (a.attachments && a.attachments.length) item.attachments = a.attachments.length;
    var readOnly = readOnlyReason(question);
    if (readOnly) item.readOnly = readOnly;
    if (!shown) item.hidden = 'v aplikaci skrytá (podmínka není splněna)';
    return item;
  }

  // The form as the app lays it out: parts of {section, questions}, where the
  // questions in details.repeatRange ([start, end) over the questions sorted by
  // sequence) repeat once per section and the rest are once per form (V8, V9).
  // Port of the app's form initializer (CnyOc14V.js, app 1.2.6) via the
  // v3-write prototype, which matched the app on all 624 procedures.
  function layoutForm(form) {
    var questions = (form.questions || []).slice().sort(bySequence);
    var details = form.details;
    if (!details || !details.repeatable || !details.repeatRange) return [{ section: null, questions: questions }];
    var clamp = function (v, lo, hi) { return Math.max(lo, Math.min(v, hi)); };
    var start = clamp(details.repeatRange[0], 0, questions.length);
    var end = clamp(details.repeatRange[1], start, questions.length);
    var parts = [{ section: null, questions: questions.slice(0, start) }];
    (form.sections || []).slice().sort(bySequence).forEach(function (s) {
      parts.push({ section: s, questions: questions.slice(start, end) });
    });
    parts.push({ section: null, questions: questions.slice(end) });
    return parts.filter(function (part) { return part.section || part.questions.length; });
  }

  // Every question of the form once per section it is answered in, with its
  // answer and whether its condition lets the app show it.
  function expandForm(form) {
    var items = [];
    layoutForm(form).forEach(function (part) {
      var sectionId = part.section ? part.section.sectionId : null;
      part.questions.forEach(function (question) {
        var a = findAnswer(form.answers || [], question.questionId, sectionId);
        items.push({ question: question, sectionId: sectionId, answer: (a && a.answer) || '' });
      });
    });
    items.forEach(function (item) { item.shown = isShown(item, items, {}); });
    return items;
  }

  function isShown(item, items, seen) {
    var key = itemKey(item.question.questionId, item.sectionId);
    if (seen[key]) return false;
    seen[key] = true;
    return conditionHolds(item.question.condition, items, item.sectionId, seen);
  }

  function copy(seen) {
    var out = {};
    Object.keys(seen).forEach(function (k) { out[k] = true; });
    return out;
  }

  // A condition is checked against the trimmed answer of the referenced
  // question in the same section; it is false if that one is hidden or missing.
  function conditionHolds(condition, items, sectionId, seen) {
    if (!condition) return true;
    if ('operator' in condition) {
      var test = function (c) { return conditionHolds(c, items, sectionId, copy(seen)); };
      return condition.operator === 'and' ? condition.conditions.every(test) : condition.conditions.some(test);
    }
    var ref = null;
    for (var i = 0; i < items.length; i++) {
      if (items[i].question.questionId === condition.questionId && items[i].sectionId === sectionId) { ref = items[i]; break; }
    }
    if (!ref || !isShown(ref, items, copy(seen))) return false;
    return condition.target === 'answer' &&
      compare(ref.answer.trim(), condition.condition, condition.operation, condition.not);
  }

  function compare(value, target, operation, not) {
    var hit = false;
    if (operation === 'equals') hit = target === value;
    else if (operation === 'not equals') hit = target !== value;
    else if (operation === 'startsWith') hit = value.startsWith(target);
    else if (operation === 'endsWith') hit = value.endsWith(target);
    else if (operation === 'contains') hit = value.includes(target);
    return not ? !hit : hit;
  }

  // What the app stores as {progress, total}: non-blank answers of shown,
  // non-heading questions, repeat-range questions once per section.
  function computeProgress(form) {
    return countProgress(expandForm(form));
  }

  function countProgress(items) {
    var counted = items.filter(function (item) { return !isHeading(item.question) && item.shown; });
    var progress = counted.filter(function (item) { return !isBlank(item.answer); }).length;
    return { progress: progress, total: counted.length };
  }

  function showForm(component, form, options) {
    // Numbers follow the questions in order; a section repeats its range's numbers.
    var numbers = {};
    var no = 0;
    var parts = layoutForm(form);
    parts.forEach(function (part) {
      part.questions.forEach(function (question) {
        if (numbers[question.questionId] || isHeading(question)) return;
        numbers[question.questionId] = ++no;
      });
    });
    var items = expandForm(form);
    var shown = {};
    items.forEach(function (item) { shown[itemKey(item.question.questionId, item.sectionId)] = item.shown; });
    return {
      componentId: component.componentId,
      stored: { progress: component.progress, total: component.total },
      computed: countProgress(items),
      parts: parts.map(function (part) {
        var sectionId = part.section ? part.section.sectionId : null;
        return {
          section: part.section ? { sectionId: sectionId, name: redacted(part.section.name, options) } : null,
          items: part.questions.map(function (question) {
            return showItem(question, numbers[question.questionId], sectionId, form,
              shown[itemKey(question.questionId, sectionId)], options);
          }),
        };
      }),
    };
  }

  function procedureNumber(displayId) {
    return displayId ? String(displayId).replace(/^Procedura\s+/, '') : null;
  }

  // The procedure by its number ("180", "111a", "Procedura Testy") or its ID.
  function findProcedure(procedures, procedure, audit) {
    var wanted = normalizeName(String(procedure).replace(/^\s*procedur[ay]\s+/i, ''));
    var id = String(procedure).trim().toLowerCase();
    var p = procedures.filter(function (x) {
      return x.procedureId === id || normalizeName(procedureNumber(x.displayId || (x.template || {}).displayId)) === wanted;
    })[0];
    if (!p) throw apiError('NOT_FOUND', 'Proceduru „' + procedure + '“ jsem v zakázce ' + auditLabel(audit) + ' nenašel.');
    return p;
  }

  function procedureBase(audit, p) {
    return 'audits/audit/' + audit.auditId + '/procedures/procedure/' + p.procedureId;
  }

  // Each component of the procedure: a form as `view` (showForm) lays it out, anything else read-only.
  function readForms(base, p, options, view) {
    return Promise.all((p.components || []).map(function (c) {
      if (c.componentType !== 'form') {
        return { componentId: c.componentId, componentType: c.componentType, readOnly: 'Část „' + c.componentType + '“: ' + WEB_ONLY + '.' };
      }
      return apiGet(base + '/components/' + c.componentId + '/data').then(function (d) { return (view || showForm)(c, d.data, options); });
    }));
  }

  // One procedure of an engagement (ID or client name), by its number ("180",
  // "111a", "Testy") or its ID, as readable Czech: headings, numbered questions
  // with type, options, hint and answer, the AI Shrnutí and the progress.
  function showProcedure(engagement, procedure, options) {
    options = options || {};
    var audit;
    var p;
    var base;
    return findAudit(engagement).then(function (a) {
      audit = a;
      return apiGet('audits/audit/' + a.auditId + '/procedures/list');
    }).then(function (procedures) {
      p = findProcedure(procedures, procedure, audit);
      base = procedureBase(audit, p);
      return readForms(base, p, options);
    }).then(function (forms) {
      // The Shrnutí is extra: if it can't be read, the procedure is still shown.
      return apiGet(base + '/summary/get').catch(function (err) {
        if (err.code === 'LOGGED_OUT' || err.code === 'NETWORK') throw err;
        return { failed: err.message };
      }).then(function (s) {
        var t = p.template || {};
        var readOnly = 0;
        forms.forEach(function (f) {
          if (f.readOnly) readOnly++;
          (f.parts || []).forEach(function (part) {
            part.items.forEach(function (i) { if (i.readOnly && !i.heading) readOnly++; });
          });
        });
        var stored = sumProgress(forms, 'stored');
        var computed = sumProgress(forms, 'computed');
        var result = {
          auditId: audit.auditId,
          client: audit.client && audit.client.name,
          year: audit.year,
          procedureId: p.procedureId,
          number: procedureNumber(p.displayId || t.displayId),
          name: p.name || t.name,
          status: procedureStatus(p),
          progress: computed ? computed.progress + '/' + computed.total : null,
          summary: s && s.summary ? redacted(s.summary, options) : null,
          readOnly: readOnly,
          forms: forms,
        };
        if (s && s.failed) result.summaryNote = 'Shrnutí se nepodařilo načíst (' + s.failed + ')';
        if (computed && (computed.progress !== stored.progress || computed.total !== stored.total)) {
          result.progressNote = 'Uložené počítadlo (' + stored.progress + '/' + stored.total + ') není aktuální; skutečný stav je ' +
            result.progress + '. iAuditing ho opraví, až někdo proceduru otevře.';
        }
        return result;
      });
    });
  }

  // Answers short enough to decide with (Ano/Ne, a choice, a date) are kept;
  // free text, descriptions and comments stay in the page.
  var CLOSED_TYPES = [TYPE_LABELS.yes_no, TYPE_LABELS.single_select, TYPE_LABELS.multi_select, TYPE_LABELS.date];

  // A question of listQuestions: what it asks, whether it is answered, and its
  // reference "<procedure>/<no>", in a section with its name and ID in brackets
  // (the ID still matches after the section is renamed).
  function listItem(number, item, section) {
    if (item.heading) return item;
    var where = section ? ' (' + section.name + ', sekce ' + section.sectionId + ')' : '';
    var out = { ref: number + '/' + item.no + where, no: item.no,
      questionId: item.questionId, sectionId: item.sectionId };
    if (section) out.section = section.name;
    out.question = item.question;
    out.type = item.type;
    ['options', 'instructions'].forEach(function (k) { if (item[k]) out[k] = item[k]; });
    out.answered = item.answered;
    if (item.answered && CLOSED_TYPES.indexOf(item.type) !== -1) out.answer = item.answer;
    ['readOnly', 'hidden'].forEach(function (k) { if (item[k]) out[k] = item[k]; });
    return out;
  }

  var MAX_PROCEDURES = 15;

  // The questions of a few procedures of one engagement, in the order asked,
  // without their Shrnutí or notes: the material for a client questionnaire.
  function listQuestions(engagement, procedures, options) {
    options = options || {};
    procedures = [].concat(procedures);
    // V11 / VOP 9.12 g: what the task needs, not a sweep over the engagement.
    if (procedures.length > MAX_PROCEDURES) {
      return Promise.reject(apiError('TOO_MANY', 'Najednou čtu nejvýš ' + MAX_PROCEDURES + ' procedur; vyberte prosím jen ty, které potřebujete.'));
    }
    var audit;
    return findAudit(engagement).then(function (a) {
      audit = a;
      return apiGet('audits/audit/' + a.auditId + '/procedures/list');
    }).then(function (all) {
      var found = procedures.map(function (procedure) { return findProcedure(all, procedure, audit); });
      return Promise.all(found.map(function (p) {
        return readForms(procedureBase(audit, p), p, options).then(function (forms) {
          var t = p.template || {};
          var number = procedureNumber(p.displayId || t.displayId);
          var out = { number: number, name: p.name || t.name, procedureId: p.procedureId, items: [] };
          forms.forEach(function (f) {
            if (f.readOnly) { out.readOnly = out.readOnly ? out.readOnly + ' ' + f.readOnly : f.readOnly; return; }
            f.parts.forEach(function (part) {
              part.items.forEach(function (item) { out.items.push(listItem(number, item, part.section)); });
            });
          });
          return out;
        });
      }));
    }).then(function (list) {
      return { auditId: audit.auditId, client: audit.client && audit.client.name, year: audit.year, procedures: list };
    });
  }

  // The plugin's source line, the last line of a Popis (PLAN §4, #17, #20):
  // "[FAKT] Zdroj: …", "[NÁVRH – ověřit] Zdroj: …", or "Zdroj: …" once the
  // auditor confirmed a draft in chat. The plain form counts only as a last
  // paragraph of its own (the whole Popis, or after an empty line), since an
  // auditor may write "Zdroj:" too; the save preview shows old and new Popis.
  var MARK_LINE = /^(?:\[(FAKT|NÁVRH – ověřit)\] )?Zdroj: /;
  var MARK_KINDS = { FAKT: 'fact', 'NÁVRH – ověřit': 'draft' };
  var NL = String.fromCharCode(10);

  // {auditor, mark}: the auditor's text (minus our empty line) and our mark {kind, source, line} or null.
  function splitDescription(description) {
    var text = description || '';
    var last = text.split(NL).pop();
    var m = MARK_LINE.exec(last);
    var rest = m ? text.slice(0, text.length - last.length) : '';
    var own = rest === '' || rest.slice(-2) === NL + NL;
    if (!m || (!m[1] && !own)) return { auditor: text, mark: null };
    var auditor = rest === '' ? '' : own ? rest.slice(0, -2) : rest.slice(0, -1);
    var kind = m[1] ? MARK_KINDS[m[1]] : 'confirmed';
    return { auditor: auditor, mark: { kind: kind, source: last.slice(m[0].length), line: last } };
  }

  // showForm, with each Popis split into the auditor's text and the plugin's mark.
  function answerView(component, form, options) {
    var shown = showForm(component, form, options);
    shown.parts.forEach(function (part) {
      part.items.forEach(function (item) {
        if (item.heading) return;
        var split = splitDescription((findAnswer(form.answers || [], item.questionId, item.sectionId) || {}).description);
        item.description = isBlank(split.auditor) ? undefined : redacted(split.auditor, options);
        if (split.mark) item.mark = { kind: split.mark.kind, source: redacted(split.mark.source, options) };
      });
    });
    return shown;
  }

  // An answer of readAnswers: listQuestions' reference plus what is stored.
  function answerItem(number, item, section) {
    if (item.heading) return item;
    var out = listItem(number, item, section);
    delete out.answered;
    out.empty = !item.answered;
    ['answer', 'description', 'comment', 'attachments', 'mark'].forEach(function (k) { if (item[k] !== undefined) out[k] = item[k]; });
    out.draft = !!(item.mark && item.mark.kind === 'draft');
    return out;
  }

  var MAX_ANSWER_PROCEDURES = 5;

  // The answers of the few earlier procedures a question builds on (#21), one
  // procedure after the other. V11 / VOP 9.12 g: what the task needs, never a sweep.
  function readAnswers(engagement, procedures, options) {
    options = options || {};
    procedures = [].concat(procedures);
    if (procedures.length > MAX_ANSWER_PROCEDURES) {
      return Promise.reject(apiError('TOO_MANY', 'Najednou čtu odpovědi nejvýš ' + MAX_ANSWER_PROCEDURES +
        ' procedur; vyberte prosím jen ty, na které otázka navazuje.'));
    }
    if (!procedures.length) return Promise.reject(apiError('TOO_FEW', 'Napište prosím, ze kterých procedur mám odpovědi přečíst.'));
    var audit;
    return findAudit(engagement).then(function (a) {
      audit = a;
      return apiGet('audits/audit/' + a.auditId + '/procedures/list');
    }).then(function (all) {
      var found = [];
      procedures.forEach(function (procedure) {
        var p = findProcedure(all, procedure, audit);
        if (found.indexOf(p) === -1) found.push(p);
      });
      var list = [];
      return found.reduce(function (done, p) {
        return done.then(function () { return readForms(procedureBase(audit, p), p, options, answerView); }).then(function (forms) {
          var t = p.template || {};
          var number = procedureNumber(p.displayId || t.displayId);
          var computed = sumProgress(forms, 'computed');
          var out = { number: number, name: p.name || t.name, procedureId: p.procedureId, status: procedureStatus(p),
            progress: computed && computed.progress + '/' + computed.total, answered: 0, empty: 0, drafts: 0, items: [] };
          forms.forEach(function (f) {
            if (f.readOnly) { out.readOnly = out.readOnly ? out.readOnly + ' ' + f.readOnly : f.readOnly; return; }
            f.parts.forEach(function (part) {
              part.items.forEach(function (item) {
                var a = answerItem(number, item, part.section);
                if (!a.heading) { out[a.empty ? 'empty' : 'answered']++; if (a.draft) out.drafts++; }
                out.items.push(a);
              });
            });
          });
          list.push(out);
        });
      }, Promise.resolve()).then(function () {
        return { auditId: audit.auditId, client: audit.client && audit.client.name, year: audit.year, procedures: list };
      });
    });
  }

  // Stored or computed progress summed over the procedure's forms, or null.
  function sumProgress(forms, which) {
    forms = forms.filter(function (f) { return f[which]; });
    if (!forms.length) return null;
    var sum = { progress: 0, total: 0 };
    forms.forEach(function (f) { sum.progress += f[which].progress || 0; sum.total += f[which].total || 0; });
    return sum;
  }

  iaud.check = check;
  iaud.listAudits = listAudits;
  iaud.listProcedures = listProcedures;
  iaud.openAudit = openAudit;
  iaud.openProcedure = openProcedure;
  iaud.freshView = freshView;
  iaud.showProcedure = showProcedure;
  iaud.listQuestions = listQuestions;
  iaud.readAnswers = readAnswers;
  iaud.computeProgress = computeProgress;
  iaud.readOnlyReason = readOnlyReason;

  // For the other helper files (iaud-write.js), which check iaud.version
  // first. Not for Claude: the skill calls only the functions above.
  iaud._internal = {
    apiGet: apiGet, apiSend: apiSend, apiError: apiError, throttle: throttle, auditRole: auditRole, roleLabel: roleLabel,
    findAudit: findAudit, findProcedure: findProcedure, procedureBase: procedureBase, procedureNumber: procedureNumber,
    procedureStatus: procedureStatus, auditLabel: auditLabel, normalizeName: normalizeName, checkId: checkId,
    showForm: showForm, layoutForm: layoutForm, computeProgress: computeProgress, readOnlyReason: readOnlyReason,
    isBlank: isBlank, isHeading: isHeading, findAnswer: findAnswer, itemKey: itemKey, displayAnswer: displayAnswer,
    redacted: redacted, fnv1a: fnv1a, TYPE_LABELS: TYPE_LABELS, splitDescription: splitDescription,
    markChanged: markChanged,
  };
  // Self-checks of the other helper files, by name ("iaud-write": "délka …, hash …").
  iaud.extensions = {};

  // FNV-1a over the UTF-16 code units, as 8 hex digits.
  function fnv1a(text) {
    var h = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  // The self-check covers this whole function as the browser parsed it, so a
  // truncated or retyped copy shows a different length or hash than SKILL.md.
  var source = String(install);
  iaud.selfCheck = 'délka ' + source.length + ', hash ' + fnv1a(source);

  if (typeof module === 'object' && module.exports) {
    module.exports = iaud;
  } else {
    root.iaud = iaud;
  }
  return 'iaud ' + VERSION + ' loaded, ' + iaud.selfCheck;
})(typeof window !== 'undefined' ? window : globalThis);
