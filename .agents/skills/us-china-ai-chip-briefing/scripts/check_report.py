#!/usr/bin/env python3
"""Mechanical HTML QA. PASS never establishes source-specific factual correctness."""
import argparse
from collections import Counter
from datetime import date
from pathlib import Path
import re
from html_model import Document, normalized
from qa_common import finding, emit, exit_code

MONTHS = {m: i+1 for i,m in enumerate('JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC'.split())}
# Presentation labels only. Technical/agency abbreviations are not globally exempt.
COMMON_OK = set('AI HTML PDF FIGURE EXECUTIVE RISK TECHNOLOGY BRIEFING MONITORING STATUS GLOSSARY APPENDIX MANAGEMENT VIEW SEMICONDUCTOR INTELLIGENCE PUBLIC SOURCE PUBLIC-SOURCE DEMO OCT SEP NOV DEC JAN FEB MAR APR MAY JUN JUL AUG USD CNY RMB'.split())
PROCESS = ('上一版','本版','本期补入','修订版','草稿','初稿','审稿','根据反馈','因此保留','本章补','新增主线')


def dates_in(text):
    found=[]
    patterns=[(r'(\d{4})[-./](\d{1,2})[-./](\d{1,2})',lambda m:(int(m[1]),int(m[2]),int(m[3]))),
              (r'(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日',lambda m:(int(m[1]),int(m[2]),int(m[3]))),
              (r'(?<!\d)(\d{1,2})\s+('+'|'.join(MONTHS)+r')\s+(\d{4})(?!\d)',lambda m:(int(m[3]),MONTHS[m[2].upper()],int(m[1])))]
    for pat,parts in patterns:
        for m in re.finditer(pat,text,re.I):
            try:
                found.append((m.start(),date(*parts(m)).isoformat()))
            except ValueError:
                found.append((m.start(),'INVALID:'+m[0]))
    return [d for _,d in sorted(found)]


def glossary_terms(path):
    if not path:
        return set()
    terms=set()
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        m=re.match(r'\|\s*([^|]+?)\s*\|',line)
        if m and m[1] not in ('Term','---'):
            terms.add(m[1].split(' / ')[0].split(' (')[0].removesuffix(' list'))
    return terms


def first_use_explained(text, pos, term):
    before,after=text[max(0,pos-60):pos],text[pos+len(term):pos+len(term)+100]
    # "……名单（简称 1260H 名单）": the descriptive name comes first, the short form follows
    window=text[max(0,pos-80):pos+len(term)+120]
    if re.search(r'[\u4e00-\u9fff]{4,}[^。；\n]{0,40}[（(]\s*(?:简称|下称|以下简称)\s*'+re.escape(term),window):
        return True
    # Require actual descriptive content: an opening parenthesis alone proves nothing.
    if re.match(r'\s*[（(][^）)]*[\u4e00-\u9fff]{2}',after):
        return True
    if re.search(r'[\u4e00-\u9fff]{4,}[^。；\n]{0,20}[（(]\s*$',before) and re.match(r'\s*[）)]',after):
        return True
    return bool(re.match(r'\s*[:：]\s*[\u4e00-\u9fff]{2}',after))


