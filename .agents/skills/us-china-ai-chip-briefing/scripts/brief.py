#!/usr/bin/env python3
"""Single-agent briefing pipeline. The agent reads, judges and writes; this script keeps the records.

Stages communicate through files in RUN/, so any stage can later be handed to a separate agent:
  run_config.json       window, timezone, cutoff, report language     (init)
  sources.json          every page registered, opened or blocked      (fetch)      + sources/S###.txt
  events.json           every candidate event and its decision        (event)
  evidence_ledger.json  claims with located quotes and snapshots      (add-claim, withdraw)
  report.json           the agent's analysis and judgments           (agent writes)
  report.html, coverage.json, qa/                                     (build)

Commands (run from the skill folder):
  brief.py init RUN [--days 7] [--end YYYY-MM-DD] [--tz Asia/Hong_Kong] [--lang zh|en] [--no-cases]
  brief.py fetch RUN URL [--file PAGE.txt] [--route browser|http_tool|api|reprint]
  brief.py event RUN add --title T --date YYYY-MM-DD --side us|cn|both|other [--source S001] [--url U]
                         [--materiality high|medium|low] [--why TEXT] [--category ID] [--case A001]
  brief.py event RUN decide E001 include|track|exclude --reason TEXT [--followup TEXT] [--status-note TEXT] [--proposed] [--unsupported]
                         [--link TEXT --size TEXT --new TEXT]
  brief.py add-claim RUN E001 S001 --quote "exact words from the page" --text "中文句子" [--kind legal] [--type news]
  brief.py withdraw RUN C001 --reason TEXT
  brief.py search RUN "query" [--found "what it turned up"]
  brief.py batch RUN OPS.json                (run many fetch/event/add-claim/source-date/withdraw/search commands at once)
  brief.py precheck RUN [--issue-date YYYY-MM-DD]   (multi-agent chief: the checks a draft submission runs, before submitting)
  brief.py status RUN
  brief.py build RUN [--network] [--issue-date YYYY-MM-DD]
  brief.py verify-select RUN [--max 12]      (multi-agent: the claims an independent verifier checks, as JSON)
  brief.py gaps RUN [--lead us=DIR] [--lead cn=DIR] [--max 20]   (multi-agent: coverage gaps, as JSON; see gaps.py)
  brief.py gap-check RUN/gap_report.json TASK_DIR --task ID    (multi-agent: does a lead's gap report hold?)

The report language is set once at init (zh by default; en renders the English template wording).
"""
import argparse
from datetime import date, datetime, timedelta, timezone
from difflib import SequenceMatcher
import html
import json
from pathlib import Path
import re
import sys

SCRIPTS = Path(__file__).resolve().parent
SKILL = SCRIPTS.parent
sys.path.insert(0, str(SCRIPTS))
from check_quotes import validate_quotes, host_of  # noqa: E402
from check_evidence import KINDS  # noqa: E402
import evidence_tools as ev  # noqa: E402
import gaps as gap_round  # noqa: E402

STATUS = {'confirmed': ('g', '官方或公司正式公告'), 'reported': ('a', '媒体报道或未经独立验证'),
          'pending': ('s', '拟议、待审批或待生效'), 'unverified': ('u', '尚未找到来源支持')}
PRIMARY = {'official_document', 'company_statement', 'dataset'}
SIDE_CN = {'us': '美国', 'cn': '中国', 'both': '中美', 'other': '其他'}
DECISIONS = ('include', 'track', 'exclude')
EVIDENCE_CN = {'supported': '官方或公司原文已打开', 'partial': '仅有媒体报道', 'unresolved': '原文未能取得或尚未核实',
               'unsupported': '核心说法无法得到来源支持'}
MONTH_EN = 'January February March April May June July August September October November December'.split()

# Fixed report wording per language. The English strings follow assets/template.html (tests keep them in step).
LABELS = {
    'zh': {
        'lang': 'zh-CN', 'title': '中美 AI 与半导体观察｜{d:%Y.%m.%d}', 'brand': '中美 AI 与半导体观察',
        'tags': '政策 · 企业声誉 · 技术竞争 · 资本市场', 'print': '打印 / PDF ↗',
        'issue': 'EXECUTIVE RISK &amp; TECHNOLOGY BRIEFING / {date} / 资料截至 {cut}',
        'thesis_sep': '，', 'readpath': '3 分钟阅读：本期三个判断 → 事件状态表 → 管理层参考',
        'questions': '管理层关注的三个问题', 'public_only': '公开资料情报简报；不使用任何金融机构的内部客户信息、授信记录或敞口数据。',
        'judgments': '本期三个判断', 'panel': 'MONITORING STATUS / 事件状态', 'panel_title': '哪些事项已确认，下一步看什么？',
        'columns': ('事项', '证据状态', '下一节点', '位置'), 'carried': '延续跟踪的事项', 'new': '本期新增', 'join': '；',
        'chapter': '见第 {n} 章', 'tracking': '仅跟踪', 'key': '标记',
        'chip': {'confirmed': '官方', 'reported': '媒体报道', 'pending': '拟议', 'unverified': '暂无来源'},
        'background': '背景：', 'change': '本次变化：', 'impact': '影响：', 'response': '企业回应：', 'uncertain': '尚不确定：',
        'source': '来源：', 'blocked': '；未能打开：', 'host_join': '、', 'watch': '后续观察',
        'closing': '后续监测事项', 'closing_title': '未来一个月的关键节点', 'view': 'MANAGEMENT VIEW / 管理层参考',
        'view_lead': '可能改变下一期判断的证据：', 'disclaimer': '本简报仅使用公开资料，不代表任何金融机构的立场或内部风险评级。',
        'glossary': 'GLOSSARY / 术语速查', 'term_sep': '：', 'footer': '事实 / 指控 / 拟议政策 / 分析推断明确区分',
        'status': {k: v[1] for k, v in STATUS.items()}, 'side': SIDE_CN, 'evidence': EVIDENCE_CN,
        'mixed': '部分说法仅有媒体报道', 'proposed': '拟议：', 'verify_gap': '独立核验未能找到关键说法的来源',
    },
    'en': {
        'lang': 'en', 'title': 'US-China AI &amp; Semiconductor Risk Briefing | {d:%Y.%m.%d}', 'brand': 'US-China AI &amp; Semiconductor Monitor',
        'tags': 'Policy · Reputation · Technology · Capital markets', 'print': 'Print / PDF ↗',
        'issue': 'EXECUTIVE RISK &amp; TECHNOLOGY BRIEFING / {date} / Data as of {cut}',
        'thesis_sep': ', ', 'readpath': '3-minute read: Three key judgments → Event status → Management view',
        'questions': 'Three questions for management',
        'public_only': 'Public-source intelligence briefing; uses no internal client, credit or exposure data of any financial institution.',
        'judgments': 'Three key judgments', 'panel': 'MONITORING STATUS / Event status', 'panel_title': 'What is confirmed, and what comes next?',
        'columns': ('Item', 'Evidence status', 'Next milestone', 'Where'), 'carried': 'Carried-over cases', 'new': 'New this period', 'join': '; ',
        'chapter': 'Chapter {n}', 'tracking': 'Tracking only', 'key': 'Key',
        'chip': {'confirmed': 'Official', 'reported': 'Media report', 'pending': 'Proposed', 'unverified': 'No source yet'},
        'background': 'Background: ', 'change': 'What changed: ', 'impact': 'Why it matters: ', 'response': 'Company response: ',
        'uncertain': 'Still uncertain: ', 'source': 'Source: ', 'blocked': '; could not open: ', 'host_join': ', ', 'watch': 'Watch next',
        'closing': 'What to watch', 'closing_title': 'Key milestones in the next month', 'view': 'MANAGEMENT VIEW / Management view',
        'view_lead': 'Evidence that could change our view: ',
        'disclaimer': 'This briefing uses public information only. It is a demonstration output of the HKUST MAS project and does not '
                      'represent the position or internal risk rating of any financial institution.',
        'glossary': 'GLOSSARY / Terms', 'term_sep': ': ', 'footer': 'Facts, allegations, proposed policy and analysis are clearly distinguished',
        'status': {'confirmed': 'Official or company announcement', 'reported': 'Media report, not independently confirmed',
                   'pending': 'Proposed, pending approval or not yet in force', 'unverified': 'No supporting source located'},
        'side': {'us': 'US', 'cn': 'China', 'both': 'US-China', 'other': 'Other'},
        'evidence': {'supported': 'Official or company source opened', 'partial': 'Media reports only',
                     'unresolved': 'Original not obtained or not yet checked', 'unsupported': 'Core claim not supported by a source'},
        'mixed': 'some claims rest on media reports only', 'proposed': 'Proposed: ',
        'verify_gap': 'an independent check found no source for a key claim',
    },
}


