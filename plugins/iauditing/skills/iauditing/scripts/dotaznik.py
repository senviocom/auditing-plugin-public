"""The client questionnaire (dotazník klienta) of the iauditing plugin, #22.

  python3 dotaznik.py build spec.json out.docx
  python3 dotaznik.py read returned.docx [--original sent.docx]

`build` writes a Czech DOCX from Claude's spec: part A, numbered questions
(1, 2, ...) in one table per topic with room for the answer, and part B, the
document request list (D1, D2, ...) as a checklist. Every row carries the
column "Odkaz" with the procedure/question it came from ("103/21", or
"180/2 (Tržby, sekce 546)" in a section), so a returned file can be matched back.
`read` turns a returned DOCX into JSON: {questions: [{n, section, question,
refs, answer}], documents: [{n, document, refs, delivered, note}],
respondent, warnings}. With --original it takes the references from the file
that was sent when the client dropped or changed them.

Spec (JSON): {client, year, date?, returnBy?, firm?, intro?,
  sections: [{title, questions: [{text, refs: [..], hint?}]}],
  documents: [{text, refs: [..], hint?}]}

Standard library only: the Cowork sandbox and the dev machine need nothing
installed. No question text ships with the plugin (V11): it all comes from
the spec, which Claude writes from the user's own engagement.
"""
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
W14 = 'http://schemas.microsoft.com/office/word/2010/wordml'

QUESTION_HEADER = ['Č.', 'Otázka', 'Odpověď', 'Odkaz']
DOCUMENT_HEADER = ['Č.', 'Dokument', 'Předáno', 'Poznámka', 'Odkaz']
# Widths in twentieths of a point; together the A4 text width with 2 cm margins.
QUESTION_WIDTHS = [567, 4536, 3685, 850]
DOCUMENT_WIDTHS = [567, 4536, 964, 2721, 850]
REF = re.compile(r'^[^/\s]+/\d+( \(.+\))?$')
RESPONDENT = 'Vyplnil(a):'
UNCHECKED, CHECKED = '☐', '☒'

INTRO = ('Vážení, v rámci přípravy auditu účetní závěrky za rok {year} vás prosíme o vyplnění tohoto dotazníku '
         'a o zaslání podkladů uvedených v části B. Odpovídejte prosím přímo do sloupce „Odpověď“. Pokud je '
         'odpověď delší nebo ji obsahuje některý dokument, stačí uvést, ve kterém souboru ji najdeme.')
REF_NOTE = 'Sloupec „Odkaz“ slouží nám k přiřazení odpovědí. Prosíme, neměňte ho.'


# ---------------------------------------------------------------- build

def validate(spec):
    """The spec's problems as a list of sentences; empty when it is fine."""
    problems = []
    for key in ('client', 'year'):
        if not spec.get(key):
            problems.append(f'missing "{key}"')
    sections = spec.get('sections') or []
    documents = spec.get('documents') or []
    if not sections and not documents:
        problems.append('no sections and no documents')

    def check(what, item):
        if not str(item.get('text') or '').strip():
            problems.append(f'{what}: empty text')
        refs = item.get('refs')
        if not isinstance(refs, list) or not refs:
            problems.append(f'{what}: no refs (each row must point back to a procedure question)')
            return
        for ref in refs:
            if not REF.match(str(ref)):
                problems.append(f'{what}: bad ref {ref!r} (expected "103/21" or "180/2 (Tržby, sekce 546)")')

    for i, section in enumerate(sections, 1):
        if not str(section.get('title') or '').strip():
            problems.append(f'section {i}: empty title')
        if not section.get('questions'):
            problems.append(f'section {i}: no questions')
        for j, q in enumerate(section.get('questions') or [], 1):
            check(f'section {i} question {j}', q)
    for i, d in enumerate(documents, 1):
        check(f'document {i}', d)
    return problems


