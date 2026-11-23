#!/usr/bin/env python3
"""Check that accepted research handoffs reached the final run intact.

  python3 scripts/check_provenance.py RUN_ROOT [--json]

RUN_ROOT holds workflow.json, written by the multi-agent workflow controller. Each accepted task lists its run
directory, the task it was merged into (`mergeInto`, or `merge_into`) and the SHA-256 of its record files at acceptance. For every
accepted task this checks that:
  - its records were not changed after acceptance;
  - it was merged into its parent run;
  - every claim (and withdrawn claim) reached the parent with the same text, URLs and quotes, under its provenance;
  - every event reached the parent, and `proposed` / `unsupported` were not dropped on the way.
Lowered materiality and changed decisions are reported for a person (UNVERIFIED): a lead may legitimately reassess,
but the change must be visible. Merges chain (scout → lead → chief), so each hop is checked against the next.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
from qa_common import finding, outcome  # noqa: E402

RANK = {'high': 3, 'medium': 2, 'low': 1}


def load(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except FileNotFoundError:
        return default


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def all_claims(ledger):
    """(claim, withdrawn?) for every claim the run has ever recorded."""
    return [(c, False) for c in ledger.get('claims') or []] + [(w['claim'], True) for w in ledger.get('withdrawn') or []]


def find_by_provenance(items, task, oid):
    return next((x for x in items if any(p.get('task') == task and p.get('id') == oid for p in x.get('provenance') or [])), None)


def check(root):
    root = Path(root)
    items = []
    add = lambda status, code, message, **kw: items.append(finding(status, code, message, **kw))
    wf = load(root / 'workflow.json')
    if wf is None:
        return [finding('FAIL', 'WORKFLOW_MISSING', f'{root / "workflow.json"} missing')]
    tasks = {t['id']: t for t in wf.get('tasks') or []}
    accepted = [t for t in tasks.values() if t.get('accepted')]
    counts = {'tasks': len(accepted), 'claims': 0, 'events': 0}
    for t in accepted:
        run = root / t['dir']
        changed = [rel for rel, digest in (t['accepted'].get('hashes') or {}).items()
                   if not (run / rel).exists() or sha(run / rel) != digest]
        if changed:
            add('FAIL', 'TASK_RECORD_CHANGED', f'{t["id"]}: {", ".join(changed[:5])} changed after the handoff was accepted', task=t['id'])
        target_id = t.get('merge_into') or t.get('mergeInto')
        if not target_id:
            continue
        target = tasks.get(target_id)
        if target is None:
            add('FAIL', 'MERGE_TARGET_UNKNOWN', f'{t["id"]}: merge target {target_id} is not a task of this run', task=t['id'])
            continue
        trun = root / target['dir']
        if t['id'] not in (load(trun / 'merge_log.json', {'tasks': {}})['tasks']):
            add('FAIL', 'NOT_MERGED', f'{t["id"]}: accepted but never merged into {target_id}; its evidence is missing upstream', task=t['id'])
            continue
        src_led, dst_led = load(run / 'evidence_ledger.json', {}), load(trun / 'evidence_ledger.json', {})
        dst_claims = all_claims(dst_led)
        for c, withdrawn in all_claims(src_led):
            counts['claims'] += 1
            match = next(((d, w) for d, w in dst_claims if any(p.get('task') == t['id'] and p.get('id') == c['id']
                                                                for p in d.get('provenance') or [])), None)
            if match is None:
                add('FAIL', 'CLAIM_LOST', f'{t["id"]} {c["id"]} is in neither the claims nor the withdrawn list of {target_id}',
                    task=t['id'], claim=c['id'])
                continue
            d, d_withdrawn = match
            if d.get('text') != c.get('text'):
                add('FAIL', 'CLAIM_ALTERED', f'{t["id"]} {c["id"]} → {target_id} {d["id"]}: claim text changed on the way up',
                    task=t['id'], claim=d['id'])
            pairs = {(s.get('url'), s.get('quote')) for s in d.get('sources') or []}
            lost = [s.get('url') for s in c.get('sources') or [] if (s.get('url'), s.get('quote')) not in pairs]
            if lost:
                add('FAIL', 'CLAIM_SOURCE_LOST', f'{t["id"]} {c["id"]} → {target_id} {d["id"]}: source or quote missing upstream ({lost[0]})',
                    task=t['id'], claim=d['id'])
            if withdrawn and not d_withdrawn:
                add('FAIL', 'WITHDRAWAL_LOST', f'{t["id"]} withdrew {c["id"]}, but {target_id} {d["id"]} still uses it', task=t['id'], claim=d['id'])
            if d_withdrawn and not withdrawn:
                add('UNVERIFIED', 'CLAIM_WITHDRAWN_UPSTREAM', f'{target_id} withdrew {d["id"]} (from {t["id"]} {c["id"]}); check the reason in its ledger',
                    task=t['id'], claim=d['id'])
        dst_events = load(trun / 'events.json', {}).get('events') or []
        for e in load(run / 'events.json', {}).get('events') or []:
            counts['events'] += 1
            d = find_by_provenance(dst_events, t['id'], e['id'])
            if d is None:
                add('FAIL', 'EVENT_LOST', f'{t["id"]} {e["id"]} "{e.get("title", "")[:50]}" is missing from {target_id}', task=t['id'], event=e['id'])
                continue
            for flag in ('proposed', 'unsupported'):
                if e.get(flag) and not d.get(flag):
                    add('FAIL', 'STATUS_UPGRADED', f'{t["id"]} {e["id"]} is marked {flag}, but {target_id} {d["id"]} is not', task=t['id'], event=d['id'])
            if RANK.get(e.get('materiality'), 0) > RANK.get(d.get('materiality'), 0):
                add('UNVERIFIED', 'MATERIALITY_LOWERED', f'{t["id"]} {e["id"]} rated {e.get("materiality")}, {target_id} {d["id"]} rates it '
                    f'{d.get("materiality") or "unrated"}', task=t['id'], event=d['id'])
            if e.get('decision') == 'include' and d.get('decision') == 'exclude':
                add('UNVERIFIED', 'DECISION_CHANGED', f'{t["id"]} included {e["id"]}; {target_id} excluded {d["id"]}: {d.get("reason", "")}',
                    task=t['id'], event=d['id'])
    if not [x for x in items if x['status'] != 'PASS']:
        add('PASS', 'PROVENANCE', f'{counts["tasks"]} accepted handoffs, {counts["claims"]} claims and {counts["events"]} events traced upstream')
    return items


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('root'); ap.add_argument('--json', action='store_true')
    a = ap.parse_args()
    items = check(a.root)
    if a.json:
        print(json.dumps({'outcome': outcome(items), 'findings': items}, ensure_ascii=False))
    else:
        print(f'Provenance: {outcome(items)}')
        for x in items:
            print(f"  {x['status']:10} {x['code']}: {x['message']}")
    return {'PASS': 0, 'UNVERIFIED': 2, 'FAIL': 1}[outcome(items)]


if __name__ == '__main__':
    raise SystemExit(main())
