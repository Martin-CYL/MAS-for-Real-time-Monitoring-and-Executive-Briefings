#!/usr/bin/env python3
"""Coverage sweep and case follow-up checks.

The biggest past failure was a major event that never made it into the report. No
check on the report text can see a missing story, so the writer records every
candidate event considered (included or excluded, with a reason) in coverage.json.
This script checks that the sweep exists, is broad enough, covers both the US and
China sides, follows every active case, and that included items map to ledger claims.
The excluded list is printed in the review report so a person can spot an omission
in under a minute.
"""
import argparse
from datetime import date
import json
from pathlib import Path
import re
from qa_common import finding, emit, exit_code

MIN_CANDIDATES = 8
MIN_OUTLETS = 3
DECISIONS = {'included', 'excluded', 'appendix', 'background'}


def active_case_ids(path):
    if not path or not Path(path).exists():
        return []
    ids = []
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        m = re.match(r'\|\s*(A\d{3,})\s*\|', line)
        if m:
            ids.append(m[1])
    return ids


def _date(s):
    try:
        return date.fromisoformat(s)
    except (TypeError, ValueError):
        return None


def validate_coverage(coverage, ledger=None, cases_path=None):
    items = []
    add = lambda st, code, msg, **kw: items.append(finding(st, code, msg, **kw))
    if not isinstance(coverage, dict):
        add('UNVERIFIED', 'COVERAGE_SWEEP_MISSING',
            'No coverage.json: nobody can tell which major events were considered and left out')
        return items
    window = coverage.get('window') or {}
    start, end = _date(window.get('start')), _date(window.get('end'))
    if not start or not end or start > end:
        add('FAIL', 'COVERAGE_SCHEMA', 'window.start / window.end must be valid ISO dates')
    outlets = coverage.get('outlets_searched')
    if not isinstance(outlets, list) or len({str(o).strip().lower() for o in outlets if str(o).strip()}) < MIN_OUTLETS:
        add('UNVERIFIED', 'COVERAGE_THIN', f'Fewer than {MIN_OUTLETS} distinct outlets/sources searched')
    cands = coverage.get('candidates')
    if not isinstance(cands, list):
        add('FAIL', 'COVERAGE_SCHEMA', 'candidates array required')
        return items
    if len(cands) < MIN_CANDIDATES:
        add('UNVERIFIED', 'COVERAGE_THIN', f'Only {len(cands)} candidate events recorded; list at least {MIN_CANDIDATES}, including ones you excluded')
    claim_ids = {c.get('id') for c in (ledger or {}).get('claims', []) if isinstance(c, dict)}
    sides, followed = set(), set()
    for i, c in enumerate(cands, 1):
        if not isinstance(c, dict) or not str(c.get('event', '')).strip():
            add('FAIL', 'COVERAGE_SCHEMA', f'candidate {i}: event text required'); continue
        label = str(c['event'])[:60]
        dec = c.get('decision')
        if dec not in DECISIONS:
            add('FAIL', 'COVERAGE_SCHEMA', f'{label}: decision must be one of {sorted(DECISIONS)}'); continue
        side = c.get('side')
        if side in ('us', 'cn', 'both'):
            sides |= {'us', 'cn'} if side == 'both' else {side}
        if c.get('case_id'):
            followed.add(c['case_id'])
        if dec != 'included' and not str(c.get('reason', '')).strip():
            add('UNVERIFIED', 'EXCLUSION_REASON', f'{label}: excluded without a reason')
        if dec == 'included':
            ids = c.get('claim_ids') or []
            if not ids:
                add('UNVERIFIED', 'COVERAGE_UNLINKED', f'{label}: included but no claim_ids')
            elif ledger is not None and set(ids) - claim_ids:
                add('FAIL', 'COVERAGE_UNKNOWN_CLAIM', f'{label}: claim_ids not in ledger: {sorted(set(ids) - claim_ids)}')
        d = _date(c.get('date'))
        if d and start and end and not start <= d <= end and dec == 'included' and not c.get('case_id'):
            add('UNVERIFIED', 'COVERAGE_OUT_OF_WINDOW', f'{label}: dated {d} outside window but included as new; label as background or case follow-up')
    for s in ('us', 'cn'):
        if s not in sides:
            add('UNVERIFIED', 'ONE_SIDED_SWEEP', f'No candidate tagged side="{s}"; check the {"US" if s == "us" else "China"} side')
    for cid in active_case_ids(cases_path):
        if cid not in followed:
            add('UNVERIFIED', 'CASE_NOT_FOLLOWED', f'Active case {cid} has no candidate entry with case_id; record its current status')
    if not any(x['status'] == 'FAIL' for x in items):
        add('PASS', 'COVERAGE_RECORDED', f'{len(cands)} candidates recorded; a person should still skim the excluded list')
    return items


def excluded_summary(coverage):
    if not isinstance(coverage, dict):
        return []
    return [c for c in coverage.get('candidates') or [] if isinstance(c, dict) and c.get('decision') != 'included']


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('coverage'); ap.add_argument('--ledger'); ap.add_argument('--cases')
    ap.add_argument('--json', dest='json_path')
    args = ap.parse_args()
    cov = json.loads(Path(args.coverage).read_text(encoding='utf-8'))
    led = json.loads(Path(args.ledger).read_text(encoding='utf-8')) if args.ledger else None
    items = validate_coverage(cov, led, args.cases)
    emit(items, args.json_path)
    return exit_code(items)


if __name__ == '__main__':
    raise SystemExit(main())