def _run(text, bold=False, italic=False, size=None, color=None, font=None):
    props = ''
    if font:
        props += f'<w:rFonts w:ascii="{font}" w:eastAsia="{font}" w:hAnsi="{font}"/>'
    if bold:
        props += '<w:b/>'
    if italic:
        props += '<w:i/>'
    if color:
        props += f'<w:color w:val="{color}"/>'
    if size:
        props += f'<w:sz w:val="{size}"/><w:szCs w:val="{size}"/>'
    rpr = f'<w:rPr>{props}</w:rPr>' if props else ''
    return f'<w:r>{rpr}<w:t xml:space="preserve">{escape(str(text))}</w:t></w:r>'


def _p(content='', style=None, keep_next=False, space_after=None):
    props = ''
    if style:
        props += f'<w:pStyle w:val="{style}"/>'
    if keep_next:
        props += '<w:keepNext/>'
    if space_after is not None:
        props += f'<w:spacing w:after="{space_after}"/>'
    ppr = f'<w:pPr>{props}</w:pPr>' if props else ''
    return f'<w:p>{ppr}{content}</w:p>'


def _checkbox():
    """A Word checkbox the client can click; other editors see the glyph."""
    return ('<w:sdt><w:sdtPr><w14:checkbox><w14:checked w14:val="0"/>'
            '<w14:checkedState w14:val="2612" w14:font="MS Gothic"/>'
            '<w14:uncheckedState w14:val="2610" w14:font="MS Gothic"/></w14:checkbox></w:sdtPr>'
            f'<w:sdtContent>{_run(UNCHECKED, size=24, font="MS Gothic")}</w:sdtContent></w:sdt>')


def _cell(width, paragraphs, shade=None):
    shd = f'<w:shd w:val="clear" w:color="auto" w:fill="{shade}"/>' if shade else ''
    return (f'<w:tc><w:tcPr><w:tcW w:w="{width}" w:type="dxa"/>{shd}</w:tcPr>'
            + ''.join(paragraphs or [_p()]) + '</w:tc>')


