#!/usr/bin/env python3
"""Check one research task's records before its results are handed to the parent agent.

  python3 scripts/check_handoff.py TASK_RUN --role scout|lead|cross_border|chief [--json]

TASK_RUN is a brief.py run directory with assignment.json (written by the workflow controller) and, except for the
chief, narrative.md. Findings use the validator's PASS / FAIL / UNVERIFIED semantics: any FAIL means the handoff is
refused and the agent must fix its records; UNVERIFIED items travel with the handoff for the parent to judge.

The check is mechanical. A quote found in a saved page shows the page says it, not that the claim is right or
material, and a clean handoff is not a reviewed one.
"""
import argparse
from datetime import date, datetime
import json
from pathlib import Path
import re
import sys

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
import brief  # noqa: E402
import evidence_tools as ev  # noqa: E402
from check_evidence import KINDS  # noqa: E402
from qa_common import finding, outcome  # noqa: E402

ROLES = ('scout', 'lead', 'cross_border', 'chief')
MIN_NARRATIVE = 80
# Record IDs mean nothing to a reader; the renderer prints tracked events' titles and reasons as they are.
INTERNAL_ID = re.compile(r'\b[ACES]\d{3,}\b')
# Legal state: a proposal must not be written up as law. Negated or future forms ("not yet in force",
# "would take effect") are not claims of enactment.
ENACTED = re.compile(r'\b(enacted|took effect|takes effect|has taken effect|came into (?:force|effect)|(?:is|are|now) in (?:force|effect)|'
                     r'finali[sz]ed|issued a final rule|adopted the (?:rule|regulation|law))\b', re.I)
NOT_ENACTED = re.compile(r'\b(not|yet|would|will|could|may|expected to|proposed to|before it)\b[^.;]{0,25}$', re.I)
PROPOSAL = re.compile(r'propos|draft|would (?:require|impose|restrict|ban|add)|comments? (?:are|is) due|comment period|consultation|'
                      r'征求意见|草案|拟', re.I)


def says_enacted(text):
    return any(not NOT_ENACTED.search(text[:m.start()]) for m in ENACTED.finditer(text or ''))


