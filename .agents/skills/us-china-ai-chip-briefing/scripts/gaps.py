#!/usr/bin/env python3
"""Coverage gaps for the multi-agent gap round, and the check of what a lead says it did about them.

  brief.py gaps RUN [--lead us=TASK_DIR] [--lead cn=TASK_DIR] [--max 20] [--discovery-top 10]
  brief.py gap-check RUN/gap_report.json TASK_DIR --task TASK_ID

`gaps` reads the Chief Editor's merged records after both country leads have handed in and lists what the rules
below can see is missing. It prints one JSON line; the workflow controller saves it as RUN/gaps.json. The rules
are mechanical on purpose: the writer does not choose what to look for again, and nothing that needs judgment
("the report feels thin") is a gap here. That stays with the reviewer.

  case_unfollowed      an active case the plan gave a side has no event with a claim, research origin or reason
  side_empty           no new (non-case) event on one side
  single_source        a high-materiality shown event has no primary source (official, company, dataset)
  discovery_unhandled  a top or official discovery candidate whose pages are nowhere in the records
  declared             a lead's own gaps and open questions
  category_empty       a planned category with no event (only once events carry --category)

`gap-check` compares a lead's records after the gap round with the baseline the controller saved when it reopened
the lead (RUN/gap_report.json, `leads`) and says, per gap, whether the reported outcome holds:

  filled           the listed records exist, are new, and fit the gap's type
  filled_unconfirmed  reported filled, but the records do not show it
  searched_none    reported nothing found, with at least two searches logged since the reopening
  not_searched     reported nothing found without the searches to show it
  not_reached      reported as not reached (with a reason), or not reported at all
"""
from datetime import date
import json
from pathlib import Path
import re
import sys

SCRIPTS = Path(__file__).resolve().parent
SKILL = SCRIPTS.parent
sys.path.insert(0, str(SCRIPTS))

TYPES = ('case_unfollowed', 'side_empty', 'single_source', 'discovery_unhandled', 'declared', 'category_empty')
OUTCOMES = ('filled', 'searched_none', 'not_reached')
PRIMARY = {'official_document', 'company_statement', 'dataset'}
SIDES = ('us', 'cn')
MIN_SEARCHES = 2