def _table(widths, header, rows):
    borders = ''.join(f'<w:{side} w:val="single" w:sz="4" w:space="0" w:color="999999"/>'
                      for side in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'))
    out = [f'<w:tbl><w:tblPr><w:tblW w:w="{sum(widths)}" w:type="dxa"/><w:tblLayout w:type="fixed"/>'
           f'<w:tblBorders>{borders}</w:tblBorders>'
           '<w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/></w:tblCellMar></w:tblPr>',
           '<w:tblGrid>' + ''.join(f'<w:gridCol w:w="{w}"/>' for w in widths) + '</w:tblGrid>',
           '<w:tr><w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>'
           + ''.join(_cell(w, [_p(_run(h, bold=True))], shade='E7E6E6') for w, h in zip(widths, header)) + '</w:tr>']
    for cells in rows:
        out.append('<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="850" w:hRule="atLeast"/></w:trPr>'
                   + ''.join(_cell(w, c) for w, c in zip(widths, cells)) + '</w:tr>')
    out.append('</w:tbl>')
    return ''.join(out)


def _text_cell(text, hint=None):
    paragraphs = [_p(_run(text))]
    if hint:
        paragraphs.append(_p(_run(hint, italic=True, size=18, color='666666')))
    return paragraphs


def _refs_cell(refs):
    return [_p(_run(ref, size=16, color='808080')) for ref in refs]


def document_xml(spec):
    year = spec['year']
    body = [_p(_run('Dotazník pro klienta'), style='Title'),
            _p(_run(f'{spec["client"]} – audit účetní závěrky za rok {year}', bold=True, size=24))]
    meta = []
    if spec.get('firm'):
        meta.append(f'Auditor: {spec["firm"]}')
    if spec.get('date'):
        meta.append(f'Datum: {spec["date"]}')
    if meta:
        body.append(_p(_run(' · '.join(meta), color='666666')))
    body.append(_p(_run(spec.get('intro') or INTRO.format(year=year))))
    if spec.get('returnBy'):
        body.append(_p(_run(f'Vyplněný dotazník a podklady prosíme zaslat do {spec["returnBy"]}.', bold=True)))
    body.append(_p(_run(REF_NOTE, italic=True, size=18, color='666666')))

    n = 0
    if spec.get('sections'):
        body.append(_p(_run('A. Otázky'), style='Heading1', keep_next=True))
        for section in spec['sections']:
            body.append(_p(_run(section['title']), style='Heading2', keep_next=True))
            rows = []
            for q in section['questions']:
                n += 1
                rows.append([[_p(_run(f'{n}.', bold=True))], _text_cell(q['text'], q.get('hint')), [_p()],
                             _refs_cell(q['refs'])])
            body.append(_table(QUESTION_WIDTHS, QUESTION_HEADER, rows))
    if spec.get('documents'):
        body.append(_p(_run('B. Požadované dokumenty'), style='Heading1', keep_next=True))
        body.append(_p(_run('Prosíme o zaslání těchto podkladů, nejlépe elektronicky (PDF, XLSX). '
                            'Odeslané dokumenty si můžete označit ve sloupci „Předáno“.')))
        rows = []
        for i, d in enumerate(spec['documents'], 1):
            rows.append([[_p(_run(f'D{i}', bold=True))], _text_cell(d['text'], d.get('hint')), [_p(_checkbox())], [_p()],
                         _refs_cell(d['refs'])])
        body.append(_table(DOCUMENT_WIDTHS, DOCUMENT_HEADER, rows))
    body.append(_p(_run('Děkujeme za spolupráci.'), space_after=240))
    body.append(_p(_run(RESPONDENT + ' ', bold=True)))
    body.append(_p(_run('Funkce: ', bold=True)))
    body.append(_p(_run('Datum: ', bold=True)))

    sect = ('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
            '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/>'
            '</w:sectPr>')
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<w:document xmlns:w="{W}" xmlns:w14="{W14}" '
            'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14">'
            f'<w:body>{"".join(body)}{sect}</w:body></w:document>')


STYLES = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="{W}">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>
<w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="cs-CZ"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>
<w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
<w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>
<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>
</w:styles>'''

CONTENT_TYPES = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>'''

RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>'''

DOCUMENT_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>'''


def core_xml(spec):
    title = escape(f'Dotazník pro klienta – {spec["client"]} ({spec["year"]})')
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/">'
            f'<dc:title>{title}</dc:title><dc:language>cs-CZ</dc:language></cp:coreProperties>')


def build(spec, path):
    problems = validate(spec)
    if problems:
        raise ValueError('invalid questionnaire spec: ' + '; '.join(problems))
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', CONTENT_TYPES)
        z.writestr('_rels/.rels', RELS)
        z.writestr('word/_rels/document.xml.rels', DOCUMENT_RELS)
        z.writestr('word/document.xml', document_xml(spec))
        z.writestr('word/styles.xml', STYLES)
        z.writestr('docProps/core.xml', core_xml(spec))


# ---------------------------------------------------------------- read

def _q(tag):
    return f'{{{W}}}{tag}'


def _text(el):
    """Paragraphs joined by newlines; runs, tabs and breaks as Word shows them."""
    lines = []
    for p in el.iter(_q('p')):
        parts = []
        for node in p.iter():
            if node.tag == _q('t'):
                parts.append(node.text or '')
            elif node.tag == _q('tab'):
                parts.append('\t')
            elif node.tag in (_q('br'), _q('cr')):
                parts.append('\n')
        lines.append(''.join(parts))
    return '\n'.join(lines).strip()


def _first_line(el):
    p = el.find(_q('p'))
    return _text(p) if p is not None else ''