def load(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except FileNotFoundError:
        return default
    except json.JSONDecodeError as e:
        return {'_invalid': str(e)}


def check(run, role):
    run = Path(run)
    items = []
    add = lambda status, code, message, **kw: items.append(finding(status, code, message, **kw))
    for name in ('run_config.json', 'events.json', 'evidence_ledger.json', 'sources.json'):
        doc = load(run / name)
        if doc is None:
            add('FAIL', 'RECORD_MISSING', f'{name} missing: initialise the task run with brief.py init', field=name)
        elif '_invalid' in doc:
            add('FAIL', 'RECORD_INVALID', f'{name} is not valid JSON: {doc["_invalid"]}', field=name)
    if any(x['status'] == 'FAIL' for x in items):
        return items
    cfg = load(run / 'run_config.json')
    assignment = load(run / 'assignment.json')
    if assignment is None or '_invalid' in assignment:
        add('FAIL', 'ASSIGNMENT_MISSING', 'assignment.json missing or invalid: this directory was not issued by the workflow')
    else:
        if assignment.get('window') != cfg.get('window'):
            add('FAIL', 'WINDOW_MISMATCH', f'run window {cfg.get("window")} differs from the assigned window {assignment.get("window")}')
        if assignment.get('cutoff') and assignment.get('cutoff') != cfg.get('cutoff'):
            add('FAIL', 'CUTOFF_MISMATCH', f'run cutoff {cfg.get("cutoff")} differs from the assigned cutoff {assignment.get("cutoff")}')
        if assignment.get('report_date') and assignment.get('report_date') != cfg.get('report_date'):
            add('FAIL', 'REPORT_DATE_MISMATCH', f'run_config.json report date {cfg.get("report_date")} differs from the assigned '
                f'{assignment.get("report_date")}; the run\'s dates are set by the workflow, not edited')
        if cfg.get('language', 'zh') != 'en':
            add('FAIL', 'LANGUAGE', 'the multi-agent briefing is written in English: initialise with brief.py init … --lang en')

    events, ledger, claims, risk, sources = brief.snapshot_state(run)
    evs = events['events']
    # The ledger's header must stay what init wrote: the validator's date checks read it.
    changed = [k for k in ('report_date', 'timezone', 'cutoff') if ledger.get(k) != cfg.get(k)]
    if changed:
        add('FAIL', 'LEDGER_HEADER_MISMATCH', f'evidence_ledger.json {", ".join(changed)} differ from run_config.json; '
            'these are set when the run starts and are not edited')
    cutoff_day = None
    try:
        cutoff_day = datetime.fromisoformat(cfg['cutoff']).date()
    except (KeyError, TypeError, ValueError):
        add('FAIL', 'CUTOFF_MISSING', 'run_config.json has no valid cutoff')
    start = cfg.get('window', {}).get('start')

    for cid in ev.hand_edited(ledger):
        add('FAIL', 'CLAIM_EDITED_BY_HAND', f'{cid} was changed after add-claim; withdraw it and record the corrected claim with add-claim', claim=cid)
    for cid, r in risk.items():
        if r.get('quote_state') != 'FOUND':
            add('FAIL', 'QUOTE_NOT_FOUND', f'{cid}: quote not found in its saved snapshot ({r.get("quote_state")})', claim=cid)
    proposed_claims = {cid for e in evs if e.get('proposed') for cid in e.get('claim_ids') or []}
    for c in claims.values():
        if says_enacted(c.get('text')):
            quotes = ' '.join(src.get('quote') or '' for src in c.get('sources') or [])
            if c['id'] in proposed_claims:
                add('FAIL', 'STATUS_WORDING', f'{c["id"]}: its event is marked proposed, but the claim says it was enacted or took effect; '
                    'withdraw it and record what the source says', claim=c['id'])
            elif PROPOSAL.search(quotes) and not ENACTED.search(quotes):
                add('FAIL', 'STATUS_WORDING', f'{c["id"]}: the claim says enacted or in force, but its quote only shows a proposal or draft; '
                    'withdraw it and record what the source says, or quote the passage that shows enactment', claim=c['id'])
        bad = [k for k in c.get('kinds') or [] if k not in KINDS]
        if bad or not c.get('kinds'):
            add('FAIL', 'CLAIM_KINDS', f'{c["id"]}: kinds {bad or "missing"} are not accepted by the validator ({", ".join(sorted(KINDS))}); '
                'withdraw it and add it again with valid --kind values', claim=c['id'])

    for e in evs:
        eid = e['id']
        if not e.get('decision'):
            add('FAIL', 'EVENT_UNDECIDED', f'{eid} {e.get("title", "")[:50]}: decide include / track / exclude with a reason', event=eid)
            continue
        if not (e.get('reason') or '').strip():
            add('FAIL', 'EVENT_REASON_MISSING', f'{eid}: decision needs a one-line reason', event=eid)
        if e['decision'] in ('include', 'track'):
            if not e.get('side'):
                add('FAIL', 'EVENT_SIDE_MISSING', f'{eid}: add --side us|cn|both|other', event=eid)
            if not e.get('materiality'):
                add('FAIL', 'MATERIALITY_MISSING', f'{eid}: set --materiality high|medium|low', event=eid)
            missing = [k for k in ('link', 'size', 'new') if not ((e.get('assessment') or {}).get(k) or '').strip()]
            if missing:
                add('FAIL', 'ASSESSMENT_MISSING', f'{eid}: answer the selection questions with --{" --".join(missing)} (SKILL.md Step 3)', event=eid)
            if re.search(r'[一-鿿]', e.get('title') or ''):
                add('FAIL', 'TITLE_LANGUAGE', f'{eid}: give it a short English title (decide … --title "…")', event=eid)
        if e['decision'] == 'track':
            shown = f'{e.get("title") or ""} {e.get("reason") or ""}'
            if INTERNAL_ID.search(shown):
                add('FAIL' if role == 'chief' else 'UNVERIFIED', 'INTERNAL_ID_SHOWN',
                    f'{eid}: its title and reason are printed in the report status table, but mention {INTERNAL_ID.search(shown)[0]}; '
                    'describe the event instead of citing record IDs', event=eid)
        if e['decision'] == 'include' and e.get('evidence_status') == 'unresolved':
            add('FAIL', 'INCLUDED_WITHOUT_EVIDENCE', f'{eid}: included without a located quote; add-claim from a page you opened or decide it as track', event=eid)
        if e.get('merge_conflicts'):
            fields = ', '.join(sorted({c['field'] for c in e['merge_conflicts']}))
            add('FAIL', 'MERGE_CONFLICT', f'{eid}: merged reports disagree on {fields}; settle it with brief.py event decide', event=eid)
        d = e.get('date')
        if d and cutoff_day:
            try:
                day = date.fromisoformat(d)
                if day > cutoff_day:
                    add('FAIL', 'EVENT_AFTER_CUTOFF', f'{eid}: dated {d}, after the cutoff', event=eid)
                elif start and day < date.fromisoformat(start) and e['decision'] == 'include' and not e.get('case_id'):
                    add('UNVERIFIED', 'EVENT_BEFORE_WINDOW', f'{eid}: dated {d}, before the window; the "new" answer must say what changed in the window', event=eid)
            except ValueError:
                add('FAIL', 'EVENT_DATE_INVALID', f'{eid}: date {d!r} is not YYYY-MM-DD', event=eid)

    ids = {e['id'] for e in evs}
    for pair in events.get('possible_duplicates') or []:
        a, b = pair['events']
        if a not in ids or b not in ids:
            continue
        reasons = ' '.join((e.get('reason') or '') for e in evs if e['id'] in (a, b))
        if a not in reasons and b not in reasons:
            add('UNVERIFIED', 'POSSIBLE_DUPLICATE', f'{a} and {b} may be the same event: exclude one with reason "duplicate of …", '
                'or keep both if they are distinct (this note is only a warning)', events=[a, b])

    if role != 'chief':
        path = run / 'narrative.md'
        text = path.read_text(encoding='utf-8') if path.exists() else ''
        if len(text.strip()) < MIN_NARRATIVE:
            add('FAIL', 'NARRATIVE_MISSING', 'narrative.md missing or too short: explain what happened, why it matters and what to watch')
        for e in evs:
            if e.get('decision') == 'include' and e['id'] not in text:
                add('FAIL', 'NARRATIVE_EVENT_MISSING', f'narrative.md does not discuss {e["id"]} ("{e.get("title", "")[:40]}"); cite it by ID', event=e['id'])
    if role in ('lead', 'chief'):
        sides = {e.get('side') for e in evs if e.get('decision') in ('include', 'track')}
        if role == 'chief' and not ({'us', 'both'} & sides and {'cn', 'both'} & sides):
            add('UNVERIFIED', 'ONE_SIDED', 'the merged research has no included or tracked event on one side (US or China)')
    blocked = [s for s in sources.values() if s.get('access') != 'opened']
    for s in blocked:
        add('UNVERIFIED', 'SOURCE_NOT_OPENED', f'{s["id"]} {s.get("host", "")}: {s.get("access_note", "not opened")} (an access limit, not evidence of falsity)', source=s['id'])
    if not items or all(x['status'] == 'PASS' for x in items):
        add('PASS', 'HANDOFF_RECORDS', 'records are complete for this role')
    return items


def summary(run):
    events, ledger, claims, risk, sources = brief.snapshot_state(run)
    by = lambda d: [e['id'] for e in events['events'] if e.get('decision') == d]
    return {'events': len(events['events']), 'include': by('include'), 'track': by('track'), 'exclude': by('exclude'),
            'claims': len(claims), 'withdrawn': len(ledger.get('withdrawn') or []), 'sources': len(sources),
            'sources_not_opened': sum(1 for s in sources.values() if s.get('access') != 'opened'),
            'proposed': [e['id'] for e in events['events'] if e.get('proposed')],
            'high_materiality': [e['id'] for e in events['events'] if e.get('materiality') == 'high']}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('run'); ap.add_argument('--role', choices=ROLES, required=True); ap.add_argument('--json', action='store_true')
    a = ap.parse_args()
    items = check(a.run, a.role)
    result = {'outcome': outcome(items), 'findings': items}
    if not any(x['code'] in ('RECORD_MISSING', 'RECORD_INVALID') for x in items):
        result['summary'] = summary(a.run)
    if a.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(f"Handoff check ({a.role}): {result['outcome']}")
        for x in items:
            if x['status'] != 'PASS':
                print(f"  {x['status']:10} {x['code']}: {x['message']}")
    return {'PASS': 0, 'UNVERIFIED': 0, 'FAIL': 1}[result['outcome']]


if __name__ == '__main__':
    raise SystemExit(main())
