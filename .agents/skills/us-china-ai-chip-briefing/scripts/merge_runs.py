#!/usr/bin/env python3
"""Merge the run records of finished research tasks into a parent run, deterministically and without rewriting facts.

  python3 scripts/merge_runs.py TARGET_RUN --from TASK_ID=TASK_RUN [--from TASK_ID=TASK_RUN ...] [--json]

Each run is a brief.py run directory (run_config.json, sources.json + sources/, events.json, evidence_ledger.json).
The merge never edits a claim's text, quotes or source entries. It only:
  - copies source texts byte for byte under new IDs (same SHA-256) and points snapshots at the copies;
  - gives events and claims new IDs in the target and records where each came from (`provenance`);
  - joins duplicate events (same case, same URL, or near-identical title on the same side within three days),
    keeping the more cautious value of `proposed`, `unsupported` and materiality, and recording every other
    disagreement in `merge_conflicts` for the owner of the target run to decide (brief.py event decide clears them);
  - lists likely but unproven duplicates in events.json `possible_duplicates`;
  - carries withdrawals over, so a claim withdrawn in a task is withdrawn here too.

A task merged before is merged again incrementally: new records are added, changed event fields propagate unless the
target changed the same field since the last merge (then it is a conflict), and nothing already merged is duplicated.
merge_log.json in the target keeps the ID maps and the field values of the last merge.

The four target files are replaced together: they are written aside, a commit record names them, and only then are
they moved into place. A merge interrupted before the commit record leaves the target as it was; one interrupted
after it is completed by the next merge (or any later run of this script). A lock left by a process that no longer
exists is taken over.
"""
import argparse
from datetime import date, datetime, timezone
from difflib import SequenceMatcher
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import time

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
import evidence_tools as ev  # noqa: E402

EVENT_FIELDS = ('title', 'date', 'side', 'materiality', 'why_it_matters', 'decision', 'reason', 'followup', 'url',
                'proposed', 'unsupported', 'assessment', 'case_id')
RANK = {'high': 3, 'medium': 2, 'low': 1, '': 0, None: 0}
VISIBILITY = {'include': 3, 'track': 2, 'exclude': 1, None: 0}


class MergeError(Exception):
    pass