def _style(p):
    s = p.find(f'{_q("pPr")}/{_q("pStyle")}')
    return s.get(_q('val')) if s is not None else None


def _refs(cell):
    return [r.strip() for r in re.split(r'[\n;]', _text(cell)) if r.strip()]


def _delivered(cell):
    for checked in cell.iter(f'{{{W14}}}checked'):
        if checked.get(f'{{{W14}}}val') in ('1', 'true'):
            return True
    t = _text(cell).replace(UNCHECKED, '').strip().lower()
    if not t or re.match(r'^ne\b', t):
        return False
    return True


def read(path, original=None):
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read('word/document.xml'))
    body = root.find(_q('body'))
    out = {'questions': [], 'documents': [], 'respondent': None, 'warnings': []}
    section = None
    for el in body:
        if el.tag == _q('p'):
            text = _text(el)
            if _style(el) == 'Heading2':
                section = text
            elif text.startswith(RESPONDENT):
                out['respondent'] = text[len(RESPONDENT):].strip() or None
            continue
        if el.tag != _q('tbl'):
            continue
        rows = el.findall(_q('tr'))
        if not rows:
            continue
        header = [_text(c) for c in rows[0].findall(_q('tc'))]
        kind = ('questions' if header[:3] == QUESTION_HEADER[:3] else
                'documents' if header[:3] == DOCUMENT_HEADER[:3] else None)
        if not kind:
            continue
        col = {name: i for i, name in enumerate(header)}
        if 'Odkaz' not in col:
            out['warnings'].append(f'{kind}: the column "Odkaz" is missing')
        for tr in rows[1:]:
            cells = tr.findall(_q('tc'))

            def cell(name, read_cell, missing=''):
                i = col.get(name)
                return read_cell(cells[i]) if i is not None and i < len(cells) else missing

            key = _text(cells[0]).rstrip('.') if cells else ''
            refs = cell('Odkaz', _refs, [])
            if kind == 'questions':
                out['questions'].append({'n': int(key) if key.isdigit() else key, 'section': section,
                                         'question': cell('Otázka', _first_line), 'refs': refs,
                                         'answer': cell('Odpověď', _text)})
            else:
                out['documents'].append({'n': key, 'document': cell('Dokument', _first_line), 'refs': refs,
                                         'delivered': cell('Předáno', _delivered, None), 'note': cell('Poznámka', _text)})
    if original:
        _match_original(out, read(original))
    return out


def _match_original(out, sent):
    """Takes the references from the file that was sent, by number, and warns
    where the client's file differs from it."""
    for kind, text in (('questions', 'question'), ('documents', 'document')):
        by_n = {row['n']: row for row in sent[kind]}
        for row in out[kind]:
            was = by_n.get(row['n'])
            if not was:
                out['warnings'].append(f'{kind} {row["n"]}: not in the original')
                continue
            if row['refs'] != was['refs']:
                if row['refs']:
                    out['warnings'].append(f'{kind} {row["n"]}: refs changed from {was["refs"]} to {row["refs"]}; using the original')
                row['refs'] = was['refs']
            if row[text] != was[text]:
                out['warnings'].append(f'{kind} {row["n"]}: the text differs from the original')
        missing = set(by_n) - {row['n'] for row in out[kind]}
        for n in sorted(missing, key=str):
            out['warnings'].append(f'{kind} {n}: missing in the returned file')


def main(argv):
    if len(argv) == 3 and argv[0] == 'build':
        with open(argv[1], encoding='utf-8') as f:
            build(json.load(f), argv[2])
        print(f'written {argv[2]}')
        return 0
    if argv and argv[0] == 'read' and len(argv) in (2, 4) and (len(argv) == 2 or argv[2] == '--original'):
        result = read(argv[1], argv[3] if len(argv) == 4 else None)
        print(json.dumps(result, ensure_ascii=False, indent=1))
        return 0
    print(__doc__.split('\n\n')[1], file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
