#!/usr/bin/env python3
"""Replay evaluation: measure the briefing checks without a model call.

  replay_eval.py controls [--cases evaluation/replay-cases.json] [--output-dir DIR]
      Builds a clean synthetic report with brief.py, applies each case's change and runs the QA (validate.py).
      A negative control should be noticed, the positive control should not fail. Cases marked known_gap are
      expected to be missed today; once one is noticed the run fails until the case is updated, so the case file
      always says what the checks really catch. Reviewer-only cases are listed, not run.

  replay_eval.py runs RUN [RUN ...] [--baseline OLD.json] [--no-rebuild] [--output-dir DIR]
      Replays finished runs: QA of the recorded report, then a rebuild with the current brief.py and QA again, on
      a temporary copy (the run directory is never written). Also audits the status table: does each row's dot
      match its evidence text? With --baseline (an earlier scorecard) it lists what changed and exits 1 when a
      run got worse: a new FAIL code, a lower readiness or more mismatched rows.

Scorecards hold codes, counts and short row excerpts from the runs given. Keep them with the run data, out of Git.
Exit codes: 0 every expectation held / no regression, 1 otherwise, 2 bad input.
"""
import argparse
from collections import Counter
from contextlib import redirect_stdout
import hashlib
import html
import io
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile

SCRIPTS = Path(__file__).resolve().parent
SKILL = SCRIPTS.parent
sys.path.insert(0, str(SCRIPTS))
import brief  # noqa: E402
from validate import run_all  # noqa: E402

CASES = SKILL / 'evaluation' / 'replay-cases.json'
READINESS = ['BLOCKED', 'INCOMPLETE', 'READY_FOR_HUMAN_REVIEW', 'AWAITING_SIGNOFF', 'PASS']
SYNTHETIC_PAGE = 'The synthetic agency today issued the synthetic rule, effective March 5, 2026. It covers synthetic products.'
SYNTHETIC_CLOCK = '2026-03-11T00:00:00+00:00'


class CaseError(ValueError):
    pass


def _brief(*args):
    out, old = io.StringIO(), sys.argv
    sys.argv = ['brief.py', *map(str, args)]
    try:
        with redirect_stdout(out):
            code = brief.main()
    finally:
        sys.argv = old
    return code, out.getvalue()


def _json(path, obj=None):
    if obj is None:
        return json.loads(path.read_text(encoding='utf-8'))
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding='utf-8')


def build_base(root):
    """A clean English run built by brief.py: one opened official source, one included event, every active case
    tracked. Fictional content; the only URL is www.example.gov, which is never fetched."""
    root = Path(root)
    run = root / 'run'
    _brief('init', run, '--end', '2026-03-10', '--cutoff', '2026-03-10T18:00:00+08:00', '--lang', 'en')
    led = _json(run / 'evidence_ledger.json'); led['generated_at'] = '2026-03-10T19:00:00+08:00'; _json(run / 'evidence_ledger.json', led)
    page = root / 'page.txt'
    page.write_text(SYNTHETIC_PAGE, encoding='utf-8')
    _brief('fetch', run, 'https://www.example.gov/rule', '--file', page, '--route', 'http_tool')
    _brief('event', run, 'add', '--title', 'Synthetic rule issued', '--date', '2026-03-05', '--side', 'both', '--source', 'S001',
           '--materiality', 'high', '--why', 'Synthetic: changes the export-control comparison')
    eid = _json(run / 'events.json')['events'][-1]['id']
    for e in _json(run / 'events.json')['events']:
        if e['id'] != eid:
            _brief('event', run, 'decide', e['id'], 'track', '--reason', 'Synthetic: no update', '--side', 'us', '--title', 'Synthetic tracked item')
    _brief('event', run, 'decide', eid, 'include', '--reason', 'Synthetic: new rule this period')
    for q in ('q1', 'q2', 'open query'):
        _brief('search', run, q)
    code, out = _brief('add-claim', run, eid, 'S001', '--quote', 'The synthetic agency today issued the synthetic rule',
                       '--text', 'The synthetic agency issued the synthetic rule.')
    if code:
        raise CaseError(f'base run: add-claim failed: {out.strip()}')
    rep = _json(run / 'report.json')
    rep.update(thesis={'lead': 'Synthetic rule issued', 'emphasis': 'the export-control comparison needs an update'},
               deck='Synthetic summary.', management_view='Synthetic: follow-up text.',
               questions=['Question one?', 'Question two?', 'Question three?'],
               judgments=[{'title': f'Judgment {i}', 'text': f'Synthetic judgment note {i}.'} for i in (1, 2, 3)],
               stories=[{'event': eid, 'chapter': 'Policy', 'title': 'Synthetic rule', 'impact': 'Synthetic: impact assessment.',
                         'watch': 'March 20'}])
    _json(run / 'report.json', rep)
    _brief('build', run)
    if not (run / 'report.html').exists():
        raise CaseError('base run: brief.py build wrote no report.html')
    return run


