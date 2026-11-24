"""Source lanes in the multi-agent workflow: what each lane may record, media scouts' primary leads, follow-up
results, and how a follow-up's primary claim joins the reported event in the lead's run.

Synthetic .invalid / example sources and fictitious content only. Nothing here fetches a page.
"""
import json
from pathlib import Path
import sys
import unittest

from test_multi_agent import Runs, call, codes, jload, jsave

SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL / 'scripts'))
import brief  # noqa: E402
import check_handoff  # noqa: E402
import merge_runs  # noqa: E402

TITLE = 'Synthetic agency adds synthetic foundry to entity list'
DATE = '2030-03-06'
RULE = 'The Synthetic Agency issued a final rule that adds Synthetic Foundry to the synthetic entity list, effective March 6, 2030.'
REPORT = 'Synthetic Wire reported that the Synthetic Agency added Synthetic Foundry to the synthetic entity list on March 6, 2030.'
FILING = 'Synthetic Foundry Inc. said in a filing that the listing would reduce its synthetic revenue from China by about a tenth.'


class LaneRuns(Runs):
    def lane_task(self, name, lane, **assignment):
        run = self.task(name)
        doc = jload(run / 'assignment.json')
        doc.update(role='scout', lane=lane, **assignment)
        jsave(run / 'assignment.json', doc)
        return run

    def record(self, run, url, page, quote, claim, etype, title=TITLE, date=DATE, side='us', materiality='high', decision='include'):
        call('fetch', run, url, '--file', self.page(f'Published {date}.\n{page}', f'{abs(hash((str(run), url, claim)))}.txt'), '--route', 'http_tool')
        sid = jload(run / 'sources.json')['sources'][-1]['id']
        code, out = call('source-date', run, sid, '--date', date)  # a page saved as text keeps no date metadata
        assert code == 0, out
        call('event', run, 'add', '--title', title, '--date', date, '--side', side, '--source', sid,
             '--materiality', materiality, '--why', 'Synthetic link to US-China chip competition')
        eid = jload(run / 'events.json')['events'][-1]['id']
        call('event', run, 'decide', eid, decision, '--reason', 'Synthetic: material in the window',
             '--link', 'Synthetic export-control link', '--size', 'Changes synthetic rules', '--new', 'Issued in the window')
        code, out = call('add-claim', run, eid, sid, '--quote', quote, '--text', claim, '--type', etype, '--kind', 'list')
        assert code == 0, out
        return eid

    def official(self, run, **kw):
        return self.record(run, 'https://www.example.gov/rule', RULE, 'adds Synthetic Foundry to the synthetic entity list',
                           'The Synthetic Agency added Synthetic Foundry to the synthetic entity list.', 'official_document', **kw)

    def reported(self, run, url='https://www.reuters.com/synthetic-list', etype='news', **kw):
        return self.record(run, url, REPORT, 'added Synthetic Foundry to the synthetic entity list',
                           'According to Synthetic Wire, the Synthetic Agency added Synthetic Foundry to the synthetic entity list.', etype, **kw)

    def filing(self, run, **kw):
        return self.record(run, 'https://www.sec.gov/Archives/synthetic-8k.htm', FILING, 'reduce its synthetic revenue from China by about a tenth',
                           'Synthetic Foundry Inc. said the listing would reduce its synthetic revenue from China by about a tenth.',
                           'company_statement', **kw)

    def output(self, run, **fields):
        jsave(run / 'output.json', {'task_id': run.name, 'status': 'complete', 'summary': 'Synthetic summary.', **fields})


def fails(items):
    return {x['code'] for x in items if x['status'] == 'FAIL'}


class LaneEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.r = LaneRuns()
        self.addCleanup(self.r.close)

    def test_lanes_file_matches_the_role_file(self):
        lanes = check_handoff.lanes()
        self.assertEqual(set(lanes), {'official', 'company', 'media'})
        text = (SKILL / 'references' / 'roles' / 'source-scout.md').read_text(encoding='utf-8')
        for lane_id in lanes:
            self.assertIn(f'## Lane: {lane_id}\n', text)
        valid = {'official_document', 'company_statement', 'news', 'dataset', 'other'}
        for lane in lanes.values():
            self.assertTrue(set(lane['evidence_types']) <= valid, lane)
        # Media never records a primary type, so a label of "official" can only come from another lane.
        self.assertFalse(set(lanes['media']['evidence_types']) & brief.PRIMARY)

    def test_each_lane_passes_with_its_own_evidence(self):
        for lane, record in (('official', self.r.official), ('company', self.r.filing), ('media', self.r.reported)):
            run = self.r.lane_task(f'us-{lane}', lane)
            eid = record(run)
            self.r.narrative(run)
            self.r.output(run, primary_leads=[{'event_id': eid, 'agency': 'Synthetic Agency', 'document_hint': 'the final rule'}] if lane == 'media' else [])
            self.assertEqual(fails(check_handoff.check(run, 'scout')), set(), lane)

    def test_a_lane_may_not_record_another_lanes_evidence(self):
        official = self.r.lane_task('us-official', 'official')
        self.r.reported(official)
        self.assertIn('LANE_EVIDENCE_TYPE', fails(check_handoff.check(official, 'scout')))
        media = self.r.lane_task('us-media', 'media')
        self.r.official(media)
        self.assertIn('LANE_EVIDENCE_TYPE', fails(check_handoff.check(media, 'scout')))
        company = self.r.lane_task('us-company', 'company')
        self.r.reported(company)
        self.assertIn('LANE_EVIDENCE_TYPE', fails(check_handoff.check(company, 'scout')))

    def test_an_official_document_must_come_from_an_official_host(self):
        run = self.r.lane_task('us-official', 'official')
        self.r.reported(run, etype='official_document')  # a news page labelled as an official document
        found = check_handoff.check(run, 'scout')
        self.assertIn('LANE_SOURCE_HOST', fails(found))
        self.assertIn('reuters.com', next(x['message'] for x in found if x['code'] == 'LANE_SOURCE_HOST'))

    def test_lane_comes_from_the_assignment_and_a_different_one_is_refused(self):
        run = self.r.lane_task('us-media', 'media')
        self.r.official(run)
        self.assertIn('LANE_EVIDENCE_TYPE', fails(check_handoff.check(run, 'scout')))
        self.assertIn('LANE_MISMATCH', fails(check_handoff.check(run, 'scout', 'official')))
        unknown = self.r.lane_task('us-x', 'rumours')
        self.assertIn('LANE_UNKNOWN', fails(check_handoff.check(unknown, 'scout')))

    def test_topic_scouts_are_unaffected(self):
        run = self.r.task('us-s01')
        self.r.reported(run)
        self.r.official(run, title='Synthetic second event', date='2030-03-07')
        self.r.narrative(run)
        self.r.output(run)
        found = check_handoff.check(run, 'scout')
        self.assertFalse({c for c in codes(found) if c.startswith(('LANE_', 'PRIMARY_', 'LEAD_', 'MEDIA_'))}, found)


class PrimaryLeadTests(unittest.TestCase):
    def setUp(self):
        self.r = LaneRuns()
        self.addCleanup(self.r.close)
        self.run = self.r.lane_task('us-media', 'media')
        self.eid = self.r.reported(self.run)
        self.r.narrative(self.run)

    def test_a_lead_must_name_an_own_event_an_agency_and_a_document(self):
        self.r.output(self.run, primary_leads=[{'event_id': 'E099', 'agency': 'A', 'document_hint': 'd'}])
        self.assertIn('PRIMARY_LEAD_EVENT', fails(check_handoff.check(self.run, 'scout')))
        self.r.output(self.run, primary_leads=[{'event_id': self.eid, 'agency': ' ', 'document_hint': 'd'}])
        self.assertIn('PRIMARY_LEAD_INVALID', fails(check_handoff.check(self.run, 'scout')))

    def test_a_high_materiality_report_without_a_lead_is_flagged_not_refused(self):
        self.r.output(self.run)
        found = check_handoff.check(self.run, 'scout')
        self.assertEqual(fails(found), set())
        self.assertIn('MEDIA_EVENT_NO_LEAD', codes(found))
        self.r.output(self.run, open_questions=[f'{self.eid}: no primary document is expected; the agency has not commented'])
        self.assertNotIn('MEDIA_EVENT_NO_LEAD', codes(check_handoff.check(self.run, 'scout')))
        self.r.output(self.run, primary_leads=[{'event_id': self.eid, 'agency': 'Synthetic Agency', 'document_hint': 'the final rule'}])
        self.assertNotIn('MEDIA_EVENT_NO_LEAD', codes(check_handoff.check(self.run, 'scout')))