def validate_report(raw, expected_date=None, glossary=None):
    doc=Document(raw)
    items=[]
    def add(status,code,msg,**kw):
        items.append(finding(status,code,msg,**kw))
    segments=doc.visible_segments()
    text=''.join(s for s,_ in segments)
    offsets=[]
    offset=0
    for s,n in segments:
        offsets.append((offset,offset+len(s),n))
        offset+=len(s)
    def node_at(pos):
        return next((n for a,b,n in offsets if a<=pos<b),doc.root)

    for p in sorted(set(re.findall(r'\{\{[^}]*\}\}',raw))):
        add('FAIL','PLACEHOLDER',p)
    for n in doc.nodes:
        for key,value in n.attrs.items():
            if key in ('href','src','data-claim-id') and (value or '').strip() in ('#','TODO','TBD',''):
                add('FAIL','PLACEHOLDER',f'Empty/draft {key}',line=n.line)
    for w in PROCESS:
        if w in text:
            add('FAIL','DRAFT_LANGUAGE',f'Visible editorial wording: {w}')
    if re.search(r'(?i)\b(?:draft|revision|reviewer notes?|TODO|TBD)\b|(?:版本\s*V\d+|V\d+\s*(?:版|Final|Draft))',text):
        add('FAIL','DRAFT_LANGUAGE','Visible draft/revision/placeholder language')

    # Compare designated report-date regions; do not compare event/data-cutoff dates.
    regions={}
    mast=doc.selected('mastmeta')
    if mast:
        strong=[n for n in doc.nodes if n.tag=='strong' and any(any(p is m for m in mast) for p in n.ancestors())]
        regions['masthead']=' '.join(n.text() for n in strong)
    issues=doc.selected('issue')
    if issues:
        regions['issue']=' '.join(n.text() for n in issues).split('资料截至')[0].split('数据截至')[0]
    foot=[n for n in doc.nodes if n.tag=='footer']
    if foot:
        regions['footer']=' '.join(n.text() for n in foot)
    titles=[n for n in doc.nodes if n.tag=='title']
    if titles:
        regions['title']=''.join(c for n in titles for c in n.children if isinstance(c,str))
    actual={}
    for name in ('masthead','issue','footer'):
        ds=dates_in(regions.get(name,''))
        if not ds:
            add('UNVERIFIED','DATE_MISSING',f'No explicit full report date in {name}')
        elif any(d.startswith('INVALID:') for d in ds):
            add('FAIL','DATE_INVALID',f'{name}: {ds}')
        elif len(set(ds))>1:
            add('FAIL','DATE_CONFLICT',f'Multiple report dates in {name}: {ds}')
        else:
            actual[name]=ds[0]
    if expected_date:
        try:
            actual['expected']=date.fromisoformat(expected_date).isoformat()
        except ValueError:
            add('FAIL','DATE_INVALID','--date must be a valid YYYY-MM-DD')
    title_dates=dates_in(regions.get('title',''))
    if title_dates:
        actual['title']=title_dates[0]
    for n in doc.nodes:
        if 'data-report-date' in n.attrs:
            declared=n.attrs['data-report-date']
            # A hidden annotation cannot override visible disagreement.
            actual[f'annotation:line{n.line}']=declared
            if not isinstance(declared,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',declared) or not dates_in(declared) or dates_in(declared)[0].startswith('INVALID:'):
                add('FAIL','DATE_INVALID',f'Invalid data-report-date: {declared}',line=n.line)
    if len(set(actual.values()))>1:
        add('FAIL','DATE_CONFLICT',f'Report-date mismatch: {actual}')
    elif all(k in actual for k in ('masthead','issue','footer')):
        add('PASS','DATES',f'Report-date regions agree: {actual["masthead"]}')

    # Search first occurrence in reading order. Later glossary/abbr never excuses it.
    known=glossary_terms(glossary)
    pattern=r'(?<![A-Za-z0-9])(?:[A-Z][A-Z0-9]{1,}(?:-[A-Z0-9]+)?(?:\.\d+)?|\d{3,}[A-Z])(?![a-zA-Z0-9])'
    matches=[(m.start(),m[0]) for m in re.finditer(pattern,text)]
    for term in known:
        if term not in COMMON_OK and re.search(r'[A-Za-z]',term):
            matches.extend((m.start(),term) for m in re.finditer(r'(?<![A-Za-z0-9])'+re.escape(term)+r'(?![A-Za-z0-9])',text))
    seen=set()
    # Same start position: keep only the longest term ("COINS Act", not also "COINS")
    longest={}
    for pos,term in matches:
        if len(term)>len(longest.get(pos,'')):
            longest[pos]=term
    matches=sorted(longest.items())
    for pos,term in matches:
        if term in seen or term in COMMON_OK or re.fullmatch(r'\d+B',term):
            continue
        n=node_at(pos)
        # English navigational labels only, not news titles or table cells.
        if any(p.classes & {'micro','kicker','smallhead','exhibit-tag'} for p in n.ancestors()):
            continue
        # Source link labels ("AP 报道 ↗") and the publisher disclaimer are attribution, not content.
        if any(p.tag=='a' or p.classes & {'tiny','margin-cap'} for p in n.ancestors()):
            continue
        # Currency prefixes such as NT$ / HK$ / US$
        if text[pos+len(term):pos+len(term)+1]=='$':
            continue
        seen.add(term)
        abbr=next((p for p in n.ancestors() if p.tag=='abbr'),None)
        title=(abbr.attrs.get('title') or '').strip() if abbr else ''
        explained=bool(title and title!=term and (re.search(r'[\u4e00-\u9fff]{2}',title) or len(title.split())>=2))
        if not explained and not first_use_explained(text,pos,term):
            add('UNVERIFIED','FIRST_USE',f'{term}: explain at first visible use; later glossary does not count',line=n.line,term=term)

    figs=[]
    label_nodes=[n for n in doc.nodes if n.classes & {'micro','exhibit-tag'} or n.tag=='figcaption']
    figure_blocks=[n for n in doc.nodes if n.tag=='figure' or n.classes & {'data-figure','policy-timeline'}]
    figures_found=[]
    for n in label_nodes:
        # Count label nodes outside figures, and collect figure labels once per block.
        if not any(any(p is f for f in figure_blocks) for p in n.ancestors()):
            figures_found.extend((n.line,int(m[1])) for m in re.finditer(r'\bFIGURE\s+(\d+)\b',n.text(),re.I))
    for n in figure_blocks:
        own_labels=[label for label in label_nodes if any(p is n for p in label.ancestors())]
        labels=[int(m[1]) for label in own_labels for m in re.finditer(r'\bFIGURE\s+(\d+)\b',label.text(),re.I)]
        if not labels:
            labels=[int(m[1]) for m in re.finditer(r'\bFIGURE\s+(\d+)\b',n.text(),re.I)]
        if not labels:
            add('FAIL','FIGURE_MISSING','Figure has no numbered label',line=n.line)
        elif len(labels)>1:
            add('UNVERIFIED','FIGURE_MULTIPLE_LABELS','Multiple labels inside one figure; review label structure',line=n.line)
        if labels:
            figures_found.append((n.line,labels[0]))
    figs=[number for _,number in sorted(figures_found,key=lambda pair:pair[0])]
    if len(figs)!=len(set(figs)):
        add('FAIL','FIGURE_DUPLICATE',f'Duplicate figure labels: {figs}')
    if figs and figs!=list(range(1,len(figs)+1)):
        add('FAIL','FIGURE_SEQUENCE',f'Expected labels in order 1..{len(figs)}; found {figs}')
    if figs and figs==list(range(1,len(figs)+1)):
        add('PASS','FIGURES',f'{len(figs)} figures numbered in order')
    chapters=[]
    for n in doc.selected('kicker'):
        m=re.match(r'\s*(\d+)\s*/',n.text())
        if m:
            chapters.append(int(m[1]))
    if chapters and chapters!=list(range(1,len(chapters)+1)):
        add('FAIL','CHAPTER_SEQUENCE',f'Chapter labels: {chapters}')

    # Map actual legend entries by dot class, accepting V17 wording variations.
    states={'confirmed':r'(官方|政府|公司).*(公告|声明)', 'reported':r'(媒体|未经|尚未).*?(报道|核验|验证|数据)', 'pending':r'(拟议|待审批|待生效)'}
    legends=doc.selected('status-key')
    mapped={}
    for legend in legends:
        for dot in doc.nodes:
            if dot.tag=='i' and any(p is legend for p in dot.ancestors()):
                cl=dot.classes
                state='reported' if cl & {'a','report'} else 'pending' if cl & {'s','pending'} else 'confirmed' if cl & {'g','key-dot'} else None
                if state:
                    mapped[state]=normalized(dot.parent.text())
    for n in doc.selected('st'):
        used=n.classes & states.keys()
        if len(used)!=1:
            add('FAIL','STATUS_CLASS','Status label needs exactly one known class',line=n.line)
            continue
        state=next(iter(used))
        if state not in mapped:
            add('UNVERIFIED','LEGEND_MISSING',f'No machine-readable legend entry for {state}',line=n.line)
        elif not re.search(states[state],mapped[state]):
            add('FAIL','LEGEND_MISMATCH',f'{state} legend wording conflicts: {mapped[state]}',line=n.line)
        declared=n.attrs.get('data-evidence-status')
        if declared and declared!=state:
            add('FAIL','STATUS_MISMATCH',f'Class {state} differs from data-evidence-status {declared}',line=n.line)
        if state=='confirmed' and re.fullmatch(r'\s*(?:媒体报道|未经独立验证|尚未核验)\s*',n.text()):
            add('FAIL','STATUS_MISMATCH','Confirmed label explicitly says unverified/reporting',line=n.line)
    if re.search(r'\.st\.pending\s*:{1,2}before\s*\{[^}]*var\(\s*--red\s*\)',raw):
        add('FAIL','STATUS_COLOUR','Pending uses red rather than slate')

    counts=Counter()
    for n in doc.nodes:
        if n.tag=='p' or 'summary' in n.classes:
            counts.update(s.strip() for s in re.split(r'[。！？]',normalized(n.text())) if len(s.strip())>=18)
    for s,c in counts.items():
        if c>1:
            add('UNVERIFIED','REPETITION',f'{c} repeated sentences: {s[:90]}')
    caveats=sum(text.count(w) for w in ('不等于','不代表','不能据此','并不意味着'))
    if caveats>8:
        add('UNVERIFIED','CAVEATS',f'{caveats} caveat phrases; review duplicated substance')
    if not any(n.tag=='a' and (n.attrs.get('href') or '').startswith(('http://','https://')) for n in doc.nodes):
        add('FAIL','NO_SOURCES','No external source hyperlinks')
    items.extend(required_structure(doc,text,mapped))
    add('PASS','MECHANICAL_COMPLETE','Mechanical scan completed; missing facts and semantic status require reviewer')
    return items


# Sections a reader relies on. Detected from visible wording and real elements, not only
# from template class names, so a report written with its own HTML cannot skip them.
REQUIRED_SECTIONS = (
    ('本期三个判断', lambda doc, text: '三个判断' in text, 'three headline judgments ("本期三个判断")'),
    ('事件状态表', lambda doc, text: any(n.tag == 'table' for n in doc.nodes) and bool(re.search(r'事件状态|MONITORING STATUS', text)),
     'event status table (<table> under "事件状态 / MONITORING STATUS")'),
    ('管理层参考', lambda doc, text: bool(re.search(r'管理层参考|MANAGEMENT VIEW', text)), 'management view ("管理层参考")'),
)
VERIFIED_WORDS = r'已验证|已核实|已核验|经核实|(?i:\bfully verified\b|\bverified\b)'


def required_structure(doc, text, legend_map):
    """Structural rules that a model writing its own HTML could otherwise bypass."""
    items = []
    for name, present, label in REQUIRED_SECTIONS:
        if not present(doc, text):
            items.append(finding('FAIL', 'SECTION_MISSING', f'Required section missing: {label}', field=name))
    has_stories = any(n.tag == 'article' for n in doc.nodes) or any('data-claim-id' in n.attrs for n in doc.nodes)
    if has_stories and not doc.selected('st'):
        items.append(finding('FAIL', 'STATUS_LABELS_MISSING',
                             'No template status labels (class "st confirmed|reported|pending"); custom badges are not checked against the legend'))
    if has_stories and not legend_map:
        items.append(finding('FAIL', 'SECTION_MISSING', 'No machine-readable status legend (.status-key with dot classes g/a/s)', field='状态图例'))
    hits = list(re.finditer(VERIFIED_WORDS, text))
    if hits:
        words = sorted({m[0] for m in hits})
        items.append(finding('FAIL', 'VERIFIED_WORDING',
                             f'Report claims verification {len(hits)} times ({"、".join(words)}); the workflow never verifies facts on its own',
                             excerpt=normalized(text[max(0, hits[0].start() - 15):hits[0].end() + 15])))
    return items


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('html')
    ap.add_argument('--date')
    ap.add_argument('--glossary')
    ap.add_argument('--json',dest='json_path')
    args=ap.parse_args()
    items=validate_report(Path(args.html).read_text(encoding='utf-8'),args.date,args.glossary)
    emit(items,args.json_path)
    return exit_code(items)


if __name__=='__main__':
    raise SystemExit(main())