ROW = re.compile(r'<tr\b.*?</tr>', re.S)
DOT = re.compile(r'<i class="dot (\w+)"></i>(.*?)</td>', re.S)


def status_rows(page):
    """(dot class, visible evidence text) for each status-table row that carries a dot."""
    rows = []
    for row in ROW.findall(page):
        m = DOT.search(row)
        if m:
            rows.append((m[1], ' '.join(html.unescape(re.sub(r'<[^>]+>', '', m[2])).split())))
    return rows


def expected_dot(text):
    """The dot brief.py gives a row with this evidence text, or None if the text is not brief.py wording."""
    for L in (brief.LABELS[lang] for lang in ('en', 'zh')):
        proposed = text.startswith(L['proposed'].strip())
        body = text[len(L['proposed'].strip()):].strip() if proposed else text
        status = next((k for k, v in L['evidence'].items() if body.startswith(v)), None)
        if status is None:
            continue
        if proposed:
            return brief.STATUS['pending'][0]
        if status in ('unresolved', 'unsupported') or L['verify_gap'] in body:
            return brief.STATUS['unverified'][0]
        return brief.STATUS['confirmed' if status == 'supported' else 'reported'][0]
    return None


def audit_rows(page):
    rows = status_rows(page)
    mismatched, unparsed = [], 0
    for i, (dot, text) in enumerate(rows):
        want = expected_dot(text)
        if want is None:
            unparsed += 1
        elif want != dot:
            mismatched.append({'row': i, 'dot': dot, 'expected': want, 'text': text[:60]})
    return {'rows': len(rows), 'unparsed': unparsed, 'mismatched': mismatched}


def mutate(page, mutation):
    op = mutation.get('op')
    if op == 'replace':
        if page.count(mutation['find']) != 1:
            raise CaseError(f'replace: {mutation["find"]!r} occurs {page.count(mutation["find"])} times, expected once')
        return page.replace(mutation['find'], mutation['replace'])
    if op == 'status_dot':
        rows = [m for m in ROW.finditer(page) if DOT.search(m[0])]
        if not 0 <= mutation['row'] < len(rows):
            raise CaseError(f'status_dot: row {mutation["row"]} not in the {len(rows)}-row status table')
        m = rows[mutation['row']]
        new = DOT.sub(lambda d: f'<i class="dot {mutation["to"]}"></i>{d[2]}</td>', m[0], count=1)
        if new == m[0]:
            raise CaseError(f'status_dot: row {mutation["row"]} already has dot {mutation["to"]}')
        return page[:m.start()] + new + page[m.end():]
    raise CaseError(f'unknown mutation op {op!r}')


def findings(result):
    allx = [x for xs in result['checks'].values() for x in xs]
    return {s: sorted({x['code'] for x in allx if x['status'] == s}) for s in ('FAIL', 'UNVERIFIED')}


def qa(run, clock=None):
    ledger = run / 'report_ledger.json' if (run / 'report_ledger.json').exists() else run / 'evidence_ledger.json'
    coverage = run / 'coverage.json'
    cfg = run / 'run_config.json'
    report_date = _json(cfg).get('report_date') if cfg.exists() else None
    result, _, _ = run_all(run / 'report.html', ledger if ledger.exists() else None, expected_date=report_date,
                           coverage_path=coverage if coverage.exists() else None, now=clock)
    return result


def load_cases(path):
    cases = _json(Path(path)).get('cases')
    if not isinstance(cases, list) or not cases:
        raise CaseError('case file has no cases')
    ids = [c.get('id') for c in cases]
    if len(set(ids)) != len(ids) or not all(ids):
        raise CaseError('every case needs a unique id')
    if sum(c.get('control') == 'positive' for c in cases) != 1:
        raise CaseError('exactly one positive control is needed: detection is measured against it')
    return cases