def report_lang(run):
    return (load(Path(run) / 'run_config.json', {}) or {}).get('language', 'zh')


def load(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except FileNotFoundError:
        return default


def save(path, obj):
    Path(path).write_text(json.dumps(obj, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def active_cases():
    rows = []
    for line in (SKILL / 'references' / 'active_cases.md').read_text(encoding='utf-8').splitlines():
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if cells and re.fullmatch(r'A\d{3,}', cells[0]) and len(cells) >= 4:
            rows.append({'id': cells[0], 'question': cells[1], 'last_known': cells[2], 'next_check': cells[3]})
    return rows


# ------------------------------------------------------------------ evidence status (deterministic)
def evidence_status(event, claims, risk):
    if event.get('unsupported'):
        return 'unsupported'
    found = [c for cid in event.get('claim_ids') or [] if (c := claims.get(cid)) and risk.get(cid, {}).get('quote_state') == 'FOUND']
    if any(s.get('evidence_type') in PRIMARY for c in found for s in c.get('sources') or []):
        return 'supported'
    return 'partial' if found else 'unresolved'


MAX_CLAIMS_PER_PARAGRAPH = 5
MAX_STATUS_CLAIMS = 3


def found_claims(e, claims, risk):
    """The event's claims whose quote was found in the saved page, in the order they were added."""
    return [c for c in e.get('claim_ids') or [] if c in claims and risk.get(c, {}).get('quote_state') == 'FOUND']


def printed_claims(events, rep, claims, risk):
    """What the report prints, by event: an included event's story paragraphs (lists of claim IDs) and a tracked
    event's status-table claims. The report ledger, coverage and the HTML all read this, so they cannot drift."""
    stories = {s.get('event'): s for s in (rep or {}).get('stories') or []}
    paragraphs, status = {}, {}
    for e in events['events']:
        found = found_claims(e, claims, risk)
        if e.get('decision') == 'include':
            chosen = (stories.get(e['id']) or {}).get('changes')
            paragraphs[e['id']] = [[c for c in para if c in found] for para in chosen] if chosen else [found]
            paragraphs[e['id']] = [para for para in paragraphs[e['id']] if para] or [[]]
        elif e.get('decision') == 'track' and found:
            # A tracked item has no story: its row carries the claims behind its status, so the row can be traced.
            status[e['id']] = [c for c in e.get('status_claims') or [] if c in found][:MAX_STATUS_CLAIMS] or found[:2]
    return paragraphs, status


def printed_ids(events, rep, claims, risk):
    paragraphs, status = printed_claims(events, rep, claims, risk)
    return list(dict.fromkeys([c for paras in paragraphs.values() for para in paras for c in para]
                              + [c for ids in status.values() for c in ids]))


def snapshot_state(run):
    run = Path(run)
    events = load(run / 'events.json', {'events': [], 'window': {}})
    ledger = load(run / 'evidence_ledger.json', {'claims': []})
    sources = {s['id']: s for s in load(run / 'sources.json', {'sources': []})['sources']}
    claims = {c['id']: c for c in ledger.get('claims') or []}
    _, risk = validate_quotes(ledger, False, ledger_dir=run) if claims else ([], {})
    for e in events['events']:
        e['evidence_status'] = evidence_status(e, claims, risk)
    return events, ledger, claims, risk, sources


# ------------------------------------------------------------------ init
def cmd_init(a):
    from zoneinfo import ZoneInfo
    run = Path(a.run)
    run.mkdir(parents=True, exist_ok=True)
    tz = ZoneInfo(a.tz)
    now_local = datetime.now(tz)
    end = date.fromisoformat(a.end) if a.end else now_local.date()
    start = end - timedelta(days=a.days - 1)
    cutoff = a.cutoff or (now_local.replace(microsecond=0) if end == now_local.date()
                          else datetime(end.year, end.month, end.day, 23, 59, 59, tzinfo=tz)).isoformat()
    cfg = {'report_date': end.isoformat(), 'window': {'start': start.isoformat(), 'end': end.isoformat()},
           'timezone': a.tz, 'cutoff': cutoff}
    if a.lang != 'zh':
        cfg['language'] = a.lang
    if not (run / 'run_config.json').exists():
        save(run / 'run_config.json', cfg)
    cases = [] if a.no_cases else active_cases()
    if not (run / 'events.json').exists():
        save(run / 'events.json', {'window': cfg['window'], 'searches': [], 'events': [
            {'id': f'E{i:03d}', 'title': c['question'], 'case_id': c['id'], 'date': None, 'side': '', 'sources': [],
             'materiality': '', 'why_it_matters': '', 'decision': None, 'reason': '', 'claim_ids': [],
             'followup': c['next_check'], 'last_known': c['last_known']} for i, c in enumerate(cases, 1)]})
    if not (run / 'evidence_ledger.json').exists():
        save(run / 'evidence_ledger.json', {'schema_version': 1, 'fixture': False, 'author': 'briefing-agent',
                                            'report_date': cfg['report_date'], 'timezone': a.tz, 'cutoff': cutoff,
                                            'generated_at': None, 'claims': []})
    if not (run / 'sources.json').exists():
        save(run / 'sources.json', {'sources': []})
    if not (run / 'report.json').exists():
        save(run / 'report.json', json.loads((SKILL / 'assets' / 'report.skeleton.json').read_text(encoding='utf-8')))
    print(f"Window {cfg['window']['start']} → {cfg['window']['end']} ({a.tz}); cutoff {cutoff}")
    if cases:
        print(f"{len(cases)} active cases are pre-loaded as events E001–E{len(cases):03d}; each needs a decision.")
    print('NEXT: Stage 1 discovery (references/staged-pipeline.md). Register pages with `fetch`, record events with `event add`.')
    return 0


# ------------------------------------------------------------------ fetch
def cmd_fetch(a):
    fetch = None
    if not a.file:
        from safe_http import safe_get
        fetch = safe_get
    rec, new = ev.register_source(a.run, a.url, a.file, a.route, fetch)
    head = f"{rec['id']} {'registered' if new else 'already registered'} · {rec.get('access')}"
    if rec.get('access') == 'opened':
        print(f"{head} · {rec['chars']} chars · {rec['file']}")
        print(f"  title: {rec.get('title', '')}")
        print(f"  publication date: {rec.get('publication_date') or 'not stated in metadata'}"
              + (f" (dates seen in text: {', '.join(rec['date_candidates'])})" if rec.get('date_candidates') else ''))
    else:
        print(f"{head} · {rec.get('access_note', '')}")
        print('  Not proof the source is wrong. Try sources.md §6 (API, official reprint, browser copy with --file); '
              'if nothing works, keep the event and decide it as track.')
    return 0


# ------------------------------------------------------------------ events
def cmd_event(a):
    run = Path(a.run)
    data = load(run / 'events.json')
    if data is None:
        print('events.json missing: run init first'); return 1
    evs = data['events']
    if a.action == 'add':
        if not a.title:
            print('event add needs --title, --date and --side'); return 1
        if a.side not in SIDE_CN:
            print('--side must be us, cn, both or other'); return 1
        if a.category and a.category not in gap_round.categories():
            print(f'--category must be one of {", ".join(sorted(gap_round.categories()))} (references/roles/categories.json)'); return 1
        try:
            date.fromisoformat(a.date)
        except (TypeError, ValueError):
            print('--date must be YYYY-MM-DD (the date the event happened or was announced)'); return 1
        reg = {s['id']: s for s in load(run / 'sources.json', {'sources': []})['sources']}
        srcs = []
        for sid in a.source or []:
            if sid not in reg:
                print(f'unknown source {sid}; register it with fetch first'); return 1
            srcs.append(sid)
        url = a.url or (reg[srcs[0]]['url'] if srcs else '')
        dup = [e for e in evs if (url and url == e.get('url')) or SequenceMatcher(None, e['title'].lower(), a.title.lower()).ratio() > 0.8]
        eid = f"E{len(evs) + 1:03d}"
        evs.append({'id': eid, 'title': a.title, 'case_id': a.case, 'date': a.date, 'side': a.side, 'sources': srcs,
                    'url': url, 'materiality': a.materiality or '', 'why_it_matters': a.why or '',
                    'decision': None, 'reason': '', 'claim_ids': [], 'followup': '',
                    **({'category': a.category} if a.category else {})})
        save(run / 'events.json', data)
        print(f'{eid} added: {a.title}')
        for d in dup:
            print(f'  possible duplicate of {d["id"]} "{d["title"][:50]}": if it is the same event, exclude one with reason "duplicate of …"')
        return 0
    if a.action == 'decide':
        e = next((e for e in evs if e['id'] == a.id), None)
        if not e:
            print(f'unknown event {a.id}'); return 1
        if a.decision not in DECISIONS:
            print('decision must be include, track or exclude'); return 1
        if not (a.reason or '').strip():
            print('--reason is required (one line)'); return 1
        if a.category and a.category not in gap_round.categories():
            print(f'--category must be one of {", ".join(sorted(gap_round.categories()))} (references/roles/categories.json)'); return 1
        note = ' '.join((a.status_note or '').split())
        if len(note) > 240:
            print('--status-note is one short sentence for the reader (240 characters at most)'); return 1
        status_claims = list(dict.fromkeys(a.status_claim or []))
        if status_claims:
            unknown = [c for c in status_claims if c not in (e.get('claim_ids') or [])]
            if unknown:
                print(f'--status-claim {", ".join(unknown)}: not a claim of {a.id} (add-claim it to this event first)'); return 1
            if len(status_claims) > MAX_STATUS_CLAIMS:
                print(f'--status-claim: at most {MAX_STATUS_CLAIMS} claims for one status row'); return 1
        e.update(decision=a.decision, reason=a.reason)
        if note:
            e['status_note'] = note
        if status_claims:
            e['status_claims'] = status_claims
        for key, field in (('followup', 'followup'), ('materiality', 'materiality'), ('why', 'why_it_matters'), ('side', 'side'), ('title', 'title'),
                           ('category', 'category')):
            if getattr(a, key, None):
                e[field] = getattr(a, key)
        if a.date and not e.get('date'):
            e['date'] = a.date
        for sid in a.source or []:
            if sid not in e['sources']:
                e['sources'].append(sid)
        e['proposed'] = bool(a.proposed) or e.get('proposed', False)
        e['unsupported'] = bool(a.unsupported) or e.get('unsupported', False)
        # The three selection questions (SKILL.md Step 3), kept as fields when given so later stages can check them.
        answers = {k: getattr(a, k).strip() for k in ('link', 'size', 'new') if (getattr(a, k, None) or '').strip()}
        if answers:
            e['assessment'] = {**(e.get('assessment') or {}), **answers}
        # Disagreements recorded by merge_runs.py are settled by this explicit decision; the record is kept.
        if e.get('merge_conflicts'):
            e.setdefault('resolved_conflicts', []).extend(e.pop('merge_conflicts'))
        save(run / 'events.json', data)
        print(f'{a.id}: {a.decision} — {a.reason}')
        if a.decision == 'include':
            print(f'  next: brief.py add-claim RUN {a.id} S### --quote "…" --text "…"')
        return 0
    events, _, _, _, _ = snapshot_state(run)
    for e in events['events']:
        print(f"{e['id']} {e.get('case_id') or '    '} {str(e.get('decision') or '—'):8} {e.get('materiality') or '—':6} "
              f"{e['evidence_status']:10} {len(e.get('claim_ids') or [])} claims · {e['title'][:60]}")
    return 0


# ------------------------------------------------------------------ add-claim
def cmd_add_claim(a):
    run = Path(a.run)
    data = load(run / 'events.json')
    e = next((e for e in (data or {}).get('events', []) if e['id'] == a.event), None)
    if not e:
        print(f'unknown event {a.event}'); return 1
    unknown = [k for k in a.kind or [] if k not in KINDS]
    if unknown:  # the validator fails these later, when only the claim's author could still fix them
        print(f'unknown --kind {", ".join(unknown)}; use {", ".join(sorted(KINDS))}. Nothing was written.'); return 1
    # The source was checked when its page was saved; add_claim records that moment (snapshot.retrieved_at) as
    # date_checked. A date-only stand-in capped at the report date could not be ordered against a same-day publication
    # (run mas-20261123-114940-c5bd: every same-day source was DATE_ORDER_AMBIGUOUS, holding readiness INCOMPLETE).
    cid, msgs = ev.add_claim(run, a.source, a.quote, a.text, a.kind, a.type, a.role, e.get('date'), a.uncertainty,
                             a.anchor, a.notes, a.name)
    if cid and a.pub_date:
        led = load(run / 'evidence_ledger.json')
        for c in led['claims']:
            if c['id'] == cid:
                c['sources'][-1]['publication_date'] = a.pub_date
                c['recorded_sha'] = ev.fingerprint(c)
        save(run / 'evidence_ledger.json', led)
    for m in msgs:
        print(m)
    if not cid:
        return 1
    if cid not in e['claim_ids']:
        e['claim_ids'].append(cid)
    if a.source not in e['sources']:
        e['sources'].append(a.source)
    save(run / 'events.json', data)
    print(f'{cid} recorded for {a.event} (quote located in {a.source}).')
    return 0


# ------------------------------------------------------------------ source-date
def cmd_source_date(a):
    changed, msgs = ev.set_source_date(a.run, a.source, a.date, a.shown, a.undated)
    for m in msgs:
        print(m)
    return 0 if changed is not None else 1


# ------------------------------------------------------------------ withdraw
def cmd_withdraw(a):
    """Take a claim out of the report without deleting it: it moves to the ledger's `withdrawn` list with the reason."""
    run = Path(a.run)
    led = load(run / 'evidence_ledger.json')
    if led is None:
        print('evidence_ledger.json missing: run init first'); return 1
    if not (a.reason or '').strip():
        print('--reason is required (one line)'); return 1
    claim = next((c for c in led['claims'] if c.get('id') == a.claim), None)
    if not claim:
        print(f'unknown claim {a.claim}'); return 1
    led['claims'] = [c for c in led['claims'] if c is not claim]
    led.setdefault('withdrawn', []).append({'claim': claim, 'reason': a.reason.strip(),
                                            'withdrawn_at': datetime.now(timezone.utc).isoformat(timespec='seconds')})
    save(run / 'evidence_ledger.json', led)
    data = load(run / 'events.json', {'events': []})
    touched = [e['id'] for e in data['events'] if a.claim in (e.get('claim_ids') or [])]
    for e in data['events']:
        e['claim_ids'] = [c for c in e.get('claim_ids') or [] if c != a.claim]
    save(run / 'events.json', data)
    print(f'{a.claim} withdrawn ({a.reason.strip()}); removed from {", ".join(touched) or "no event"}.')
    return 0


# ------------------------------------------------------------------ status: the single progress check
def problems(run):
    """Ordered (stage, text) items still open. Stages: 1 discovery, 2 selection, 3 evidence, 4 analysis."""
    run = Path(run)
    events, ledger, claims, risk, sources = snapshot_state(run)
    evs = events['events']
    out = []
    sides = {s for e in evs if not e.get('case_id') for s in (('us', 'cn') if e.get('side') == 'both' else (e.get('side'),))}
    if not [e for e in evs if not e.get('case_id')]:
        out.append(('1 discovery', 'no new events recorded yet (event add)'))
    for s, name in (('us', 'US'), ('cn', 'China')):
        if s not in sides:
            out.append(('1 discovery', f'no new {name}-side event recorded; search that side (sources.md §3)'))
    if len(events.get('searches') or []) < 3:
        out.append(('1 discovery', 'log your searches: brief.py search RUN "query" --found "what it turned up" (at least 3, one beyond the watchlist)'))
    english = report_lang(run) == 'en'
    for e in evs:
        if not e.get('decision'):
            out.append(('2 selection', f'{e["id"]} {e["title"][:45]}: decide include / track / exclude'))
            continue
        if e['decision'] in ('include', 'track') and not e.get('side'):
            out.append(('2 selection', f'{e["id"]}: add --side us|cn|both|other'))
        has_cjk = bool(re.search(r'[\u4e00-\u9fff]', e.get('title') or ''))
        if e['decision'] in ('include', 'track') and english and has_cjk:
            out.append(('2 selection', f'{e["id"]}: shown in the report, so give it a short English title (decide … --title "English title")'))
        if e['decision'] in ('include', 'track') and not english and not has_cjk:
            out.append(('2 selection', f'{e["id"]}: shown in the report, so give it a short Chinese title (decide … --title "中文标题")'))
        if e['decision'] == 'include' and not (e.get('why_it_matters') or '').strip():
            out.append(('2 selection', f'{e["id"]}: included events need --why (the US-China or financial-sector link)'))
    for e in evs:
        if e.get('decision') == 'include' and e['evidence_status'] == 'unresolved':
            out.append(('3 evidence', f'{e["id"]} {e["title"][:45]}: add-claim from a page you opened, '
                                      'or decide it as track (it stays visible as unresolved)'))
    rep = load(run / 'report.json', {})
    included = [e for e in evs if e.get('decision') == 'include']
    if not included:
        out.append(('2 selection', 'nothing is included; a briefing needs at least one included event'))
    storied = {s.get('event') for s in rep.get('stories') or []}
    for e in included:
        if e['id'] not in storied:
            out.append(('4 analysis', f'report.json: write a story for {e["id"]} {e["title"][:45]}'))
    for key in ('deck', 'management_view'):
        if not str(rep.get(key, '')).strip():
            out.append(('4 analysis', f'report.json: "{key}" is empty'))
    if not (rep.get('thesis') or {}).get('lead') or not (rep.get('thesis') or {}).get('emphasis'):
        out.append(('4 analysis', 'report.json: thesis.lead and thesis.emphasis are required'))
    if len([j for j in rep.get('judgments') or [] if j.get('title') and j.get('text')]) != 3:
        out.append(('4 analysis', 'report.json: exactly 3 judgments (title + text), each a finding about this period'))
    if len([q for q in rep.get('questions') or [] if q]) != 3:
        out.append(('4 analysis', 'report.json: 3 questions'))
    for s in rep.get('stories') or []:
        e = next((x for x in evs if x['id'] == s.get('event')), None)
        if not e:
            out.append(('4 analysis', f'report.json story "{str(s.get("title", ""))[:30]}": "event" must be an included event id'))
            continue
        if e.get('decision') != 'include':
            out.append(('4 analysis', f'report.json: story for {e["id"]} but that event is not included'))
        for k in ('chapter', 'title', 'impact'):
            if not str(s.get(k, '')).strip():
                out.append(('4 analysis', f'report.json story {s.get("event")}: "{k}" is empty'))
        found = found_claims(e, claims, risk)
        changes = s.get('changes')
        if changes is None:
            if len(found) > MAX_CLAIMS_PER_PARAGRAPH:
                out.append(('4 analysis', f'report.json story {e["id"]}: {len(found)} claims would print as one "What changed" '
                                          f'paragraph; group them with "changes" (short paragraphs of claim IDs, at most '
                                          f'{MAX_CLAIMS_PER_PARAGRAPH} each, most important first)'))
            continue
        if not isinstance(changes, list) or not changes or not all(isinstance(p, list) and p for p in changes):
            out.append(('4 analysis', f'report.json story {e["id"]}: "changes" is a list of paragraphs, each a non-empty list of claim IDs'))
            continue
        ids = [c for para in changes for c in para]
        for c in dict.fromkeys(ids):
            if c not in (e.get('claim_ids') or []):
                out.append(('4 analysis', f'report.json story {e["id"]}: {c} in "changes" is not a claim of {e["id"]}'))
            elif c not in found:
                out.append(('4 analysis', f'report.json story {e["id"]}: {c} in "changes" has no quote found in its saved page, so it cannot be printed'))
        if len(ids) != len(set(ids)):
            out.append(('4 analysis', f'report.json story {e["id"]}: a claim appears twice in "changes"'))
        for i, para in enumerate(changes, 1):
            if len(para) > MAX_CLAIMS_PER_PARAGRAPH:
                out.append(('4 analysis', f'report.json story {e["id"]}: paragraph {i} of "changes" has {len(para)} claims; '
                                          f'split it (at most {MAX_CLAIMS_PER_PARAGRAPH})'))
    return out


def summary_lines(run):
    events, ledger, claims, risk, sources = snapshot_state(run)
    evs = events['events']
    by = lambda d: [e for e in evs if e.get('decision') == d]
    lines = [f"Sources: {len(sources)} registered ({sum(s.get('access') == 'opened' for s in sources.values())} opened, "
             f"{sum(s.get('access') != 'opened' for s in sources.values())} blocked) · searches recorded: {len(events.get('searches') or [])}",
             f"Events: {len(evs)} ({sum(not e.get('case_id') for e in evs)} new + {sum(bool(e.get('case_id')) for e in evs)} carried cases) · "
             f"include {len(by('include'))} · track {len(by('track'))} · exclude {len(by('exclude'))} · undecided {sum(not e.get('decision') for e in evs)}",
             f"Claims: {len(claims)} · evidence for included/tracked: "
             + ', '.join(f"{k} {sum(e['evidence_status'] == k for e in by('include') + by('track'))}" for k in ('supported', 'partial', 'unresolved'))]
    high_out = [e for e in evs if e.get('materiality') == 'high' and e.get('decision') != 'include']
    if high_out:
        lines.append('High-materiality events outside the main text: '
                     + '; '.join(f"{e['id']} {e.get('decision') or 'undecided'} ({e.get('reason') or 'no reason'})" for e in high_out))
    return lines


def cmd_status(a):
    for l in summary_lines(a.run):
        print(l)
    probs = problems(a.run)
    if not probs:
        print('READY: stages 1–4 complete. NEXT: brief.py build RUN')
        return 0
    stage = probs[0][0]
    shown = [p for p in probs if p[0] == stage][:15]
    print(f'CURRENT STAGE: {stage}')
    for i, (_, p) in enumerate(shown, 1):
        print(f'TODO {i}: {p}')
    if len(probs) > len(shown):
        print(f'({len(probs) - len(shown)} more items in this or later stages)')
    return 1


# ------------------------------------------------------------------ rendering
def glossary():
    rows = {}
    for line in (SKILL / 'references' / 'glossary.md').read_text(encoding='utf-8').splitlines():
        m = re.match(r'\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|', line)
        if m and m[1] not in ('Term', '---') and not m[1].startswith('-'):
            rows[m[1].split(' / ')[0].split(' (')[0].removesuffix(' list')] = m[2]
    return rows


class Writer:
    """Escapes text and explains glossary terms at their first visible use."""

    def __init__(self):
        self.gloss, self.seen = glossary(), set()

    def __call__(self, text):
        out = html.escape(text or '')
        for term, wording in self.gloss.items():
            if term in self.seen:
                continue
            m = re.compile(r'(?<![A-Za-z0-9])' + re.escape(html.escape(term)) + r'(?![A-Za-z0-9])').search(out)
            if m and not re.search(r'<[^>]*$', out[:m.start()]):
                self.seen.add(term)
                out = out[:m.start()] + f'<abbr class="term" title="{html.escape(wording)}">{m[0]}</abbr>' + out[m.end():]
        return out


def link(url, name):
    return f'<a href="{html.escape(url)}" rel="noopener noreferrer" target="_blank">{html.escape(name)} ↗</a>'


def label_for(e):
    """Status label from the evidence, never from the writer: confirmed needs an opened primary source.
    Nothing located is shown as unverified, not as a media report."""
    if e.get('proposed'):
        return 'pending'
    if e['evidence_status'] in ('unresolved', 'unsupported'):
        return 'unverified'
    return 'confirmed' if e['evidence_status'] == 'supported' else 'reported'


# Kinds whose claims decide what a reader takes as settled; an independent check that finds no source for one
# keeps its story from reading as an official announcement.
KEY_KINDS = {'legal', 'list'}
# Verifier outcomes (RUN/claim_verification.json, written by the multi-agent workflow) that leave a claim unsupported.
VERIFY_GAPS = {'not_found', 'contradicted', 'status_differs', 'scope_differs'}


def load_verification(run):
    """Independent-check results by claim ID; empty for single-agent runs."""
    return (load(Path(run) / 'claim_verification.json', {}) or {}).get('claims') or {}


def verify_gap(shown, verification):
    return any(set(c.get('kinds') or []) & KEY_KINDS and (verification.get(c['id']) or {}).get('status') in VERIFY_GAPS
               for c in shown)


def is_primary(claim):
    return any(s.get('evidence_type') in PRIMARY for s in claim.get('sources') or [])


def labels_for(e, shown, verification=None):
    """Labels for a story, claim by claim: an official source for one claim does not make the others official.
    `shown` are the claims printed for it. Mixed evidence gets both labels. A legal or list claim an independent
    check could not support keeps the story from being labelled confirmed."""
    first = label_for(e)
    if first == 'confirmed' and verify_gap(shown, verification or {}):
        return ['unverified']
    if first != 'confirmed' or all(is_primary(c) for c in shown):
        return [first]
    return ['confirmed', 'reported']


def md_date(iso, lang='zh'):
    try:
        d = date.fromisoformat(iso)
    except (TypeError, ValueError):
        return 'Date not stated' if lang == 'en' else '日期未明'
    return f'{MONTH_EN[d.month - 1]} {d.day}, {d.year}' if lang == 'en' else f'{d.month} 月 {d.day} 日'


def long_date(d, lang):
    return f'{MONTH_EN[d.month - 1]} {d.day}, {d.year}' if lang == 'en' else f'{d.year} 年 {d.month} 月 {d.day} 日'


def page(run, issue_date=None):
    run = Path(run)
    cfg, rep = load(run / 'run_config.json'), load(run / 'report.json')
    lang = cfg.get('language', 'zh')
    L = LABELS[lang]
    events, ledger, claims, risk, sources = snapshot_state(run)
    verification = load_verification(run)
    evs = {e['id']: e for e in events['events']}
    paragraphs, status_ids = printed_claims(events, rep, claims, risk)
    w = Writer()
    d = date.fromisoformat(issue_date or cfg['report_date'])
    cut = datetime.fromisoformat(cfg['cutoff'])
    style = re.search(r'<style>.*?</style>', (SKILL / 'assets' / 'template.html').read_text(encoding='utf-8'), re.S)[0]
    mon = 'JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC'.split()[d.month - 1]
    t = rep['thesis']
    chapters = []
    for s in rep['stories']:
        if s['chapter'] not in chapters:
            chapters.append(s['chapter'])
        evs[s['event']]['_chapter'] = chapters.index(s['chapter']) + 1
    cut_text = f'{long_date(cut, lang)} {cut:%H:%M}（{html.escape(cfg["timezone"])}）' if lang == 'zh' \
        else f'{long_date(cut, lang)} {cut:%H:%M} ({html.escape(cfg["timezone"])})'
    P = [f'<!doctype html>\n<html lang="{L["lang"]}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
         f'<title>{L["title"].format(d=d)}</title>\n{style}</head><body><div class="sheet"><div class="inner">',
         '<header class="mast"><div class="identity"><div aria-hidden="true" class="mark"><span></span><span></span><span></span><span></span></div>'
         f'<p>{L["brand"]} <small>AI &amp; SEMICONDUCTOR RISK INTELLIGENCE</small></p></div>'
         f'<div class="mastmeta"><span>{L["tags"]}</span><strong data-report-date="{d.isoformat()}">{d:%Y.%m.%d}</strong>'
         f'<button class="print" onclick="window.print()">{L["print"]}</button></div></header>',
         f'<section class="hero"><div><p class="issue">{L["issue"].format(date=long_date(d, lang), cut=cut_text)}</p>'
         f'<h1>{w(t["lead"])}{L["thesis_sep"]}<em>{w(t["emphasis"])}</em></h1><p class="deck">{w(rep["deck"])}</p>'
         f'<p class="readpath">{L["readpath"]}</p></div>'
         f'<aside class="hero-side"><p class="smallhead">{L["questions"]}</p>'
         + ''.join(f'<p class="q"><b>{i:02d}</b>{w(q)}</p>' for i, q in enumerate(rep['questions'], 1))
         + f'<p class="tiny">{L["public_only"]}</p></aside></section>',
         f'<section class="takeaways"><div class="label">{L["judgments"]}</div>'
         + ''.join(f'<div class="summary"><b>{w(j["title"])}</b>{w(j["text"])}</div>' for j in rep['judgments']) + '</section>']
    # Status table from the event records: tracked and unresolved items stay visible without extra writing.
    # Two groups (new this period, carried-over cases). The status cell shows one chip per evidence label, so a story
    # resting on official and media sources shows both; a short note only where the chip alone says too little
    # (what a proposal rests on, a claim no source supports, a failed independent check, the item's reader-facing
    # status note). Selection reasons stay
    # in coverage.json. data-* attributes let check_report.py compare the chips with the evidence record.
    watch = {s['event']: s.get('watch') for s in rep['stories'] if s.get('watch')}
    visible = [e for e in evs.values() if e.get('decision') in ('include', 'track')]
    order = sorted(visible, key=lambda e: (e['decision'] != 'include', not e.get('case_id'), e['id']))
    groups = [(L['new'], [e for e in visible if not e.get('case_id')]), (L['carried'], [e for e in visible if e.get('case_id')])]
    rows = []
    c1, c2, c3, c4 = L['columns']
    for heading, members in groups:
        if not members:
            continue
        rows.append(f'<tr class="group"><th colspan="4" scope="colgroup">{heading}</th></tr>')
        for e in sorted(members, key=lambda e: (e['decision'] != 'include', e['id'])):
            shown = [claims[c] for c in e.get('claim_ids') or [] if c in claims and risk.get(c, {}).get('quote_state') == 'FOUND']
            labels = labels_for(e, shown, verification)
            gap = verify_gap(shown, verification)
            notes = []
            if labels[0] == 'pending' or (labels[0] == 'unverified' and e['evidence_status'] == 'unsupported'):
                notes.append(L['evidence'][e['evidence_status']])  # what a proposal rests on; a claim no source supports
            if gap:
                notes.append(L['verify_gap'])
            if (e.get('status_note') or '').strip():
                notes.append(e['status_note'].strip())
            attrs = f' data-evidence="{e["evidence_status"]}"' + (' data-proposed="1"' if e.get('proposed') else '') \
                + (' data-mixed="1"' if len(labels) > 1 else '') + (' data-verify-gap="1"' if gap else '')
            chips = ''.join(f'<span class="chip"><i class="dot {STATUS[st][0]}"></i>{L["chip"][st]}</span>' for st in labels)
            note = f'<span class="note">{w(L["join"].join(notes))}</span>' if notes else ''
            # A tracked item's row is where its facts are printed: its status claims, word for word, with their sources.
            backing = [claims[c] for c in status_ids.get(e['id'], [])]
            if backing:
                spans = (' ' if lang == 'en' else '').join(f'<span data-claim-id="{c["id"]}">{w(c["text"])}</span>' for c in backing)
                seen = list(dict.fromkeys(src['url'] for c in backing for src in c['sources']))
                names = {src['url']: src.get('source_name') or host_of(src['url']) for c in backing for src in c['sources']}
                note += f'<span class="note facts">{spans}</span><span class="note src">{L["source"]}{L["join"].join(link(u, names[u]) for u in seen)}</span>'
            where = f'<a href="#ch{e["_chapter"]}">{L["chapter"].format(n=e["_chapter"])}</a>' if e.get('_chapter') else f'<span class="muted">{w(L["tracking"])}</span>'
            # One wrapper per cell: on a phone each cell is a two-column grid (label, content), so loose children
            # (a note, an abbreviation) would otherwise fall into the label column.
            rows.append(f'<tr><td data-label="{c1}"><div>{w(e["title"])}</div></td>'
                        f'<td data-label="{c2}" class="status-cell"{attrs}><div><span class="chips">{chips}</span>{note}</div></td>'
                        f'<td data-label="{c3}"><div>{w(e.get("followup") or watch.get(e["id"]) or "—")}</div></td>'
                        f'<td data-label="{c4}"><div>{where}</div></td></tr>')
    P.append(f'<div class="panel"><div class="micro">{L["panel"]}</div><h2>{L["panel_title"]}</h2>'
             f'<table class="matrix-table status-table mobile-cards"><thead><tr><th style="width:34%">{c1}</th><th style="width:30%">{c2}</th>'
             f'<th style="width:24%">{c3}</th><th style="width:12%">{c4}</th></tr></thead><tbody>{"".join(rows)}</tbody></table>'
             f'<div class="status-key"><b>{L["key"]}</b>' + ''.join(f'<span><i class="dot {STATUS[k][0]}"></i>{lab}</span>' for k, lab in L['status'].items())
             + '</div></div>')
    for ci, ch in enumerate(chapters, 1):
        stories = [s for s in rep['stories'] if s['chapter'] == ch]
        head = next((s['chapter_title'] for s in stories if s.get('chapter_title')), ch)
        P.append(f'<section class="section" id="ch{ci}"><div class="kicker">{ci:02d} / {html.escape(ch)}</div><h2>{w(head)}</h2>')
        for s in stories:
            e = evs[s['event']]
            paras = [[claims[c] for c in para] for para in paragraphs.get(e['id'], [[]])]
            cl = [c for para in paras for c in para]
            joiner = ' ' if lang == 'en' else ''
            texts = [joiner.join(f'<span data-claim-id="{c["id"]}">{w(c["text"])}</span>' for c in para) for para in paras]
            sts = labels_for(e, cl, verification)
            first = cl[0]['sources'][0] if cl else {}
            eyebrow = f'{L["side"].get(e.get("side"), "")} / {first.get("source_name", "")} / {md_date(e.get("date"), lang)}'
            body = (f'<p><strong>{L["background"]}</strong>{w(s["background"])}</p>' if s.get('background') else '') \
                + f'<p><strong>{L["change"]}</strong>{texts[0]}</p>' + ''.join(f'<p>{t}</p>' for t in texts[1:]) \
                + f'<p><strong>{L["impact"]}</strong>{w(s["impact"])}</p>' \
                + (f'<p><strong>{L["response"]}</strong>{w(s["response"])}</p>' if s.get('response') else '') \
                + (f'<p><strong>{L["uncertain"]}</strong>{w(s["uncertain"])}</p>' if s.get('uncertain') else '')
            seen, links = set(), []
            for c in cl:
                for src in c['sources']:
                    if src['url'] not in seen:
                        seen.add(src['url'])
                        links.append(link(src['url'], src.get('source_name') or host_of(src['url'])))
            blocked = [sources[x] for x in e.get('sources') or [] if x in sources and sources[x].get('access') != 'opened']
            note = (L['blocked'] + L['host_join'].join(html.escape(b['host']) for b in blocked)) if blocked else ''
            aside = f'<aside class="lens"><b class="lhead">{L["watch"]}</b><p>{w(s["watch"])}</p></aside>' if s.get('watch') else ''
            P.append(f'<article class="story"><div><div class="labelrow"><span class="eyebrow">{w(eyebrow)}</span>'
                     + ''.join(f'<span class="st {st}">{L["status"][st]}</span>' for st in sts) + f'</div><h3>{w(s["title"])}</h3>{body}'
                     f'<div class="source">{L["source"]}{L["join"].join(links)}{note}</div></div>{aside}</article>')
        P.append('</section><div class="chapterdiv"></div>')
    follows = rep.get('followups') or [{'date': e['followup'], 'text': e['title']} for e in order if e.get('followup')][:6]
    P.append(f'<section class="closing"><div><div class="kicker">{L["closing"]}</div><h2>{L["closing_title"]}</h2><div class="checklist">'
             + ''.join(f'<div class="checkrow"><div class="subject">{w(f["date"])}</div><p>{w(f["text"])}</p></div>' for f in follows)
             + f'</div></div><aside class="lastnote"><p class="smallhead">{L["view"]}</p>'
             f'<p><strong>{L["view_lead"]}</strong>{w(rep["management_view"])}</p>'
             f'<p class="tiny">{L["disclaimer"]}</p></aside></section>')
    gl = ''.join(f'<div><b>{html.escape(k)}{L["term_sep"]}</b>{html.escape(v)}</div>' for k, v in w.gloss.items() if k in w.seen)
    if gl:
        P.append(f'<div class="glossary"><div class="micro">{L["glossary"]}</div><div class="glossary-grid">{gl}</div></div>')
    P.append(f'<footer><span>PUBLIC-SOURCE RISK INTELLIGENCE · {d.day:02d} {mon} {d.year}</span>'
             f'<span>{L["footer"]}</span></footer>\n</div></div></body></html>\n')
    return '\n'.join(P)


def export_coverage(run):
    """coverage.json in the validator's format, derived from events.json (never edited by hand)."""
    events, ledger, claims, risk, sources = snapshot_state(run)
    printed = set(printed_ids(events, load(Path(run) / 'report.json', {}), claims, risk))
    dec = {'include': 'included', 'track': 'background', 'exclude': 'excluded'}
    cands = []
    for e in events['events']:
        c = {'event': e['title'], 'date': e.get('date'), 'side': e.get('side') or 'other', 'url': e.get('url') or '',
             'decision': dec.get(e.get('decision'), 'excluded'), 'reason': e.get('reason') or 'undecided',
             'evidence_status': e['evidence_status'], 'materiality': e.get('materiality')}
        if e.get('case_id'):
            c['case_id'] = e['case_id']
        if e.get('decision') == 'include':
            c['claim_ids'] = [x for x in e.get('claim_ids') or [] if x in printed]
        cands.append(c)
    save(Path(run) / 'coverage.json', {'window': events['window'], 'outlets_searched': sorted({s.get('host') for s in sources.values() if s.get('host')}),
                                       'searches': events.get('searches') or [], 'candidates': cands})


def issue_date_problem(cfg, issue):
    """The issue date is when the report is published. It may be later than the coverage window (a run that
    crosses midnight, a historical window); it may not precede the window's end or lie in the future."""
    from zoneinfo import ZoneInfo
    try:
        d = date.fromisoformat(issue)
    except ValueError:
        return f'--issue-date {issue} is not a YYYY-MM-DD date'
    end = date.fromisoformat(cfg['window']['end'])
    today = datetime.now(ZoneInfo(cfg['timezone'])).date()
    if d < end:
        return f'--issue-date {issue} is before the coverage window ends ({end.isoformat()})'
    if d > today:
        return f'--issue-date {issue} is after today ({today.isoformat()} in {cfg["timezone"]})'
    return None


def cmd_build(a):
    run = Path(a.run)
    cfg = load(run / 'run_config.json')
    if a.issue_date:
        bad = issue_date_problem(cfg, a.issue_date)
        if bad:
            print(f'Not ready to build:\nTODO 1 [dates]: {bad}. The coverage window and cutoff stay as recorded; pass the real issue date.')
            return 1
    led0 = load(run / 'evidence_ledger.json', {}) or {}
    if not a.issue_date and not led0.get('generated_at'):
        from zoneinfo import ZoneInfo
        today = datetime.now(ZoneInfo(cfg['timezone'])).date().isoformat()
        if today > cfg['report_date']:
            # Built without an issue date, the ledger would say it was generated on the report date's day, which the
            # date check rejects (GENERATION_REPORT_MISMATCH). Name the issue date instead of editing the validator.
            print(f'Not ready to build:\nTODO 1 [dates]: today ({today}) is after the report date ({cfg["report_date"]}); '
                  f'pass the real issue date: brief.py build RUN --issue-date {today}')
            return 1
    probs = problems(run)
    if probs:
        print('Not ready to build:')
        for i, (stage, p) in enumerate(probs[:15], 1):
            print(f'TODO {i} [{stage}]: {p}')
        print('NEXT: fix these, then rerun build (status shows the same list).')
        return 1
    led = load(run / 'evidence_ledger.json')
    if a.issue_date:
        # Dated by this build: the report ledger records when it was generated and the day it is issued.
        # The coverage window, cutoff and evidence ledger are untouched.
        header = {'report_date': a.issue_date, 'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds')}
    else:
        if not led.get('generated_at'):
            led['generated_at'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
            save(run / 'evidence_ledger.json', led)
        header = {}
    events, _, claims, risk, _ = snapshot_state(run)
    # evidence_ledger.json keeps every claim (tracked events included). The report ledger holds exactly the
    # claims printed in the report; it is what validation and the human sign-off are bound to.
    shown = printed_ids(events, load(run / 'report.json', {}), claims, risk)
    save(run / 'report_ledger.json', {**{k: v for k, v in led.items() if k != 'claims'}, **header,
                                      'claims': [claims[c] for c in shown]})
    (run / 'report.html').write_text(page(run, a.issue_date), encoding='utf-8')
    export_coverage(run)
    from validate import run_all, print_next_steps
    from qa_common import exit_code
    result, md, signoff = run_all(run / 'report.html', run / 'report_ledger.json', expected_date=a.issue_date or cfg['report_date'],
                                  glossary=SKILL / 'references' / 'glossary.md', network=a.network, coverage_path=run / 'coverage.json',
                                  verification=load_verification(run), gaps=load(run / 'gap_report.json'))
    qa = run / 'qa'
    qa.mkdir(exist_ok=True)
    save(qa / 'review_report.json', result)
    (qa / 'review_report.md').write_text(md + '\n## 研究记录摘要\n\n' + '\n'.join(f'- {l}' for l in summary_lines(run)) + '\n', encoding='utf-8')
    if signoff:
        (qa / 'signoff.md').write_text(signoff, encoding='utf-8')
    allx = [x for xs in result['checks'].values() for x in xs]
    edited = ev.hand_edited(led)
    if edited:
        note = f'Claims changed by hand after add-claim (reviewer must recheck against the saved page): {", ".join(edited)}'
        with open(qa / 'review_report.md', 'a', encoding='utf-8') as fh:
            fh.write(f'\n- {note}\n')
        print('NOTE:', note)
    print(f'Wrote {run / "report.html"} and {qa}/')
    for l in summary_lines(run):
        print(l)
    high = sum(1 for r in result['risk'].values() if r['tier'] == 'high')
    auto = sum(1 for r in result['risk'].values() if r['tier'] == 'low' and r['quote_state'] == 'FOUND')
    print(f'Claims passed automatically: {auto}; claims for a person: {high}; network checks: {"on" if a.network else "off"}')
    print_next_steps(allx)
    if result['readiness'] == 'BLOCKED':
        print('NEXT: fix the FIX lines (rule violations), then rerun build.')
    else:
        print('NEXT: stop. Evidence gaps from sources you could not open are expected: do not drop material events to '
              'clear them. Hand qa/signoff.md to a person; do not publish.')
    return exit_code(allx)


def build_parser():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('init'); p.add_argument('run'); p.add_argument('--days', type=int, default=7)
    p.add_argument('--end'); p.add_argument('--tz', default='Asia/Hong_Kong'); p.add_argument('--cutoff')
    p.add_argument('--lang', choices=['zh', 'en'], default='zh'); p.add_argument('--no-cases', action='store_true')
    p = sub.add_parser('fetch'); p.add_argument('run'); p.add_argument('url'); p.add_argument('--file')
    p.add_argument('--route', choices=['http_tool', 'browser', 'api', 'reprint'])
    p = sub.add_parser('event'); p.add_argument('run'); p.add_argument('action', choices=['add', 'decide', 'list'])
    p.add_argument('id', nargs='?'); p.add_argument('decision', nargs='?')
    p.add_argument('--title'); p.add_argument('--date'); p.add_argument('--side'); p.add_argument('--source', action='append')
    p.add_argument('--url'); p.add_argument('--materiality', choices=['high', 'medium', 'low']); p.add_argument('--why')
    p.add_argument('--reason'); p.add_argument('--followup')
    p.add_argument('--status-note', dest='status_note',
                   help='one sentence for the reader on where the item stands; shown in the status table (the reason is not)')
    p.add_argument('--status-claim', dest='status_claim', action='append',
                   help='claim ID behind a tracked item\'s status, printed in its status-table row (repeat, at most 3)')
    p.add_argument('--proposed', action='store_true'); p.add_argument('--unsupported', action='store_true')
    p.add_argument('--case'); p.add_argument('--link'); p.add_argument('--size'); p.add_argument('--new')
    p.add_argument('--category', help='research category id from references/roles/categories.json')
    p = sub.add_parser('add-claim'); p.add_argument('run'); p.add_argument('event'); p.add_argument('source')
    p.add_argument('--quote', required=True); p.add_argument('--text', required=True); p.add_argument('--kind', action='append')
    p.add_argument('--type', choices=['official_document', 'company_statement', 'news', 'dataset', 'other'])
    p.add_argument('--role', choices=['primary', 'secondary']); p.add_argument('--uncertainty', default='')
    p.add_argument('--anchor'); p.add_argument('--notes', default=''); p.add_argument('--name'); p.add_argument('--pub-date')
    p = sub.add_parser('source-date', help='record the publication date a saved page shows (or why it shows none) on it and its claims')
    p.add_argument('run'); p.add_argument('source')
    p.add_argument('--date', help='YYYY-MM-DD, or an ISO timestamp with its UTC offset, as the page shows it')
    p.add_argument('--shown', help='the date exactly as the page writes it, when it is not in a common format')
    p.add_argument('--undated', help='why the page shows no publication date (e.g. an FAQ, a data file, an index page)')
    p = sub.add_parser('withdraw'); p.add_argument('run'); p.add_argument('claim'); p.add_argument('--reason', required=True)
    p = sub.add_parser('search'); p.add_argument('run'); p.add_argument('query'); p.add_argument('--found', default='')
    p = sub.add_parser('status'); p.add_argument('run')
    p = sub.add_parser('build'); p.add_argument('run'); p.add_argument('--network', action='store_true')
    p.add_argument('--issue-date', help='YYYY-MM-DD the report is issued (default: run_config report_date, the window end)')
    p = sub.add_parser('verify-select'); p.add_argument('run'); p.add_argument('--max', type=int, default=12)
    p = sub.add_parser('gaps'); p.add_argument('run'); p.add_argument('--lead', action='append', help='us=TASK_DIR or cn=TASK_DIR')
    p.add_argument('--max', type=int, default=20); p.add_argument('--discovery-top', type=int, default=10)
    p = sub.add_parser('gap-check'); p.add_argument('round'); p.add_argument('task_dir'); p.add_argument('--task', required=True)
    p = sub.add_parser('batch', help='run many record commands from a JSON file in one call')
    p.add_argument('run'); p.add_argument('ops', help='JSON file (or - for stdin): a list of commands, each a list of words without RUN')
    p = sub.add_parser('precheck', help='the checks a chief draft submission runs, without submitting')
    p.add_argument('run'); p.add_argument('--issue-date')
    return ap


HANDLERS = {}


def main():
    a = build_parser().parse_args()
    HANDLERS.update({'init': cmd_init, 'fetch': cmd_fetch, 'event': cmd_event, 'add-claim': cmd_add_claim, 'search': cmd_search,
                     'withdraw': cmd_withdraw, 'source-date': cmd_source_date, 'status': cmd_status, 'build': cmd_build,
                     'verify-select': cmd_verify_select, 'gaps': gap_round.cmd_gaps, 'gap-check': gap_round.cmd_gap_check,
                     'batch': cmd_batch, 'precheck': cmd_precheck})
    return HANDLERS[a.cmd](a)


BATCH_COMMANDS = ('fetch', 'event', 'add-claim', 'source-date', 'withdraw', 'search')


def _record_ids(run):
    """IDs in the record files, to name what each batch step created."""
    out = set()
    for name, key in (('sources.json', 'sources'), ('events.json', 'events'), ('evidence_ledger.json', 'claims')):
        data = load(run / name, {}) or {}
        items = data.get(key) if isinstance(data, dict) else None
        if isinstance(items, dict):
            out |= set(items)
        elif isinstance(items, list):
            out |= {x.get('id') for x in items if isinstance(x, dict) and x.get('id')}
    return out


def _done(n):
    return 'Nothing was recorded.' if n == 1 else f'Steps 1–{n - 1} are recorded; step {n} and later were not run.'


def cmd_batch(a):
    """One call for many record commands: each step is the usual command's words without RUN, e.g.
    ["event", "add", "--title", "…", "--date", "2026-11-20", "--side", "us"] or ["add-claim", "@1", "S004", "--quote", "…", "--text", "…"].
    "@N" stands for the ID step N created (1-based), so a claim can name the event added two steps earlier.
    Steps run in order and stop at the first failure; the steps before it stay recorded, so rerun only the rest."""
    run = Path(a.run)
    try:
        raw = sys.stdin.read() if a.ops == '-' else Path(a.ops).read_text(encoding='utf-8')
        ops = json.loads(raw)
    except (OSError, json.JSONDecodeError) as e:
        print(f'batch: cannot read {a.ops} as JSON: {e}'); return 1
    if not isinstance(ops, list) or not all(isinstance(op, list) and op and all(isinstance(w, str) for w in op) for op in ops):
        print('batch: the file must be a JSON list of commands, each a list of strings, e.g. [["search", "query"], ["event", "add", "--title", "…"]]')
        return 1
    parser, created = build_parser(), {}
    for n, op in enumerate(ops, 1):
        if op[0] not in BATCH_COMMANDS:
            print(f'step {n}: "{op[0]}" cannot run in a batch (allowed: {", ".join(BATCH_COMMANDS)}). {_done(n)}')
            return 1
        words = []
        for w in op[1:]:
            m = re.fullmatch(r'@(\d+)', w)
            if m:
                ref = created.get(int(m[1]))
                if not ref:
                    print(f'step {n}: {w} names step {m[1]}, which created no ID. {_done(n)}')
                    return 1
                w = ref
            words.append(w)
        try:
            args = parser.parse_args([op[0], str(run), *words])
        except SystemExit:
            print(f'step {n}: the words do not form a valid "{op[0]}" command (usage above). {_done(n)}')
            return 1
        before = _record_ids(run)
        print(f'[{n}] ', end='')
        code = HANDLERS[op[0]](args)
        if code:
            print(f'step {n} failed. {_done(n)} Fix step {n} and run it and the steps after it again.')
            return code
        new = sorted(_record_ids(run) - before)
        if len(new) == 1:
            created[n] = new[0]
    print(f'batch: all {len(ops)} steps done.')
    return 0


def cmd_precheck(a):
    """What a chief draft submission checks first (handoff rules, then build and validation), run before submitting,
    so a refusal costs one local run instead of a submission. Merges Nex has not done yet are not included."""
    run = Path(a.run)
    import subprocess
    r = subprocess.run([sys.executable, str(SCRIPTS / 'check_handoff.py'), str(run), '--role', 'chief', '--json'],
                       capture_output=True, text=True)
    try:
        handoff = json.loads(r.stdout.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError):
        print('precheck: check_handoff.py gave no result:', (r.stderr or r.stdout)[-500:]); return 1
    fails = [f for f in handoff.get('findings', []) if f.get('status') == 'FAIL']
    if fails:
        print(f'Handoff check: {len(fails)} problem(s) a submission would be refused for:')
        for f in fails:
            print(f'FIX {f.get("code")}: {f.get("message")}')
        print('NEXT: fix these, then run precheck again. Build was not run.')
        return 1
    print('Handoff check: no refusals.')
    if not (run / 'report.json').exists():
        print('report.json is missing in RUN: write it, then run precheck again.'); return 1
    code = cmd_build(argparse.Namespace(run=str(run), network=False, issue_date=a.issue_date))
    qa = load(run / 'qa' / 'review_report.json', {}) or {}
    if code == 1 or qa.get('readiness') == 'BLOCKED':
        print('precheck: a submission would be refused. Fix the FIX / TODO lines above, then run precheck again.')
        return 1
    print(f'precheck: no refusal found (validator readiness {qa.get("readiness")}). Submit the draft.')
    return 0


def verification_targets(run, limit):
    """Claims an independent verifier should check, highest risk first: high-risk kinds (the validator's risk tier),
    and the claims that decide a shown event's status label. Each entry says what the report asserts, never where
    the author found it: the verifier looks for its own source."""
    events, _, claims, risk, _ = snapshot_state(run)
    picked = {}
    for e in events['events']:
        if e.get('decision') not in ('include', 'track'):
            continue
        shown = [claims[c] for c in e.get('claim_ids') or [] if c in claims and risk.get(c, {}).get('quote_state') == 'FOUND']
        label = label_for(e)
        for c in shown:
            r = risk.get(c['id'], {})
            decides = e.get('proposed') or (label == 'confirmed' and is_primary(c))
            if r.get('tier') != 'high' and not decides:
                continue
            picked[c['id']] = {
                'claim_id': c['id'], 'text': c['text'], 'kinds': c.get('kinds') or [], 'risk_score': r.get('score', 0),
                'event_id': e['id'], 'event_title': e.get('title'), 'event_date': e.get('date'), 'side': e.get('side'),
                # What a reader is told about it: the label its story carries.
                'asserted_status': 'proposed' if e.get('proposed') else 'official' if is_primary(c) else 'reported',
            }
    ranked = sorted(picked.values(), key=lambda t: (-t['risk_score'], t['asserted_status'] != 'official', t['claim_id']))
    return ranked[:limit], max(0, len(ranked) - limit)


def cmd_verify_select(a):
    targets, left = verification_targets(Path(a.run), a.max)
    print(json.dumps({'claims': targets, 'not_selected': left}, ensure_ascii=False))
    return 0


def cmd_search(a):
    """Log a search (query + what it turned up) so discovery breadth is on record."""
    data = load(Path(a.run) / 'events.json')
    if data is None:
        print('events.json missing: run init first'); return 1
    data.setdefault('searches', []).append(a.query + (f' → {a.found}' if a.found else ''))
    save(Path(a.run) / 'events.json', data)
    print(f'search {len(data["searches"])} logged')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
