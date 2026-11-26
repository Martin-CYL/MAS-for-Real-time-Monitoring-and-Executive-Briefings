"""Fixes from run mas-20261125-234529-61ef: one event per active case (record, hand-in, merge), status rows labelled
from what they print and grouped by date, negative status notes backed by a negative claim, and precheck asking for
the fixes the author can make now. Synthetic example sources only; nothing is fetched."""
import json
from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_multi_agent import Runs, call, codes, jload, jsave, RULE, REPORT  # noqa: E402
import check_handoff  # noqa: E402
import merge_runs  # noqa: E402

NEWS = 'Synthetic Daily reported that a synthetic buyer expects samples of the synthetic accelerator in December.'


class OneEventPerCaseTests(unittest.TestCase):
    def setUp(self):
        self.r = Runs()
        self.addCleanup(self.r.close)
        self.run = self.r.task('scout')
        jsave(self.run / 'assignment.json', {**jload(self.run / 'assignment.json'), 'cases': ['A006']})

    def add(self, title, case=None):
        args = ['event', self.run, 'add', '--title', title, '--date', '2030-03-06', '--side', 'cn']
        return call(*args, *(['--case', case] if case else []))

    def test_add_refuses_a_second_event_for_the_same_case(self):
        self.assertEqual(self.add('Synthetic accelerator approval pending', 'A006')[0], 0)
        code, out = self.add('Synthetic foundry rule takes effect', 'A006')
        self.assertEqual(code, 1)
        self.assertIn('one event per case', out)

    def test_decide_moves_or_clears_a_case(self):
        self.add('Synthetic accelerator approval pending', 'A006')
        self.add('Synthetic foundry rule takes effect')
        code, out = call('event', self.run, 'decide', 'E002', 'track', '--reason', 'r', '--case', 'A006')
        self.assertEqual(code, 1)
        self.assertIn('already the case of E001', out)
        self.assertEqual(call('event', self.run, 'decide', 'E001', 'track', '--reason', 'r', '--case', 'none')[0], 0)
        self.assertEqual(call('event', self.run, 'decide', 'E002', 'track', '--reason', 'r', '--case', 'A006')[0], 0)
        cases = {e['id']: e.get('case_id') for e in jload(self.run / 'events.json')['events']}
        self.assertEqual(cases, {'E001': None, 'E002': 'A006'})

    def test_hand_in_with_one_case_on_several_events_is_refused(self):
        self.r.rule(self.run)
        self.r.news(self.run)
        data = jload(self.run / 'events.json')
        for e in data['events']:
            e['case_id'] = 'A006'  # as the scout in run 61ef left them
        jsave(self.run / 'events.json', data)
        self.r.narrative(self.run)
        shared = [x for x in check_handoff.check(self.run, 'scout') if x['code'] == 'CASE_SHARED']
        self.assertEqual([x['status'] for x in shared], ['FAIL'])
        self.assertIn('--case none', shared[0]['message'])


class MergeByCaseTests(unittest.TestCase):
    def test_a_case_joins_one_event_of_a_task_the_rest_stay_apart(self):
        r = Runs()
        self.addCleanup(r.close)
        target = r.task('cn-lead')
        call('event', target, 'add', '--title', 'Has the synthetic accelerator been approved?', '--date', '2030-03-01',
             '--side', 'cn', '--case', 'A006')
        source = r.task('cn-s02')
        r.event(source, 'https://www.example.gov/rule', RULE, 'Synthetic agency proposes accelerator rule',
                'today issued a proposed rule on synthetic accelerators', 'The Synthetic Agency issued a proposed rule on synthetic accelerators.')
        r.event(source, 'https://www.reuters.com/synthetic', REPORT, 'Synthetic foundry halts wafer shipments',
                'halted shipments of synthetic wafers', 'According to Reuters, Synthetic Foundry halted shipments of synthetic wafers.', side='cn')
        data = jload(source / 'events.json')
        for e in data['events']:
            e['case_id'] = 'A006'  # bypasses the add-time check, as a hand-edited or older record could
        jsave(source / 'events.json', data)
        merge_runs.merge(target, 'cn-s02', source)
        events = jload(target / 'events.json')['events']
        case_events = [e for e in events if e.get('case_id') == 'A006']
        self.assertEqual(len(case_events), 1, events)
        self.assertEqual(len(case_events[0].get('provenance') or []), 1)
        self.assertEqual(len(events), 2)  # the second development is its own event, without the case
        self.assertTrue(jload(target / 'events.json').get('possible_duplicates'))