def run_controls(cases):
    """Scorecard for the controls. 'ok' is False wherever a case's expectation did not hold."""
    with tempfile.TemporaryDirectory() as tmp:
        base = build_base(tmp)
        clean_page = (base / 'report.html').read_text(encoding='utf-8')
        results = {}
        for case in cases:
            if case.get('detector') == 'reviewer':
                results[case['id']] = {'verdict': 'REVIEWER_ONLY', 'ok': True}
                continue
            page = clean_page
            for mutation in case.get('mutations') or []:
                page = mutate(page, mutation)
            run = Path(tmp) / f'case-{case["id"]}'
            shutil.copytree(base, run)
            (run / 'report.html').write_text(page, encoding='utf-8')
            results[case['id']] = {'findings': findings(qa(run, SYNTHETIC_CLOCK)), 'rows': audit_rows(page)}
    positive = next(c for c in cases if c.get('control') == 'positive')
    clean = results[positive['id']]['findings']
    for case in cases:
        r = results[case['id']]
        if r.get('verdict'):
            continue
        f = r['findings']
        if case is positive:
            r['verdict'] = 'CLEAN' if not f['FAIL'] else 'FALSE_ALARM'
            r['ok'] = r['verdict'] == 'CLEAN' and not r['rows']['mismatched']
            continue
        new = sorted(set(f['FAIL']) - set(clean['FAIL']) | set(f['UNVERIFIED']) - set(clean['UNVERIFIED']))
        wanted = (case.get('expect') or {}).get('codes')
        noticed = bool(set(wanted) & set(new)) if wanted else bool(new)
        r['new_codes'] = new
        if case.get('known_gap'):
            r['verdict'] = 'NOW_DETECTED' if noticed else 'KNOWN_GAP'
            r['ok'] = not noticed
        else:
            r['verdict'] = 'DETECTED' if noticed else 'MISSED'
            r['ok'] = noticed
    return results


def controls_summary(cases, results):
    run = [c for c in cases if c.get('control') == 'negative' and c.get('detector') != 'reviewer']
    v = Counter(results[c['id']]['verdict'] for c in cases)
    return {'negative_run': len(run), 'detected': v['DETECTED'] + v['NOW_DETECTED'], 'known_gaps': v['KNOWN_GAP'],
            'missed': v['MISSED'], 'reviewer_only': v['REVIEWER_ONLY'], 'false_alarm': v['FALSE_ALARM'],
            'ok': all(r['ok'] for r in results.values())}


def controls_markdown(cases, results, summary):
    lines = ['# Replay controls', '',
             f"Mechanical QA noticed {summary['detected']} of {summary['negative_run']} negative controls; "
             f"{summary['known_gaps']} are known gaps, {summary['reviewer_only']} are left to the reviewer. "
             'Synthetic report; no model or network call.', '',
             '| Case | Control | Verdict | New codes | Origin |', '|---|---|---|---|---|']
    for c in cases:
        r = results[c['id']]
        lines.append(f"| {c['id']} | {c.get('control')} | {r['verdict']}{'' if r['ok'] else ' ✗'} | "
                     f"{', '.join(r.get('new_codes') or []) or '—'} | {'; '.join(c.get('origin') or []) or '—'} |")
    gaps = [c for c in cases if results[c['id']]['verdict'] in ('KNOWN_GAP', 'NOW_DETECTED')]
    if gaps:
        lines += ['', '## Known gaps', ''] + [f"- **{c['id']}**: {c['problem']} {c['known_gap']}" for c in gaps]
    return '\n'.join(lines) + '\n'


def replay_run(path, rebuild=True):
    src = Path(path)
    if not (src / 'report.html').exists():
        raise CaseError(f'{src}: no report.html')
    entry = {'run': src.name}
    with tempfile.TemporaryDirectory() as tmp:
        run = Path(tmp) / src.name
        shutil.copytree(src, run, ignore=shutil.ignore_patterns('tasks'))
        page = (run / 'report.html').read_text(encoding='utf-8')
        entry['report_sha256'] = hashlib.sha256(page.encode('utf-8')).hexdigest()
        entry['recorded'] = score_report(run, page)
        if rebuild:
            (run / 'report.html').unlink()
            _, out = _brief('build', run)
            if (run / 'report.html').exists():
                entry['rebuilt'] = score_report(run, (run / 'report.html').read_text(encoding='utf-8'))
            else:
                last = (out.strip().splitlines() or ['no output'])[-1][:160]
                entry['rebuilt'] = {'error': f'brief.py build wrote no report ({last})'}
    return entry