def load(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def norm_url(url):
    """The same page under small spelling differences: scheme, www., trailing slash and fragment ignored."""
    u = (url or '').strip()
    if not u:
        return ''
    u = re.sub(r'#.*$', '', u)
    u = re.sub(r'^[a-z][a-z0-9+.-]*://', '', u, flags=re.I)
    host, _, rest = u.partition('/')
    host = re.sub(r'^www\.', '', host.lower())
    return f'{host}/{rest}'.rstrip('/')


def categories():
    doc = load(SKILL / 'references' / 'roles' / 'categories.json', {}) or {}
    return {c['id'] for c in doc.get('categories') or [] if c.get('id')}


def case_meta():
    """Active cases by ID, read from the same table brief.py init uses (references/active_cases.md)."""
    rows = {}
    path = SKILL / 'references' / 'active_cases.md'
    for line in (path.read_text(encoding='utf-8').splitlines() if path.exists() else []):
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if cells and re.fullmatch(r'A\d{3,}', cells[0]) and len(cells) >= 4:
            rows[cells[0]] = {'id': cells[0], 'question': cells[1], 'last_known': cells[2], 'next_check': cells[3]}
    return rows


def in_window(text, window):
    """True when the case's "Next check" names a date inside the reporting window."""
    try:
        start, end = date.fromisoformat(window['start']), date.fromisoformat(window['end'])
    except (KeyError, TypeError, ValueError):
        return False
    for m in re.findall(r'\d{4}-\d{2}-\d{2}', text or ''):
        try:
            if start <= date.fromisoformat(m) <= end:
                return True
        except ValueError:
            continue
    return False


def record_urls(run):
    """Every page URL the records know of: registered sources, event URLs and claim sources."""
    run = Path(run)
    urls = {norm_url(s.get('url')) for s in (load(run / 'sources.json', {}) or {}).get('sources') or []}
    urls |= {norm_url(e.get('url')) for e in (load(run / 'events.json', {}) or {}).get('events') or []}
    for c in (load(run / 'evidence_ledger.json', {}) or {}).get('claims') or []:
        urls |= {norm_url(s.get('url')) for s in c.get('sources') or [] if isinstance(s, dict)}
    urls.discard('')
    return urls


def sides_of(side):
    return SIDES if side == 'both' else (side,)


def has_primary(event, claims):
    return any(s.get('evidence_type') in PRIMARY for cid in event.get('claim_ids') or [] if cid in claims
               for s in claims[cid].get('sources') or [] if isinstance(s, dict))


def compute(run, leads=None, max_listed=20, discovery_top=10):
    run = Path(run)
    leads = leads or {}
    plan = load(run / 'plan.json', {}) or {}
    countries = plan.get('countries') or {}
    window = (load(run / 'run_config.json', {}) or {}).get('window') or {}
    events = (load(run / 'events.json', {}) or {}).get('events') or []
    claims = {c['id']: c for c in (load(run / 'evidence_ledger.json', {}) or {}).get('claims') or [] if c.get('id')}
    meta = case_meta()
    gaps, skipped = [], []

    def add(kind, side, priority, target, why, suggested='any'):
        gaps.append({'type': kind, 'side': side, 'priority': priority, 'target': target, 'why': why, 'suggested_source': suggested})

    for side in SIDES:
        for case in (countries.get(side) or {}).get('cases') or []:
            evs = [e for e in events if e.get('case_id') == case]
            followed = any(e.get('claim_ids') or e.get('provenance') or (e.get('decision') and (e.get('reason') or '').strip())
                           for e in evs)
            if followed:
                continue
            next_check = (meta.get(case) or {}).get('next_check', '')
            due = in_window(next_check, window)
            add('case_unfollowed', side, 6 if due else 5, {'case_id': case, 'question': (meta.get(case) or {}).get('question', '')},
                f'{case} was assigned to the {side.upper()} side; no event for it has a claim, a research origin or a recorded reason'
                + (f' (its next check, "{next_check}", falls in this window)' if due else ''), 'official_document')

    new_sides = {s for e in events if not e.get('case_id') and e.get('decision') != 'exclude' for s in sides_of(e.get('side'))}
    for side in SIDES:
        if side not in new_sides:
            add('side_empty', side, 5, {'side': side}, f'no new {side.upper()}-side event is recorded in the window',
                'official_document' if side == 'us' else 'chinese_language')

    for e in events:
        if e.get('decision') not in ('include', 'track') or e.get('materiality') != 'high' or has_primary(e, claims):
            continue
        add('single_source', e.get('side') or 'other', 4,
            {'event_id': e['id'], 'title': e.get('title', ''), 'origin': [p for p in e.get('provenance') or [] if isinstance(p, dict)]},
            f'{e["id"]} is a high-materiality {e["decision"]} event with no official, company or dataset source', 'official_document')

    discovery = load(run / 'discovery' / 'events.json', {}) or {}
    known = record_urls(run)
    for rank, cand in enumerate(discovery.get('candidates') or []):
        official = bool((cand.get('relevance') or {}).get('official_source'))
        if rank >= discovery_top and not official:
            continue
        raw = [i.get('url') for i in cand.get('items') or [] if isinstance(i, dict) and i.get('url')]
        urls = {norm_url(u) for u in raw} - {''}
        if not urls or urls & known:
            continue
        add('discovery_unhandled', cand.get('side') or 'other', 4 if official else 3,
            {'candidate_id': cand.get('id'), 'title': cand.get('title', ''), 'urls': raw[:5]},
            f'discovery candidate {cand.get("id")} ({"official source" if official else f"rank {rank + 1}"}) is not in the records '
            'and no event excludes it', 'official_document' if official else 'any')

    for side, lead_dir in sorted(leads.items()):
        out = load(Path(lead_dir) / 'output.json', {}) or {}
        for g in out.get('gaps') or []:
            if not isinstance(g, dict) or not (g.get('reason') or '').strip():
                continue
            add('declared', side, 3, {'topic': g.get('topic') or g.get('task_id') or '', 'task_id': g.get('task_id') or ''},
                f'the {side.upper()} lead reported a gap: {g["reason"].strip()}')
        for q in out.get('open_questions') or []:
            if isinstance(q, str) and q.strip():
                add('declared', side, 3, {'question': q.strip()}, f'the {side.upper()} lead left a question open: {q.strip()}')

    if not any(e.get('category') for e in events):
        skipped.append('category_empty')
    else:
        for side in SIDES:
            for cat in (countries.get(side) or {}).get('categories') or []:
                if not any(e.get('category') == cat and side in sides_of(e.get('side')) and e.get('decision') != 'exclude' for e in events):
                    add('category_empty', side, 2, {'category': cat}, f'the plan gave the {side.upper()} side "{cat}", and no event has it')

    gaps.sort(key=lambda g: (-g['priority'], TYPES.index(g['type']), g['side'], json.dumps(g['target'], sort_keys=True)))
    for i, g in enumerate(gaps, 1):
        g['gap_id'] = f'G{i:03d}'
    counts = {t: sum(g['type'] == t for g in gaps) for t in TYPES if any(g['type'] == t for g in gaps)}
    listed = gaps[:max_listed]
    return {'gaps': [{'gap_id': g.pop('gap_id'), **g} for g in listed], 'not_listed': len(gaps) - len(listed),
            'skipped_types': skipped, 'counts': counts}


# ------------------------------------------------------------------ gap-check
def _task_records(task_dir):
    d = Path(task_dir)
    events = load(d / 'events.json', {}) or {}
    ledger = load(d / 'evidence_ledger.json', {}) or {}
    sources = {s['id']: s for s in (load(d / 'sources.json', {}) or {}).get('sources') or [] if s.get('id')}
    return ({e['id']: e for e in events.get('events') or [] if e.get('id')},
            {c['id']: c for c in ledger.get('claims') or [] if c.get('id')}, sources, events.get('searches') or [])


def _event_urls(event, claims, sources):
    urls = {norm_url(event.get('url'))} | {norm_url((sources.get(s) or {}).get('url')) for s in event.get('sources') or []}
    for cid in event.get('claim_ids') or []:
        urls |= {norm_url(s.get('url')) for s in (claims.get(cid) or {}).get('sources') or [] if isinstance(s, dict)}
    urls.discard('')
    return urls


def filled_holds(gap, result, task_id, events, claims, sources, baseline):
    """Whether the records a lead lists for a gap show it filled. (True, '') or (False, why not)."""
    old_events, old_claims = set(baseline.get('events') or []), set(baseline.get('claims') or [])
    listed_events = [x for x in result.get('event_ids') or [] if isinstance(x, str)]
    listed_claims = [x for x in result.get('claim_ids') or [] if isinstance(x, str)]
    missing = [x for x in listed_events if x not in events] + [x for x in listed_claims if x not in claims]
    if missing:
        return False, f'not in the lead\'s records: {", ".join(missing)}'
    new_events = [events[x] for x in listed_events if x not in old_events]
    new_claims = [x for x in listed_claims if x not in old_claims]
    # A claim added to an older event counts as new work on that event.
    touched = new_events + [e for x in listed_events if x in old_events and (e := events[x])
                            and set(e.get('claim_ids') or []) - old_claims]
    if not new_events and not new_claims and not touched:
        return False, 'none of the listed events or claims is new since the gap round started'
    t, target = gap['type'], gap.get('target') or {}
    listed = [events[x] for x in listed_events]
    if t == 'case_unfollowed':
        ok = any(e.get('case_id') == target.get('case_id') and (e.get('claim_ids') or (e.get('decision') and (e.get('reason') or '').strip()))
                 for e in listed)
        return (True, '') if ok else (False, f'no listed event carries case {target.get("case_id")} with a claim or a decision')
    if t == 'side_empty':
        ok = any(not e.get('case_id') and target.get('side') in sides_of(e.get('side')) for e in new_events)
        return (True, '') if ok else (False, f'no new {str(target.get("side", "")).upper()}-side event is listed')
    if t == 'single_source':
        local = [p.get('id') for p in target.get('origin') or [] if p.get('task') == task_id]
        candidates = [events[x] for x in local if x in events] + listed
        ok = any(cid not in old_claims and any(s.get('evidence_type') in PRIMARY for s in (claims.get(cid) or {}).get('sources') or []
                                               if isinstance(s, dict))
                 for e in candidates for cid in e.get('claim_ids') or [])
        return (True, '') if ok else (False, 'no new claim from an official, company or dataset source on the event')
    if t == 'discovery_unhandled':
        wanted = {norm_url(u) for u in target.get('urls') or []} - {''}
        ok = any(_event_urls(e, claims, sources) & wanted for e in listed)
        return (True, '') if ok else (False, f'no listed event uses a page of candidate {target.get("candidate_id")}')
    if t == 'category_empty':
        ok = any(e.get('category') == target.get('category') for e in new_events)
        return (True, '') if ok else (False, f'no new event has category {target.get("category")}')
    return True, ''


def check_round(round_file, task_dir, task_id):
    rnd = load(round_file, {}) or {}
    entry = (rnd.get('leads') or {}).get(task_id) or {}
    gaps = {g['gap_id']: g for g in rnd.get('gaps') or []}
    out = load(Path(task_dir) / 'output.json', {}) or {}
    reported = {r.get('gap_id'): r for r in out.get('gap_results') or [] if isinstance(r, dict)}
    events, claims, sources, searches = _task_records(task_dir)
    baseline = entry.get('baseline') or {}
    new_searches = max(0, len(searches) - int(baseline.get('searches') or 0))
    results = {}
    for gid in entry.get('gaps') or []:
        gap, r = gaps.get(gid), reported.get(gid)
        if gap is None:
            continue
        if r is None:
            results[gid] = {'outcome': 'not_reached', 'detail': 'the lead did not report this gap'}
        elif r.get('outcome') == 'filled':
            ok, why = filled_holds(gap, r, task_id, events, claims, sources, baseline)
            results[gid] = {'outcome': 'filled' if ok else 'filled_unconfirmed', 'detail': why or 'records show it',
                            'event_ids': r.get('event_ids') or [], 'claim_ids': r.get('claim_ids') or []}
        elif r.get('outcome') == 'searched_none':
            searched = [s for s in r.get('searched') or [] if isinstance(s, str) and s.strip()]
            ok = new_searches >= MIN_SEARCHES and len(searched) >= MIN_SEARCHES
            results[gid] = {'outcome': 'searched_none' if ok else 'not_searched', 'searched': searched, 'note': r.get('note', ''),
                            'detail': f'{new_searches} search(es) logged since the reopening' if ok
                            else f'needs at least {MIN_SEARCHES} logged searches (brief.py search) and {MIN_SEARCHES} entries in "searched"; '
                                 f'found {new_searches} logged and {len(searched)} listed'}
        else:
            results[gid] = {'outcome': 'not_reached', 'detail': (r.get('reason') or '').strip() or 'no reason given'}
    return {'task': task_id, 'results': results, 'new_searches': new_searches}


def result_problems(gap_results):
    """Format problems in a lead's `gap_results`, as check_handoff reports them."""
    problems = []
    seen = set()
    for i, r in enumerate(gap_results if isinstance(gap_results, list) else [None]):
        where = f'gap_results[{i}]'
        if not isinstance(r, dict) or not re.fullmatch(r'G\d{3,}', str(r.get('gap_id') or '')):
            problems.append(f'{where}: needs "gap_id" like G001')
            continue
        gid = r['gap_id']
        if gid in seen:
            problems.append(f'{gid}: reported twice')
        seen.add(gid)
        outcome = r.get('outcome')
        if outcome not in OUTCOMES:
            problems.append(f'{gid}: outcome must be one of {", ".join(OUTCOMES)}')
        elif outcome == 'filled' and not (r.get('event_ids') or r.get('claim_ids')):
            problems.append(f'{gid}: a filled gap names the event_ids or claim_ids that fill it')
        elif outcome == 'searched_none' and len([s for s in r.get('searched') or [] if isinstance(s, str) and s.strip()]) < MIN_SEARCHES:
            problems.append(f'{gid}: searched_none lists at least {MIN_SEARCHES} searches in "searched" (and logs them with brief.py search)')
        elif outcome == 'not_reached' and not (r.get('reason') or '').strip():
            problems.append(f'{gid}: not_reached needs a reason')
    return problems


def cmd_gaps(a):
    leads = {}
    for spec in a.lead or []:
        side, _, path = spec.partition('=')
        if side not in SIDES or not path:
            print(f'--lead takes us=DIR or cn=DIR, not {spec!r}', file=sys.stderr)
            return 2
        leads[side] = path
    print(json.dumps(compute(a.run, leads, a.max, a.discovery_top), ensure_ascii=False))
    return 0


def cmd_gap_check(a):
    print(json.dumps(check_round(a.round, a.task_dir, a.task), ensure_ascii=False))
    return 0
