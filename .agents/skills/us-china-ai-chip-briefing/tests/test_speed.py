"""Fewer model round trips: `brief.py batch` (many record commands in one call) and `brief.py precheck` (a chief
runs the checks a draft submission runs before submitting). Synthetic example sources only; nothing is fetched."""
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_multi_agent import Runs, call, jload, jsave, RULE  # noqa: E402


class BatchTests(unittest.TestCase):
    def setUp(self):
        self.r = Runs()
        self.run = self.r.task('scout')
        self.page = self.r.page(f'Published 2030-03-06.\n{RULE}', 'rule.txt')

    def tearDown(self):
        self.r.close()

    def batch(self, ops):
        path = Path(self.r.tmp.name) / 'ops.json'
        jsave(path, ops)
        return call('batch', self.run, path)

    def test_one_call_records_source_event_and_claim_with_step_references(self):
        code, out = self.batch([
            ['fetch', 'https://www.example.gov/rule', '--file', str(self.page), '--route', 'http_tool'],
            ['source-date', '@1', '--date', '2030-03-06'],
            ['event', 'add', '--title', 'Synthetic agency proposes accelerator rule', '--date', '2030-03-06', '--side', 'us',
             '--source', '@1', '--materiality', 'high'],
            ['add-claim', '@3', '@1', '--quote', 'today issued a proposed rule on synthetic accelerators',
             '--text', 'The Synthetic Agency issued a proposed rule on synthetic accelerators.'],
            ['event', 'decide', '@3', 'include', '--reason', 'Synthetic: material in the window', '--proposed'],
        ])
        self.assertEqual(code, 0, out)
        self.assertIn('all 5 steps done', out)
        self.assertEqual([e['id'] for e in jload(self.run / 'events.json')['events']], ['E001'])
        claim = jload(self.run / 'evidence_ledger.json')['claims'][0]
        self.assertEqual((claim['id'], claim['event_id'] if 'event_id' in claim else 'E001'), ('C001', 'E001'))
        self.assertEqual(jload(self.run / 'events.json')['events'][0]['decision'], 'include')

    def test_stops_at_the_first_failure_and_keeps_earlier_steps(self):
        code, out = self.batch([
            ['fetch', 'https://www.example.gov/rule', '--file', str(self.page), '--route', 'http_tool'],
            ['add-claim', 'E009', '@1', '--quote', 'today issued', '--text', 'x'],
            ['search', 'never run'],
        ])
        self.assertEqual(code, 1)
        self.assertIn('step 2 failed', out)
        self.assertIn('Steps 1–1 are recorded', out)
        self.assertEqual(len(jload(self.run / 'sources.json')['sources']), 1)
        self.assertFalse(jload(self.run / 'events.json').get('searches'))

    def test_refuses_commands_that_do_not_belong_in_a_batch(self):
        code, out = self.batch([['build']])
        self.assertEqual(code, 1)
        self.assertIn('cannot run in a batch', out)
        code, out = self.batch({'not': 'a list'})
        self.assertEqual(code, 1)

    def test_reference_to_a_step_that_created_nothing_is_refused(self):
        code, out = self.batch([['search', 'q'], ['add-claim', '@1', 'S001', '--quote', 'q', '--text', 't']])
        self.assertEqual(code, 1)
        self.assertIn('created no ID', out)


class PrecheckTests(unittest.TestCase):
    def setUp(self):
        self.r = Runs()
        self.run = self.r.root
        cfg = jload(self.run / 'run_config.json')  # Nex issues the chief's assignment like any task's
        jsave(self.run / 'assignment.json', {'task_id': 'chief', 'window': cfg['window'], 'cutoff': cfg['cutoff']})

    def tearDown(self):
        self.r.close()

    def test_names_what_a_submission_would_be_refused_for(self):
        eid = self.r.rule(self.run, decision='track')
        call('event', self.run, 'decide', eid, 'track', '--reason', 'Covered by E013 instead')
        code, out = call('precheck', self.run)
        self.assertEqual(code, 1, out)
        self.assertIn('FIX INTERNAL_ID_SHOWN', out)
        self.assertIn('Build was not run', out)
        self.assertFalse((self.run / 'report.html').exists())

    def test_clean_draft_is_built_and_cleared_for_submission(self):
        eid = self.r.rule(self.run)
        self.r.news(self.run, decision='track')
        for q in ('synthetic accelerator rule', 'synthetic wafer shipments', 'synthetic foundry licence'):
            call('search', self.run, q, '--found', 'synthetic result')
        self.r.report_json(self.run, eid)
        code, out = call('precheck', self.run)
        self.assertIn('Handoff check: no refusals.', out)
        self.assertTrue((self.run / 'report.html').exists(), out)
        readiness = jload(self.run / 'qa' / 'review_report.json')['readiness']
        if readiness == 'BLOCKED':
            self.assertEqual(code, 1, out)
            self.assertIn('would be refused', out)
        else:
            self.assertEqual(code, 0, out)
            self.assertIn('Submit the draft.', out)


if __name__ == '__main__':
    unittest.main()