def score_report(run, page):
    result = qa(run)
    return {'outcome': result['outcome'], 'readiness': result['readiness'], 'categories': result['categories'],
            'findings': findings(result), 'rows': audit_rows(page)}


def compare(old, new):
    """Per-run changes between two scorecards; 'regression' when a run got worse on the same stage."""
    before = {e['run']: e for e in old.get('runs', [])}
    changes = []
    for e in new['runs']:
        o = before.get(e['run'])
        if not o:
            continue
        for stage in ('recorded', 'rebuilt'):
            a, b = o.get(stage) or {}, e.get(stage) or {}
            if 'findings' not in a or 'findings' not in b:
                continue
            added = sorted(set(b['findings']['FAIL']) - set(a['findings']['FAIL']))
            removed = sorted(set(a['findings']['FAIL']) - set(b['findings']['FAIL']))
            lower = READINESS.index(b['readiness']) < READINESS.index(a['readiness'])
            more = len(b['rows']['mismatched']) > len(a['rows']['mismatched'])
            if added or removed or lower or more or a['readiness'] != b['readiness'] \
                    or len(a['rows']['mismatched']) != len(b['rows']['mismatched']):
                changes.append({'run': e['run'], 'stage': stage, 'new_fail': added, 'cleared_fail': removed,
                                'readiness': [a['readiness'], b['readiness']],
                                'mismatched_rows': [len(a['rows']['mismatched']), len(b['rows']['mismatched'])],
                                'regression': bool(added or lower or more)})
    return changes


def runs_markdown(card):
    lines = ['# Replay of finished runs', '', 'QA of each recorded report and of a rebuild with the current brief.py. '
             'No model or network call; the run directories were not written.', '',
             '| Run | Stage | Outcome | Readiness | FAIL codes | Status rows | Dot mismatches |', '|---|---|---|---|---|---:|---:|']
    for e in card['runs']:
        for stage in ('recorded', 'rebuilt'):
            s = e.get(stage)
            if not s:
                continue
            if 'error' in s:
                lines.append(f"| {e['run']} | {stage} | — | — | {s['error']} | — | — |")
                continue
            lines.append(f"| {e['run']} | {stage} | {s['outcome']} | {s['readiness']} | {', '.join(s['findings']['FAIL']) or '—'} | "
                         f"{s['rows']['rows']} | {len(s['rows']['mismatched'])} |")
    if card.get('changes') is not None:
        lines += ['', '## Changes since the baseline', '']
        lines += [f"- {c['run']} {c['stage']}: readiness {c['readiness'][0]} → {c['readiness'][1]}; dot mismatches "
                  f"{c['mismatched_rows'][0]} → {c['mismatched_rows'][1]}; new FAIL {', '.join(c['new_fail']) or 'none'}; "
                  f"cleared {', '.join(c['cleared_fail']) or 'none'}{' — REGRESSION' if c['regression'] else ''}"
                  for c in card['changes']] or ['- none']
    return '\n'.join(lines) + '\n'


def write(out_dir, name, card, markdown):
    if out_dir:
        out = Path(out_dir); out.mkdir(parents=True, exist_ok=True)
        (out / f'{name}.json').write_text(json.dumps(card, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        (out / f'{name}.md').write_text(markdown, encoding='utf-8')
    print(markdown, end='')


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('controls'); p.add_argument('--cases', default=str(CASES)); p.add_argument('--output-dir')
    p = sub.add_parser('runs'); p.add_argument('run', nargs='+'); p.add_argument('--baseline')
    p.add_argument('--no-rebuild', action='store_true'); p.add_argument('--output-dir')
    args = ap.parse_args(argv)
    try:
        if args.cmd == 'controls':
            cases = load_cases(args.cases)
            results = run_controls(cases)
            summary = controls_summary(cases, results)
            write(args.output_dir, 'replay-controls', {'schema': 1, 'summary': summary, 'cases': results},
                  controls_markdown(cases, results, summary))
            return 0 if summary['ok'] else 1
        card = {'schema': 1, 'runs': [replay_run(r, rebuild=not args.no_rebuild) for r in args.run]}
        if args.baseline:
            card['changes'] = compare(_json(Path(args.baseline)), card)
        write(args.output_dir, 'replay-runs', card, runs_markdown(card))
        return 1 if any(c['regression'] for c in card.get('changes') or []) else 0
    except (CaseError, OSError, ValueError, KeyError) as e:
        print(f'replay_eval: {type(e).__name__}: {e}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