class FollowUpTests(unittest.TestCase):
    def setUp(self):
        self.r = LaneRuns()
        self.addCleanup(self.r.close)
        self.leads = [{'lead_id': 'L001', 'event_id': 'E001', 'title': TITLE, 'date': DATE, 'side': 'us',
                       'agency': 'Synthetic Agency', 'document_hint': 'the final rule'},
                      {'lead_id': 'L002', 'event_id': 'E002', 'title': 'Synthetic ministry export notice', 'date': '2030-03-07', 'side': 'us',
                       'agency': 'Synthetic Ministry', 'document_hint': 'the notice'}]
        self.run = self.r.lane_task('us-official-2', 'official', primary_leads=self.leads)
        self.r.narrative(self.run)

    def test_every_lead_gets_a_result(self):
        eid = self.r.official(self.run)
        self.r.narrative(self.run)
        self.r.output(self.run, lead_results=[{'lead_id': 'L001', 'outcome': 'found', 'event_id': eid, 'note': 'Final rule'}])
        self.assertIn('LEAD_RESULT_MISSING', fails(check_handoff.check(self.run, 'scout')))
        self.r.output(self.run, lead_results=[{'lead_id': 'L001', 'outcome': 'found', 'event_id': eid, 'note': 'Final rule'},
                                              {'lead_id': 'L002', 'outcome': 'not_found', 'note': ''}])
        self.assertIn('LEAD_RESULT_NOTE', fails(check_handoff.check(self.run, 'scout')))
        self.r.output(self.run, lead_results=[{'lead_id': 'L001', 'outcome': 'found', 'event_id': eid, 'note': 'Final rule'},
                                              {'lead_id': 'L002', 'outcome': 'not_found', 'note': 'Searched the ministry list for March'},
                                              {'lead_id': 'L009', 'outcome': 'not_found', 'note': 'x'}])
        self.assertEqual(fails(check_handoff.check(self.run, 'scout')), {'LEAD_RESULT_UNASSIGNED'})

    def test_a_found_lead_must_match_the_reported_event_and_rest_on_a_primary_claim(self):
        eid = self.r.official(self.run, date='2030-03-05')
        self.r.narrative(self.run)
        self.r.output(self.run, lead_results=[{'lead_id': 'L001', 'outcome': 'found', 'event_id': eid, 'note': 'n'},
                                              {'lead_id': 'L002', 'outcome': 'found', 'event_id': 'E077', 'note': 'n'}])
        found = fails(check_handoff.check(self.run, 'scout'))
        self.assertIn('LEAD_RESULT_MISMATCH', found)
        self.assertIn('LEAD_RESULT_EVENT', found)

    def test_a_found_lead_joins_the_reported_event_in_the_leads_run(self):
        """Media reports, a follow-up finds the document: the lead's run has one event with both, labelled as sourced."""
        lead = self.r.task('us-lead')
        media = self.r.lane_task('us-media', 'media')
        self.r.reported(media)
        self.r.narrative(media)
        self.r.output(media, primary_leads=[{'event_id': 'E001', 'agency': 'Synthetic Agency', 'document_hint': 'the final rule'}])
        self.assertEqual(fails(check_handoff.check(media, 'scout')), set())
        merge_runs.merge(lead, 'us-media', media)
        before = jload(lead / 'events.json')['events']
        self.assertEqual(len(before), 1)

        eid = self.r.official(self.run)
        self.r.narrative(self.run)
        self.r.output(self.run, lead_results=[{'lead_id': 'L001', 'outcome': 'found', 'event_id': eid, 'note': 'Final rule'},
                                              {'lead_id': 'L002', 'outcome': 'not_found', 'note': 'Searched the ministry list'}])
        self.assertEqual(fails(check_handoff.check(self.run, 'scout')), set())
        out = merge_runs.merge(lead, 'us-official-2', self.run)
        self.assertEqual(out['joined_events'], [{'event': before[0]['id'], 'from': eid}])
        events, _, claims, risk, _ = brief.snapshot_state(lead)
        [event] = events['events']
        self.assertEqual(len(event['claim_ids']), 2)
        self.assertEqual({p['task'] for p in event['provenance']}, {'us-media', 'us-official-2'})
        self.assertEqual(brief.evidence_status(event, claims, risk), 'supported')


if __name__ == '__main__':
    unittest.main()
