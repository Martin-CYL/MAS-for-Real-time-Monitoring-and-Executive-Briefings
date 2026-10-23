"""Reliability of the multi-agent records: issue dates apart from the coverage window, claim-level evidence labels,
and merges that survive a crash or a stale lock.

Synthetic .invalid / example sources and fictitious content only. Nothing here fetches a page.
"""
from datetime import date, datetime, timedelta
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from zoneinfo import ZoneInfo

from test_multi_agent import RULE, REPORT, Runs, call, codes, jload, jsave

SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL / 'scripts'))
import merge_runs  # noqa: E402

TZ = 'Asia/Hong_Kong'


def today():
    return datetime.now(ZoneInfo(TZ)).date()


class PastRuns(Runs):
    """Like `Runs`, but over a window that has already ended, so a real build can be issued later."""

    def __init__(self, end):
        self.end = end
        self.window = ('--end', end.isoformat(), '--cutoff', f'{end.isoformat()}T18:00:00+08:00')
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'run'
        call('init', self.root, *self.window, '--lang', 'en', '--no-cases')

    def task(self, name):
        run = self.root / 'tasks' / name
        call('init', run, *self.window, '--lang', 'en', '--no-cases')
        return run

    def event(self, run, url, text, title, quote, claim, side='us', decision='include', proposed=False, date=None):
        return super().event(run, url, text, title, quote, claim, side, decision, proposed, date or (self.end - timedelta(days=1)).isoformat())

    def ready(self, run):
        eid = self.rule(run)
        self.news(run, decision='track')
        for q in ('q1', 'q2', 'q3'):
            call('search', run, q)
        self.report_json(run, eid)
        return eid


def fails(run):
    review = jload(run / 'qa' / 'review_report.json')
    return [x for xs in review['checks'].values() for x in xs if x['status'] == 'FAIL']


class IssueDateTests(unittest.TestCase):
    def test_a_build_after_midnight_is_issued_today_without_moving_the_window(self):
        r = PastRuns(today() - timedelta(days=1))
        self.addCleanup(r.close)
        r.ready(r.root)
        cfg_before = jload(r.root / 'run_config.json')
        code, out = call('build', r.root, '--issue-date', today().isoformat())
        self.assertNotIn('Not ready', out)
        self.assertEqual(fails(r.root), [])
        ledger = jload(r.root / 'report_ledger.json')
        self.assertEqual(ledger['report_date'], today().isoformat())
        self.assertEqual(ledger['cutoff'], cfg_before['cutoff'])
        self.assertEqual(jload(r.root / 'run_config.json'), cfg_before)
        html = (r.root / 'report.html').read_text(encoding='utf-8')
        self.assertIn(f'data-report-date="{today().isoformat()}"', html)

    def test_without_an_issue_date_a_late_build_is_still_caught(self):
        r = PastRuns(today() - timedelta(days=1))
        self.addCleanup(r.close)
        r.ready(r.root)
        call('build', r.root)
        # The single-agent default is unchanged: the report is dated by the window end, and generation today does not fit it.
        self.assertIn('GENERATION_REPORT_MISMATCH', codes(fails(r.root)))

    def test_generation_time_is_renewed_by_each_dated_build(self):
        r = PastRuns(today() - timedelta(days=3))
        self.addCleanup(r.close)
        r.ready(r.root)
        call('build', r.root, '--issue-date', today().isoformat())
        first = jload(r.root / 'report_ledger.json')['generated_at']
        led = jload(r.root / 'report_ledger.json'); led['generated_at'] = '2000-01-01T00:00:00+00:00'; jsave(r.root / 'report_ledger.json', led)
        call('build', r.root, '--issue-date', today().isoformat())
        self.assertGreaterEqual(jload(r.root / 'report_ledger.json')['generated_at'], first)
        self.assertIsNone(jload(r.root / 'evidence_ledger.json')['generated_at'])

    def test_historical_window_issued_long_after_it_ended(self):
        r = PastRuns(today() - timedelta(days=40))
        self.addCleanup(r.close)
        r.ready(r.root)
        call('build', r.root, '--issue-date', today().isoformat())
        self.assertEqual(fails(r.root), [])

    def test_issue_date_before_the_window_ends_or_in_the_future_is_refused(self):
        r = PastRuns(today() - timedelta(days=2))
        self.addCleanup(r.close)
        r.ready(r.root)
        for bad, why in (((today() - timedelta(days=3)).isoformat(), 'before the coverage window ends'),
                         ((today() + timedelta(days=2)).isoformat(), 'after today'), ('2030-02-30', 'not a YYYY-MM-DD date')):
            code, out = call('build', r.root, '--issue-date', bad)
            self.assertEqual(code, 1)
            self.assertIn(why, out)
        self.assertFalse((r.root / 'report.html').exists())

    def test_evidence_published_after_the_cutoff_is_still_flagged_when_issued_later(self):
        r = PastRuns(today() - timedelta(days=3))
        self.addCleanup(r.close)
        r.ready(r.root)
        led = jload(r.root / 'evidence_ledger.json')
        led['claims'][0]['sources'][0]['publication_date'] = (today() - timedelta(days=1)).isoformat()
        jsave(r.root / 'evidence_ledger.json', led)
        call('build', r.root, '--issue-date', today().isoformat())
        review = jload(r.root / 'qa' / 'review_report.json')
        self.assertIn('PUBLICATION_AFTER_CUTOFF', {x['code'] for xs in review['checks'].values() for x in xs})


