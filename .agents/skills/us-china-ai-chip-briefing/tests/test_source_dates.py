"""Publication dates of saved pages: recorded from what the page shows, or explained when it shows none.

A page saved from a browser keeps only its text, so the automatic detection (page metadata) finds no date. Found live
in run mas-20261123-165809-59cd: 19 sources had no date although most pages showed one, and DATE_UNKNOWN held a
reviewed report INCOMPLETE. Synthetic .example sources and fictitious content only; nothing here fetches a page.
"""
from datetime import date
from pathlib import Path
import sys
import unittest

from test_multi_agent import Runs, call, codes, jload

SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL / 'scripts'))
import check_handoff  # noqa: E402
import evidence_tools as ev  # noqa: E402
from check_dates import validate_dates  # noqa: E402
from qa_common import category, readiness  # noqa: E402

UNDATED_PAGE = 'Synthetic Agency release. The Synthetic Agency added Synthetic Foundry to the synthetic entity list.'
DATED_PAGE = 'Synthetic Agency release\nMarch 6, 2030\nThe Synthetic Agency added Synthetic Foundry to the synthetic entity list.'
QUOTE = 'added Synthetic Foundry to the synthetic entity list'
CLAIM = 'The Synthetic Agency added Synthetic Foundry to the synthetic entity list.'