def load(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except FileNotFoundError:
        return default


def save(path, obj):
    tmp = Path(str(path) + '.tmp')
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    os.replace(tmp, path)


COMMIT = '.merge.commit.json'
STAGED = '.merge-staged'


def save_together(target, files):
    """Replace several files of the target as one step (see the module notes)."""
    target = Path(target)
    for name, obj in files.items():
        (target / f'{name}{STAGED}').write_text(json.dumps(obj, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    save(target / COMMIT, {'files': list(files)})
    fault('merge:committed')
    finish_commit(target)


def finish_commit(target):
    """Complete a committed merge, or discard one that never reached its commit record."""
    target = Path(target)
    record = load(target / COMMIT)
    if record:
        for name in record['files']:
            staged = target / f'{name}{STAGED}'
            if staged.exists():
                os.replace(staged, target / name)
        (target / COMMIT).unlink()
        return True
    for staged in target.glob(f'*{STAGED}'):
        staged.unlink()
    return False


def fault(point):
    """Tests stop the process here (MERGE_RUNS_FAULT=point) to check recovery."""
    if os.environ.get('MERGE_RUNS_FAULT') == point:
        os._exit(75)


def add_origin(record, origin):
    """Provenance is a set of origins: merging the same record twice does not list it twice."""
    record['provenance'] = list(record.get('provenance') or [])
    if origin not in record['provenance']:
        record['provenance'].append(origin)


def next_id(prefix, used):
    n = max([int(x[1:]) for x in used if x and x[0] == prefix and x[1:].isdigit()] or [0]) + 1
    return f'{prefix}{n:03d}'


def days_apart(a, b):
    try:
        return abs((date.fromisoformat(a) - date.fromisoformat(b)).days)
    except (TypeError, ValueError):
        return None


def same_event(a, b):
    """'same', 'possible' or None. Conservative: only clear signals join events; the rest is left to a person."""
    if a.get('case_id') and a.get('case_id') == b.get('case_id'):
        return 'same'
    if a.get('url') and a.get('url') == b.get('url'):
        return 'same'
    ratio = SequenceMatcher(None, (a.get('title') or '').lower(), (b.get('title') or '').lower()).ratio()
    gap = days_apart(a.get('date'), b.get('date'))
    if ratio > 0.85 and a.get('side') == b.get('side') and (gap is None or gap <= 3):
        return 'same'
    if ratio > 0.6 or (set(a.get('_urls') or ()) & set(b.get('_urls') or ())):
        return 'possible'
    return None


def pid_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class Lock:
    #: A lock file without a readable PID (a crash while writing it) is stale after this many seconds.
    UNREADABLE_STALE_AFTER = 60

    def __init__(self, run):
        self.path = Path(run) / '.merge.lock'

    def stale(self):
        try:
            pid = int(self.path.read_text().strip())
        except (FileNotFoundError, ValueError):
            try:
                return time.time() - self.path.stat().st_mtime > self.UNREADABLE_STALE_AFTER
            except FileNotFoundError:
                return True
        return pid != os.getpid() and not pid_alive(pid)

    def __enter__(self):
        for attempt in (1, 2):
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                break
            except FileExistsError:
                if attempt == 2 or not self.stale():
                    raise MergeError(f'{self.path} exists: another merge into this run is running')
                self.path.unlink(missing_ok=True)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        return self

    def __exit__(self, *exc):
        self.path.unlink(missing_ok=True)


def merge(target, task_id, source):
    target, source = Path(target), Path(source)
    for run in (target, source):
        for name in ('run_config.json', 'events.json', 'evidence_ledger.json', 'sources.json'):
            if not (run / name).exists():
                raise MergeError(f'{run / name} missing: both runs must be initialised with brief.py init')
    tcfg, scfg = load(target / 'run_config.json'), load(source / 'run_config.json')
    if tcfg['window'] != scfg['window'] or tcfg.get('cutoff') != scfg.get('cutoff'):
        raise MergeError(f'{task_id}: reporting window or cutoff differs from the target run; records from another period are never merged')

    log = load(target / 'merge_log.json', {'tasks': {}})
    entry = log['tasks'].setdefault(task_id, {'sources': {}, 'events': {}, 'claims': {}, 'event_base': {}})
    reg_t, reg_s = load(target / 'sources.json'), load(source / 'sources.json')
    evs_t, evs_s = load(target / 'events.json'), load(source / 'events.json')
    led_t, led_s = load(target / 'evidence_ledger.json'), load(source / 'evidence_ledger.json')
    out = {'task': task_id, 'added': {'sources': [], 'events': [], 'claims': []}, 'joined_events': [], 'possible_duplicates': [],
           'conflicts': [], 'withdrawn': [], 'hand_edited': []}

    # Sources: copy the saved text, never refetch. Same URL and same content is one source.
    (target / 'sources').mkdir(exist_ok=True)
    for s in reg_s['sources']:
        if s['id'] in entry['sources']:
            continue
        match = next((t for t in reg_t['sources'] if t['url'] == s['url'] and t.get('sha256') == s.get('sha256')), None)
        if match:
            entry['sources'][s['id']] = match['id']
            add_origin(match, {'task': task_id, 'id': s['id']})
            continue
        new = dict(s, id=next_id('S', [t['id'] for t in reg_t['sources']]))
        if s.get('file'):
            src_file = source / s['file']
            if s.get('sha256') and hashlib.sha256(src_file.read_bytes()).hexdigest() != s['sha256']:
                raise MergeError(f'{task_id}: {s["file"]} changed after it was registered; its claims cannot be trusted')
            new['file'] = f'sources/{new["id"]}.txt'
            shutil.copyfile(src_file, target / new['file'])
        new['provenance'] = list(s.get('provenance') or []) + [{'task': task_id, 'id': s['id']}]
        reg_t['sources'].append(new)
        entry['sources'][s['id']] = new['id']
        out['added']['sources'].append(new['id'])

    # Claims: same text in the target is the same proposition, so its sources are joined, as add-claim does.
    used = {c['id'] for c in led_t['claims']} | {w['claim']['id'] for w in led_t.get('withdrawn') or []}

    def map_claim(c):
        clean = c.get('recorded_sha') == ev.fingerprint(c)
        new = json.loads(json.dumps(c))
        for src in new.get('sources') or []:
            snap = src.get('snapshot') or {}
            old_path = snap.get('path') or ''
            sid = Path(old_path).stem
            if sid in entry['sources']:
                snap['path'] = f'sources/{entry["sources"][sid]}.txt'
                if str(src.get('anchor', '')).startswith(old_path):
                    src['anchor'] = snap['path'] + src['anchor'][len(old_path):]
        new['provenance'] = list(c.get('provenance') or []) + [{'task': task_id, 'id': c['id']}]
        new.pop('recorded_sha', None)
        return new, clean

    for c in led_s['claims']:
        if c['id'] in entry['claims']:
            continue
        new, clean = map_claim(c)
        if not clean:
            out['hand_edited'].append(c['id'])
        same = next((t for t in led_t['claims'] if t.get('text') == c.get('text')), None)
        # A target claim edited by hand before this merge must stay detectable after its sources are joined.
        target_clean = same is None or same.get('recorded_sha') == ev.fingerprint(same)
        if same:
            for src in new['sources']:
                if not any(x.get('url') == src.get('url') and x.get('quote') == src.get('quote') for x in same['sources']):
                    same['sources'].append(src)
            add_origin(same, new['provenance'][-1])
            target_claim = same
        else:
            new['id'] = next_id('C', used)
            used.add(new['id'])
            led_t['claims'].append(new)
            target_claim = new
            out['added']['claims'].append(new['id'])
        # Hand edits made before the merge stay detectable: the fingerprint is not renewed for an edited claim.
        target_claim['recorded_sha'] = ev.fingerprint(target_claim) if clean and target_clean else 'edited-before-merge'
        entry['claims'][c['id']] = target_claim['id']

    for w in led_s.get('withdrawn') or []:
        cid = w['claim']['id']
        reason = f'withdrawn in {task_id}: {w.get("reason", "")}'
        if cid in entry['claims']:
            tid = entry['claims'][cid]
            claim = next((t for t in led_t['claims'] if t['id'] == tid), None)
            if claim is None:
                continue
            others = [p for p in claim.get('provenance') or [] if p['task'] != task_id]
            if others:  # still asserted by another task: keep it, note the disagreement
                out['conflicts'].append({'claim': tid, 'field': 'withdrawn', 'note': reason})
                continue
            led_t['claims'] = [t for t in led_t['claims'] if t['id'] != tid]
            led_t.setdefault('withdrawn', []).append({'claim': claim, 'reason': reason, 'withdrawn_at': w.get('withdrawn_at')})
            for e in evs_t['events']:
                e['claim_ids'] = [x for x in e.get('claim_ids') or [] if x != tid]
            out['withdrawn'].append(tid)
        else:
            new, _ = map_claim(w['claim'])
            new['id'] = next_id('C', used)
            used.add(new['id'])
            led_t.setdefault('withdrawn', []).append({'claim': new, 'reason': reason, 'withdrawn_at': w.get('withdrawn_at')})
            entry['claims'][cid] = new['id']
            out['withdrawn'].append(new['id'])

    # Events.
    url_of = {s['id']: s['url'] for s in reg_t['sources']}
    for e in evs_t['events']:
        e['_urls'] = [url_of.get(x) for x in e.get('sources') or []]
    for e in evs_s['events']:
        mapped = dict(e, sources=[entry['sources'].get(x, x) for x in e.get('sources') or []],
                      claim_ids=[entry['claims'][x] for x in e.get('claim_ids') or [] if x in entry['claims']
                                 and any(c['id'] == entry['claims'][x] for c in led_t['claims'])])
        mapped['_urls'] = [url_of.get(x) for x in mapped['sources']]
        base = {k: mapped.get(k) for k in EVENT_FIELDS}
        if e['id'] in entry['events']:  # merged before: propagate what the task changed since then
            t = next((x for x in evs_t['events'] if x['id'] == entry['events'][e['id']]), None)
            if t is None:
                continue
            last = entry['event_base'].get(e['id'], {})
            for k in EVENT_FIELDS:
                if mapped.get(k) == last.get(k):
                    continue
                if t.get(k) == last.get(k):
                    t[k] = mapped.get(k)
                else:
                    t.setdefault('merge_conflicts', []).append({'field': k, 'kept': t.get(k), 'other': mapped.get(k), 'task': task_id})
                    out['conflicts'].append({'event': t['id'], 'field': k})
            _join_lists(t, mapped)
            entry['event_base'][e['id']] = base
            continue
        # Two events of the same task are the task's own decision, never joined here.
        kind_t = [(same_event(t, mapped), t) for t in evs_t['events'] if t['id'] not in out['added']['events']]
        twin = next((t for k, t in kind_t if k == 'same'), None)
        if twin:
            _join(twin, mapped, task_id, out)
            entry['events'][e['id']] = twin['id']
            out['joined_events'].append({'event': twin['id'], 'from': e['id']})
        else:
            new = dict(mapped, id=next_id('E', [t['id'] for t in evs_t['events']]))
            new['provenance'] = list(e.get('provenance') or []) + [{'task': task_id, 'id': e['id']}]
            new.pop('merge_conflicts', None)
            evs_t['events'].append(new)
            entry['events'][e['id']] = new['id']
            out['added']['events'].append(new['id'])
            for k, t in kind_t:
                if k == 'possible':
                    pair = {'events': [t['id'], new['id']], 'titles': [t.get('title'), new.get('title')]}
                    evs_t.setdefault('possible_duplicates', []).append(pair)
                    out['possible_duplicates'].append(pair)
        entry['event_base'][e['id']] = base
    for e in evs_t['events']:
        e.pop('_urls', None)

    known = set(evs_t.get('searches') or [])
    for q in evs_s.get('searches') or []:
        line = q if q.startswith('[') else f'[{task_id}] {q}'
        if line not in known:
            evs_t.setdefault('searches', []).append(line)
            known.add(line)

    entry['merged_at'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
    save_together(target, {'sources.json': reg_t, 'evidence_ledger.json': led_t, 'events.json': evs_t, 'merge_log.json': log})
    return out


def _join_lists(t, mapped):
    for key in ('sources', 'claim_ids'):
        for x in mapped.get(key) or []:
            if x not in t.setdefault(key, []):
                t[key].append(x)


def _join(t, m, task_id, out):
    """Join a duplicate event into an existing one. Cautious values win; other disagreements are recorded."""
    _join_lists(t, m)
    for origin in list(m.get('provenance') or []) + [{'task': task_id, 'id': m['id']}]:
        add_origin(t, origin)
    t['proposed'] = bool(t.get('proposed') or m.get('proposed'))
    t['unsupported'] = bool(t.get('unsupported') or m.get('unsupported'))
    if RANK.get(m.get('materiality'), 0) > RANK.get(t.get('materiality'), 0):
        t['materiality'] = m['materiality']
    if not t.get('case_id') and m.get('case_id'):
        t['case_id'] = m['case_id']
    if m.get('title') and m['title'] != t.get('title'):
        t.setdefault('aliases', [])
        if m['title'] not in t['aliases']:
            t['aliases'].append(m['title'])
    assessment = {**(m.get('assessment') or {}), **(t.get('assessment') or {})}
    if assessment:
        t['assessment'] = assessment
    for k in ('date', 'side', 'decision', 'why_it_matters', 'followup'):
        a, b = t.get(k), m.get(k)
        if not a and b:
            t[k] = b
        elif a and b and a != b:
            if k == 'decision' and VISIBILITY.get(b, 0) > VISIBILITY.get(a, 0):
                t[k], b = b, a  # keep the more visible decision until the owner decides
            if k == 'date' and b < a:
                t[k], b = b, a  # keep the earliest date
            t.setdefault('merge_conflicts', []).append({'field': k, 'kept': t[k], 'other': b, 'task': task_id})
            out['conflicts'].append({'event': t['id'], 'field': k})


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('target')
    ap.add_argument('--from', dest='sources', action='append', required=True, metavar='TASK_ID=RUN_DIR')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args()
    results = []
    try:
        with Lock(a.target):
            finish_commit(a.target)
            for spec in a.sources:
                task_id, sep, run = spec.partition('=')
                if not sep or not task_id or not run:
                    raise MergeError(f'--from needs TASK_ID=RUN_DIR, got {spec!r}')
                results.append(merge(a.target, task_id, run))
    except MergeError as e:
        print(json.dumps({'ok': False, 'error': str(e)}) if a.json else f'merge refused: {e}')
        return 1
    if a.json:
        print(json.dumps({'ok': True, 'results': results}, ensure_ascii=False))
    else:
        for r in results:
            print(f"{r['task']}: +{len(r['added']['sources'])} sources, +{len(r['added']['events'])} events, "
                  f"+{len(r['added']['claims'])} claims; joined {len(r['joined_events'])}; possible duplicates "
                  f"{len(r['possible_duplicates'])}; conflicts {len(r['conflicts'])}; withdrawn {len(r['withdrawn'])}"
                  + (f"; edited by hand before merge: {', '.join(r['hand_edited'])}" if r['hand_edited'] else ''))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