class ClaimLevelLabelTests(unittest.TestCase):
    def setUp(self):
        self.r = Runs()
        self.addCleanup(self.r.close)

    def story_labels(self):
        html = (self.r.root / 'report.html').read_text(encoding='utf-8')
        article = html[html.index('<article class="story">'):]
        return [l for l in article[:article.index('</h3>')].split('class="st ')[1:]]

    def build(self, mixed):
        run = self.r.root
        eid = self.r.rule(run)
        self.r.news(run, decision='track')
        if mixed:
            call('fetch', run, 'https://www.reuters.com/synthetic', '--file', self.r.page(REPORT, 'news.txt'), '--route', 'http_tool')
            sid = jload(run / 'sources.json')['sources'][-1]['id']
            code, out = call('add-claim', run, eid, sid, '--quote', 'halted shipments of synthetic wafers', '--type', 'news',
                             '--text', 'According to Reuters, Synthetic Foundry halted shipments of synthetic wafers.')
            self.assertEqual(code, 0, out)
        for q in ('q1', 'q2', 'q3'):
            call('search', run, q)
        self.r.report_json(run, eid)
        call('event', run, 'decide', eid, 'include', '--reason', 'Synthetic: material in the window')
        events = jload(run / 'events.json')
        events['events'][0]['proposed'] = False
        jsave(run / 'events.json', events)
        led = jload(run / 'evidence_ledger.json'); led['generated_at'] = '2030-03-10T19:00:00+08:00'; jsave(run / 'evidence_ledger.json', led)
        call('build', run)
        return (run / 'report.html').read_text(encoding='utf-8')

    def test_official_only_story_is_confirmed(self):
        self.build(mixed=False)
        self.assertEqual([l.split('"')[0] for l in self.story_labels()], ['confirmed'])

    def test_one_official_claim_does_not_make_a_media_claim_official(self):
        html = self.build(mixed=True)
        self.assertEqual([l.split('"')[0] for l in self.story_labels()], ['confirmed', 'reported'])
        self.assertIn('Official or company source opened; some claims rest on media reports only', html)

    def test_proposed_measure_reads_as_proposed_in_the_status_table(self):
        run = self.r.root
        eid = self.r.rule(run)
        self.r.news(run, decision='track')
        for q in ('q1', 'q2', 'q3'):
            call('search', run, q)
        self.r.report_json(run, eid)
        led = jload(run / 'evidence_ledger.json'); led['generated_at'] = '2030-03-10T19:00:00+08:00'; jsave(run / 'evidence_ledger.json', led)
        call('build', run)
        self.assertIn('Proposed: Official or company source opened', (run / 'report.html').read_text(encoding='utf-8'))


class MergeRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.r = Runs()
        self.addCleanup(self.r.close)
        self.lead, self.scout = self.r.task('us-lead'), self.r.task('us-s01')
        self.r.rule(self.scout)
        self.r.news(self.scout)

    def merge_cli(self, fault=None):
        env = {k: v for k, v in os.environ.items() if k != 'MERGE_RUNS_FAULT'}
        if fault:
            env['MERGE_RUNS_FAULT'] = fault
        return subprocess.run([sys.executable, '-I', str(SKILL / 'scripts' / 'merge_runs.py'), str(self.lead),
                               '--from', f'us-s01={self.scout}', '--json'], env=env, capture_output=True, text=True)

    def state(self):
        return {name: (self.lead / name).read_text(encoding='utf-8') for name in ('sources.json', 'events.json', 'evidence_ledger.json', 'merge_log.json')
                if (self.lead / name).exists()}

    def test_a_merge_killed_mid_commit_is_finished_by_the_next_run_and_never_applied_twice(self):
        before = self.state()
        killed = self.merge_cli('merge:committed')
        self.assertEqual(killed.returncode, 75)
        # Killed after the commit record, before any file moved: the target is still as it was.
        self.assertTrue((self.lead / merge_runs.COMMIT).exists())
        self.assertEqual(self.state(), before)
        again = self.merge_cli()
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        once = self.state()
        self.assertEqual(len(jload(self.lead / 'evidence_ledger.json')['claims']), 2)
        self.assertEqual(len(jload(self.lead / 'events.json')['events']), 2)
        self.assertEqual(self.merge_cli().returncode, 0)
        self.assertEqual(jload(self.lead / 'evidence_ledger.json'), json.loads(once['evidence_ledger.json']))
        for claim in jload(self.lead / 'evidence_ledger.json')['claims']:
            self.assertEqual(len(claim['provenance']), len({json.dumps(p, sort_keys=True) for p in claim['provenance']}))
        self.assertFalse(list(self.lead.glob(f'*{merge_runs.STAGED}')))

    def test_uncommitted_staged_files_are_discarded(self):
        before = self.state()
        (self.lead / f'events.json{merge_runs.STAGED}').write_text('{"events": "half-written"}', encoding='utf-8')
        self.assertFalse(merge_runs.finish_commit(self.lead))
        self.assertEqual(self.state(), before)
        self.assertFalse(list(self.lead.glob(f'*{merge_runs.STAGED}')))

    def test_a_lock_left_by_a_dead_process_is_taken_over_and_a_live_one_is_not(self):
        dead = subprocess.run([sys.executable, '-c', 'import os; print(os.getpid())'], capture_output=True, text=True).stdout.strip()
        (self.lead / '.merge.lock').write_text(dead)
        result = self.merge_cli()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertFalse((self.lead / '.merge.lock').exists())
        live = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
        self.addCleanup(live.kill)
        (self.lead / '.merge.lock').write_text(str(live.pid))
        refused = self.merge_cli()
        self.assertEqual(refused.returncode, 1)
        self.assertIn('another merge', refused.stdout)

    def test_an_unreadable_lock_is_stale_only_after_a_while(self):
        lock = self.lead / '.merge.lock'
        lock.write_text('')
        self.assertFalse(merge_runs.Lock(self.lead).stale())
        old = lock.stat().st_mtime - merge_runs.Lock.UNREADABLE_STALE_AFTER - 5
        os.utime(lock, (old, old))
        self.assertTrue(merge_runs.Lock(self.lead).stale())


class RoleConfigTests(unittest.TestCase):
    def test_reserve_leaves_room_for_research(self):
        cfg = json.loads((SKILL / 'references' / 'roles' / 'workflow.json').read_text(encoding='utf-8'))['token_budget']
        reserve = sum(cfg['reserve_fresh_tokens'].values())
        task = cfg['task_fresh_tokens']
        # Both leads and one scout each must be able to start at once with the reserve held back.
        self.assertLessEqual(reserve + 2 * (task['lead'] + cfg['in_flight_margin']) + task['scout'] + cfg['in_flight_margin'], cfg['run_fresh_tokens'])
        self.assertGreaterEqual(cfg['reserve_fresh_tokens']['review'], task['reviewer'])

    def test_reviewer_is_told_how_to_assess_earlier_findings(self):
        text = (SKILL / 'references' / 'roles' / 'reviewer.md').read_text(encoding='utf-8')
        self.assertIn('"previous"', text)
        self.assertIn('previous_findings', text)


if __name__ == '__main__':
    unittest.main()