class SourceDateTests(unittest.TestCase):
    def setUp(self):
        self.r = Runs()
        self.run = self.r.task('scout')

    def tearDown(self):
        self.r.close()

    def record(self, page, url='https://www.example.gov/release', text=CLAIM):
        call('fetch', self.run, url, '--file', self.r.page(page, f'{abs(hash((url, page)))}.txt'), '--route', 'browser')
        sid = jload(self.run / 'sources.json')['sources'][-1]['id']
        call('event', self.run, 'add', '--title', 'Synthetic agency lists synthetic foundry', '--date', '2030-03-06', '--side', 'us',
             '--source', sid, '--materiality', 'high', '--why', 'Synthetic link to US-China chip competition')
        eid = jload(self.run / 'events.json')['events'][-1]['id']
        call('event', self.run, 'decide', eid, 'include', '--reason', 'Synthetic: material in the window',
             '--link', 'Synthetic export-control link', '--size', 'Changes synthetic rules', '--new', 'Issued in the window')
        code, out = call('add-claim', self.run, eid, sid, '--quote', QUOTE, '--text', text, '--kind', 'list')
        self.assertEqual(code, 0, out)
        self.r.narrative(self.run)
        return sid, out

    def source(self, sid):
        return next(s for s in jload(self.run / 'sources.json')['sources'] if s['id'] == sid)

    def ledger_sources(self):
        return [s for c in jload(self.run / 'evidence_ledger.json')['claims'] for s in c['sources']]

    def test_a_source_without_a_date_is_refused_at_handoff_with_the_command_that_fixes_it(self):
        sid, out = self.record(DATED_PAGE)
        self.assertIn(f'brief.py source-date RUN {sid} --date', out)  # add-claim says so at once
        items = check_handoff.check(self.run, 'scout')
        missing = [x for x in items if x['code'] == 'SOURCE_DATE_MISSING']
        self.assertEqual([x['status'] for x in missing], ['FAIL'])
        self.assertIn('2030-03-06', missing[0]['message'])  # the date the page shows is suggested

    def test_the_date_the_page_shows_is_recorded_on_the_source_and_every_claim_citing_it(self):
        sid, _ = self.record(DATED_PAGE)
        code, out = call('source-date', self.run, sid, '--date', '2030-03-06')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.source(sid)['publication_date_shown'], 'March 6, 2030')
        self.assertEqual({s['publication_date'] for s in self.ledger_sources()}, {'2030-03-06'})
        found = codes(check_handoff.check(self.run, 'scout'))
        self.assertNotIn('SOURCE_DATE_MISSING', found)
        self.assertNotIn('CLAIM_EDITED_BY_HAND', found)  # the fingerprint is renewed with the date
        # A later claim from the same page takes the date from the source.
        eid = jload(self.run / 'events.json')['events'][-1]['id']
        call('add-claim', self.run, eid, sid, '--quote', 'Synthetic Agency added Synthetic Foundry', '--text',
             'The Synthetic Agency added Synthetic Foundry.', '--kind', 'list')
        self.assertEqual(jload(self.run / 'evidence_ledger.json')['claims'][-1]['sources'][0]['publication_date'], '2030-03-06')

    def test_a_date_the_page_does_not_show_is_refused(self):
        sid, _ = self.record(DATED_PAGE)
        before = (self.run / 'evidence_ledger.json').read_text(encoding='utf-8')
        code, out = call('source-date', self.run, sid, '--date', '2030-03-07')
        self.assertEqual(code, 1)
        self.assertIn('is not written on the saved page', out)
        self.assertEqual((self.run / 'evidence_ledger.json').read_text(encoding='utf-8'), before)
        self.assertNotIn('publication_date_shown', self.source(sid))

    def test_a_date_written_another_way_is_accepted_only_as_the_page_writes_it(self):
        sid, _ = self.record('Synthetic Agency release. Issued: Fri 6th of March. The Synthetic Agency added Synthetic Foundry '
                             'to the synthetic entity list.')
        code, out = call('source-date', self.run, sid, '--date', '2030-03-06')
        self.assertEqual(code, 1, out)
        code, out = call('source-date', self.run, sid, '--date', '2030-03-06', '--shown', 'Issued: Fri 7th of March')
        self.assertEqual(code, 1, out)  # not on the page
        code, out = call('source-date', self.run, sid, '--date', '2030-03-06', '--shown', 'Fri 6th of March')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.source(sid)['publication_date_shown'], 'Fri 6th of March')

    def test_a_date_in_the_url_counts(self):
        sid, _ = self.record(UNDATED_PAGE, url='https://www.example.gov/uploads/2030/03/3.6.30-Synthetic-Summary.pdf')
        code, out = call('source-date', self.run, sid, '--date', '2030-03-06')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.source(sid)['publication_date_shown'], '3.6.30')

    def test_a_timestamp_needs_its_offset(self):
        sid, _ = self.record(DATED_PAGE)
        code, out = call('source-date', self.run, sid, '--date', '2030-03-06T10:05:00')
        self.assertEqual(code, 1)
        self.assertIn('no UTC offset', out)
        code, out = call('source-date', self.run, sid, '--date', '2030-03-06T10:05:00-05:00')
        self.assertEqual(code, 0, out)
        self.assertEqual({s['publication_date'] for s in self.ledger_sources()}, {'2030-03-06T10:05:00-05:00'})

    def test_a_page_with_no_date_is_explained_and_left_to_a_person_not_held_as_an_evidence_gap(self):
        sid, _ = self.record(UNDATED_PAGE, url='https://www.example.gov/faq/899')
        code, out = call('source-date', self.run, sid, '--undated', 'too short')
        self.assertEqual(code, 1, out)
        reason = 'FAQ page with no publication or revision date; checked on the save date'
        code, out = call('source-date', self.run, sid, '--undated', reason)
        self.assertEqual(code, 0, out)
        self.assertEqual({s.get('undated_reason') for s in self.ledger_sources()}, {reason})
        self.assertFalse([x for x in check_handoff.check(self.run, 'scout') if x['status'] == 'FAIL'])
        # The validator names it for a person instead of holding the report INCOMPLETE.
        found = validate_dates('', jload(self.run / 'evidence_ledger.json'), None, '2030-03-11T00:00:00+00:00')
        undated = [x for x in found if x['code'] == 'DATE_NOT_SHOWN']
        self.assertEqual(len(undated), 1)
        self.assertIn(reason, undated[0]['message'])
        self.assertNotIn('DATE_UNKNOWN', codes(found))
        self.assertEqual(category(undated[0]), 'human_review')
        self.assertEqual(readiness(undated)[0], 'READY_FOR_HUMAN_REVIEW')
        # A later date replaces the explanation.
        call('source-date', self.run, sid, '--date', '2030-03-06', '--shown', 'Synthetic Agency release')  # no day 6 in it
        self.assertEqual(self.source(sid).get('undated'), reason)

    def test_an_unexplained_unknown_date_still_holds_the_report(self):
        sid, _ = self.record(UNDATED_PAGE)
        found = validate_dates('', jload(self.run / 'evidence_ledger.json'), None, '2030-03-11T00:00:00+00:00')
        unknown = [x for x in found if x['code'] == 'DATE_UNKNOWN']
        self.assertTrue(unknown)
        self.assertEqual(readiness(unknown)[0], 'INCOMPLETE')

    def test_undated_while_the_page_shows_dates_is_flagged_for_the_parent(self):
        sid, _ = self.record(DATED_PAGE)
        code, out = call('source-date', self.run, sid, '--undated', 'Release page; the date shown is a revision date')
        self.assertEqual(code, 0, out)
        self.assertIn('the page does show dates near the top (2030-03-06)', out)
        items = check_handoff.check(self.run, 'scout')
        self.assertEqual([x['status'] for x in items if x['code'] == 'UNDATED_WITH_DATES'], ['UNVERIFIED'])

    def test_a_mislabelled_source_type_is_refused_at_handoff(self):
        sid, _ = self.record(DATED_PAGE, url='https://investor.example.com/release')
        call('source-date', self.run, sid, '--date', '2030-03-06')
        led = jload(self.run / 'evidence_ledger.json')
        cid = led['claims'][0]['id']
        # add-claim classes an unknown site as "other"; a writer who forces official_document is caught at handoff.
        call('withdraw', self.run, cid, '--reason', 'synthetic: re-add with a type')
        eid = jload(self.run / 'events.json')['events'][-1]['id']
        call('add-claim', self.run, eid, sid, '--quote', QUOTE, '--text', CLAIM, '--kind', 'list', '--type', 'official_document')
        mismatched = [x for x in check_handoff.check(self.run, 'scout') if x['code'] == 'SOURCE_TYPE_MISMATCH']
        self.assertEqual([x['status'] for x in mismatched], ['FAIL'])
        self.assertIn('company_statement', mismatched[0]['message'])


class DateOnPageTests(unittest.TestCase):
    def test_common_ways_of_writing_a_date(self):
        day = date(2026, 11, 19)
        for text in ('Released 2026-11-19', 'Released 2026/11/19', '发布时间：2026年11月19日', 'November 19, 2026',
                     'Nov. 19, 2026', '19 November 2026', 'Updated 11/19/2026', 'Updated 11/19/26'):
            self.assertTrue(ev.date_on_page(day, text), text)
        self.assertEqual(ev.date_on_page(day, '', 'https://x.example/uploads/2026/11/11.19.26-Summary.pdf'), '11.19.26')
        self.assertEqual(ev.date_on_page(day, '', 'https://x.example/finalpage/20261119/a.pdf'), '20261119')
        for text in ('2026-11-191', 'November 9, 2026', '2026-11-18', '119 November 2026', 'November 19, 2025'):
            self.assertIsNone(ev.date_on_page(day, text), text)


if __name__ == '__main__':
    unittest.main()