class StatusRowTests(unittest.TestCase):
    def setUp(self):
        self.r = Runs()
        self.addCleanup(self.r.close)
        self.run = self.r.root
        cfg = jload(self.run / 'run_config.json')
        jsave(self.run / 'assignment.json', {'task_id': 'chief', 'window': cfg['window'], 'cutoff': cfg['cutoff']})

    def built(self):
        for q in ('synthetic accelerator rule', 'synthetic wafer shipments', 'synthetic foundry licence'):
            call('search', self.run, q, '--found', 'synthetic result')
        code, out = call('build', self.run)
        return (self.run / 'report.html').read_text(encoding='utf-8'), out

    def row(self, page, title):
        m = re.search(r'<tr><td data-label="[^"]*"><div>' + re.escape(title) + r'</div></td>(.*?)</tr>', page, re.S)
        self.assertTrue(m, title)
        return m.group(1)

    def test_a_row_is_labelled_from_the_claims_it_prints(self):
        eid = self.r.rule(self.run)
        tracked = self.r.event(self.run, 'https://www.reuters.com/samples', NEWS, 'Synthetic accelerator samples expected',
                               'expects samples of the synthetic accelerator in December',
                               'According to Synthetic Daily, a synthetic buyer expects accelerator samples in December.',
                               side='cn', decision='track')
        news_claim = jload(self.run / 'evidence_ledger.json')['claims'][-1]['id']
        # An official claim of another development filed under the same event, as the merge in run 61ef left it.
        call('fetch', self.run, 'https://www.example.gov/other', '--file', self.r.page(f'Published 2030-03-06.\n{RULE}', 'o.txt'), '--route', 'http_tool')
        sid = jload(self.run / 'sources.json')['sources'][-1]['id']
        call('source-date', self.run, sid, '--date', '2030-03-06')
        self.assertEqual(call('add-claim', self.run, tracked, sid, '--quote', 'today issued a proposed rule on synthetic accelerators',
                              '--text', 'The Synthetic Agency issued a proposed rule on synthetic accelerators.', '--type', 'official_document')[0], 0)
        call('event', self.run, 'decide', tracked, 'track', '--reason', 'r', '--status-claim', news_claim,
             '--link', 'l', '--size', 's', '--new', 'n')
        self.r.report_json(self.run, eid)
        page, out = self.built()
        row = self.row(page, 'Synthetic accelerator samples expected')
        self.assertIn('data-evidence="partial"', row, out)  # the printed claim is media only

    def test_a_development_dated_before_the_window_is_not_new_this_period(self):
        eid = self.r.rule(self.run)
        self.r.event(self.run, 'https://www.reuters.com/early', REPORT, 'Synthetic foundry halted shipments earlier',
                     'halted shipments of synthetic wafers', 'According to Reuters, Synthetic Foundry halted shipments of synthetic wafers.',
                     side='cn', decision='track', date='2030-03-01')
        self.r.report_json(self.run, eid)
        page, out = self.built()
        table = page[page.index('status-table'):]
        self.assertIn('Earlier developments, still tracked', table, out)
        self.assertLess(table.index('Earlier developments, still tracked'), table.index('Synthetic foundry halted shipments earlier'))


class NegativeNoteTests(unittest.TestCase):
    def setUp(self):
        self.r = Runs()
        self.addCleanup(self.r.close)

    def test_a_not_found_note_needs_a_negative_claim(self):
        run = self.r.task('scout')
        eid = self.r.news(run, decision='track')
        call('event', run, 'decide', eid, 'track', '--reason', 'r', '--status-note', 'No approval or delivery was established by the cutoff.')
        self.r.narrative(run)
        self.assertEqual([x['status'] for x in check_handoff.check(run, 'scout') if x['code'] == 'NEGATIVE_NOTE_UNSUPPORTED'], ['UNVERIFIED'])
        self.assertEqual([x['status'] for x in check_handoff.check(run, 'chief') if x['code'] == 'NEGATIVE_NOTE_UNSUPPORTED'], ['FAIL'])
        sid = jload(run / 'sources.json')['sources'][-1]['id']
        code, out = call('add-claim', run, eid, sid, '--quote', 'halted shipments of synthetic wafers', '--kind', 'negative',
                         '--text', 'According to reuters.com, a March 10 search of the synthetic register found no approval for the synthetic buyer.')
        self.assertEqual(code, 0, out)
        claim = jload(run / 'evidence_ledger.json')['claims'][-1]['id']
        call('event', run, 'decide', eid, 'track', '--reason', 'r', '--status-claim', claim)
        self.assertNotIn('NEGATIVE_NOTE_UNSUPPORTED', codes(check_handoff.check(run, 'chief')))

    def test_a_positive_note_is_not_flagged(self):
        run = self.r.task('scout')
        eid = self.r.news(run, decision='track')
        call('event', run, 'decide', eid, 'track', '--reason', 'r', '--status-note', 'Shipments resumed on March 9.')
        self.assertNotIn('NEGATIVE_NOTE_UNSUPPORTED', codes(check_handoff.check(run, 'scout')))


class PrecheckFixableTests(unittest.TestCase):
    """The build itself is covered elsewhere; here the validator's answer is fixed so only precheck's rule is tested."""

    def setUp(self):
        self.r = Runs()
        self.addCleanup(self.r.close)
        self.run = self.r.root
        cfg = jload(self.run / 'run_config.json')
        jsave(self.run / 'assignment.json', {'task_id': 'chief', 'window': cfg['window'], 'cutoff': cfg['cutoff']})
        self.r.report_json(self.run, self.r.rule(self.run))

    def precheck_with(self, items, readiness):
        import unittest.mock
        import brief

        def fake_build(a):
            (self.run / 'qa').mkdir(exist_ok=True)
            jsave(self.run / 'qa' / 'review_report.json', {'readiness': readiness, 'checks': {'report': items}})
            return 2
        with unittest.mock.patch.object(brief, 'cmd_build', fake_build):
            return call('precheck', self.run)

    def test_items_the_author_can_fix_now_must_be_fixed_before_submitting(self):
        code, out = self.precheck_with([{'status': 'UNVERIFIED', 'code': 'FIRST_USE', 'message': 'XYZQ: explain at first visible use'}],
                                       'INCOMPLETE')
        self.assertEqual(code, 1, out)
        self.assertIn('FIX FIRST_USE: XYZQ', out)
        self.assertIn('you can fix now', out)

    def test_evidence_gaps_are_left_to_the_reviewer(self):
        code, out = self.precheck_with([{'status': 'UNVERIFIED', 'code': 'PRIMARY_LEGAL_SOURCE', 'message': 'C001 needs the instrument'}],
                                       'INCOMPLETE')
        self.assertEqual(code, 0, out)
        self.assertIn('Submit the draft.', out)


if __name__ == '__main__':
    unittest.main()
