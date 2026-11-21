"""The multi-agent gap round: which coverage gaps the rules find, how a lead's report on them is checked, and how
the result reaches the sign-off sheet.

Synthetic .invalid / example sources and fictitious content only. Nothing here fetches a page.
"""
import json
from pathlib import Path
import sys
import unittest

from test_multi_agent import Runs, call, codes, jload, jsave

SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL / 'scripts'))
import check_handoff  # noqa: E402
import gaps  # noqa: E402
import merge_runs  # noqa: E402
from signoff import render_signoff  # noqa: E402

PLAN = {'focus': 'Synthetic focus',
        'countries': {'us': {'brief': 'US', 'categories': ['export_controls_sanctions'], 'cases': ['A001']},
                      'cn': {'brief': 'CN', 'categories': ['ai_models_capabilities'], 'cases': ['A002']}}}


def by_type(result):
    out = {}
    for g in result['gaps']:
        out.setdefault(g['type'], []).append(g)
    return out


class GapRulesTests(unittest.TestCase):
    def setUp(self):
        self.r = Runs()
        self.addCleanup(self.r.close)
        self.run = self.r.root
        jsave(self.run / 'plan.json', PLAN)

    def test_unfollowed_cases_and_an_empty_side_are_found_highest_first(self):
        self.r.rule(self.run)  # a US event with an official source
        result = gaps.compute(self.run)
        found = by_type(result)
        self.assertEqual({g['target']['case_id'] for g in found['case_unfollowed']}, {'A001', 'A002'})
        self.assertEqual([g['side'] for g in found['side_empty']], ['cn'])
        self.assertEqual(found['side_empty'][0]['suggested_source'], 'chinese_language')
        self.assertEqual([g['gap_id'] for g in result['gaps']], [f'G{i:03d}' for i in range(1, len(result['gaps']) + 1)])
        priorities = [g['priority'] for g in result['gaps']]
        self.assertEqual(priorities, sorted(priorities, reverse=True))
        self.assertIn('category_empty', result['skipped_types'])  # no event carries a category yet

    def test_a_case_counts_as_followed_with_a_claim_an_origin_or_a_reason(self):
        eid = self.r.rule(self.run)
        events = jload(self.run / 'events.json')
        next(e for e in events['events'] if e['id'] == eid)['case_id'] = 'A001'
        events['events'].append({'id': 'E009', 'title': 'Case A002', 'case_id': 'A002', 'decision': None, 'reason': '', 'claim_ids': []})
        jsave(self.run / 'events.json', events)
        self.assertEqual([g['target']['case_id'] for g in by_type(gaps.compute(self.run)).get('case_unfollowed', [])], ['A002'])
        # A placeholder the chief decided with a reason, or one a lead's research touched, is followed.
        events['events'][-1].update(decision='exclude', reason='No update in the window: MOFCOM list checked')
        jsave(self.run / 'events.json', events)
        self.assertNotIn('case_unfollowed', by_type(gaps.compute(self.run)))
        events['events'][-1].update(decision=None, reason='', provenance=[{'task': 'cn-lead', 'id': 'E003'}])
        jsave(self.run / 'events.json', events)
        self.assertNotIn('case_unfollowed', by_type(gaps.compute(self.run)))

    def test_a_high_materiality_event_with_only_media_sources_is_a_gap(self):
        self.r.rule(self.run)
        news = self.r.news(self.run)
        found = by_type(gaps.compute(self.run))
        self.assertEqual([g['target']['event_id'] for g in found['single_source']], [news])
        self.assertEqual(found['single_source'][0]['suggested_source'], 'official_document')

    def test_discovery_candidates_are_gaps_only_when_ranked_or_official_and_not_in_the_records(self):
        self.r.rule(self.run)
        (self.run / 'discovery').mkdir()
        cand = lambda i, url, official=False: {'id': f'D{i:03d}', 'title': f'Candidate {i}', 'side': 'us',
                                               'relevance': {'official_source': official}, 'items': [{'url': url}]}
        jsave(self.run / 'discovery' / 'events.json', {'candidates': [
            cand(1, 'http://www.example.gov/rule/'),         # already in the records, spelled differently
            cand(2, 'https://www.example.gov/other-notice'),  # ranked, not in the records
            cand(3, 'https://news.example/late'),             # beyond the top, not official
            cand(4, 'https://www.example.gov/late-notice', official=True)]})
        found = by_type(gaps.compute(self.run, discovery_top=2))
        self.assertEqual([(g['target']['candidate_id'], g['priority']) for g in found['discovery_unhandled']], [('D004', 4), ('D002', 3)])

    def test_a_leads_own_gaps_and_open_questions_are_listed(self):
        lead = self.r.task('us-lead')
        jsave(lead / 'output.json', {'gaps': [{'task_id': 'us-s02', 'topic': 'Entity list', 'reason': 'scout timed out'}, {'reason': ' '}],
                                     'open_questions': ['Has the licence policy changed?']})
        found = by_type(gaps.compute(self.run, {'us': lead}))
        self.assertCountEqual([g['target'] for g in found['declared']], [{'topic': 'Entity list', 'task_id': 'us-s02'},
                                                                         {'question': 'Has the licence policy changed?'}])

    def test_empty_planned_categories_are_found_once_events_carry_categories(self):
        eid = self.r.rule(self.run)
        events = jload(self.run / 'events.json')
        events['events'][0]['category'] = 'export_controls_sanctions'
        jsave(self.run / 'events.json', events)
        result = gaps.compute(self.run)
        self.assertEqual([(g['side'], g['target']['category']) for g in by_type(result)['category_empty']], [('cn', 'ai_models_capabilities')])
        self.assertNotIn('category_empty', result['skipped_types'])
        self.assertTrue(eid)

    def test_the_list_is_capped_and_says_how_many_were_left_out(self):
        result = gaps.compute(self.run, max_listed=2)
        self.assertEqual(len(result['gaps']), 2)
        self.assertEqual(result['not_listed'], sum(result['counts'].values()) - 2)

    def test_cli_prints_one_json_line(self):
        lead = self.r.task('us-lead')
        jsave(lead / 'output.json', {'gaps': [], 'open_questions': ['Q?']})
        code, out = call('gaps', self.run, '--lead', f'us={lead}', '--max', '5')
        self.assertEqual(code, 0)
        doc = json.loads(out.strip().splitlines()[-1])
        self.assertTrue(any(g['type'] == 'declared' for g in doc['gaps']))
        code, _ = call('gaps', self.run, '--lead', 'mars=x')
        self.assertEqual(code, 2)


class CategoryTests(unittest.TestCase):
    def setUp(self):
        self.r = Runs()
        self.addCleanup(self.r.close)

    def test_event_category_is_validated_recorded_and_merged(self):
        task = self.r.task('us-s01')
        code, out = call('event', task, 'add', '--title', 'Synthetic', '--date', '2030-03-06', '--side', 'us', '--category', 'nonsense')
        self.assertEqual(code, 1, out)
        self.assertIn('--category must be one of', out)
        call('event', task, 'add', '--title', 'Synthetic rule', '--date', '2030-03-06', '--side', 'us', '--category', 'export_controls_sanctions')
        call('event', task, 'decide', 'E001', 'track', '--reason', 'Synthetic', '--category', 'policy_regulation')
        self.assertEqual(jload(task / 'events.json')['events'][0]['category'], 'policy_regulation')
        merge_runs.merge(self.r.root, 'us-s01', task)
        self.assertEqual(jload(self.r.root / 'events.json')['events'][0]['category'], 'policy_regulation')


class GapCheckTests(unittest.TestCase):
    """A lead reopened for the gap round reports what it did; the records must show it."""

    def setUp(self):
        self.r = Runs()
        self.addCleanup(self.r.close)
        self.lead = self.r.task('us-lead')
        self.news = self.r.news(self.lead, decision='track')  # media-only, before the round
        self.round = Path(self.r.tmp.name) / 'gap_report.json'
        events = jload(self.lead / 'events.json')
        ledger = jload(self.lead / 'evidence_ledger.json')
        self.gaps = [
            {'gap_id': 'G001', 'type': 'case_unfollowed', 'side': 'us', 'target': {'case_id': 'A001'}},
            {'gap_id': 'G002', 'type': 'single_source', 'side': 'cn', 'target': {'event_id': 'E007', 'origin': [{'task': 'us-lead', 'id': self.news}]}},
            {'gap_id': 'G003', 'type': 'declared', 'side': 'us', 'target': {'question': 'Q?'}},
            {'gap_id': 'G004', 'type': 'side_empty', 'side': 'us', 'target': {'side': 'us'}},
            {'gap_id': 'G005', 'type': 'discovery_unhandled', 'side': 'us', 'target': {'candidate_id': 'D002', 'urls': ['https://www.example.gov/rule']}},
        ]
        jsave(self.round, {'gaps': self.gaps, 'leads': {'us-lead': {'gaps': [g['gap_id'] for g in self.gaps], 'baseline': {
            'events': [e['id'] for e in events['events']], 'claims': [c['id'] for c in ledger['claims']], 'searches': len(events.get('searches') or [])}}}})

    def report(self, results):
        jsave(self.lead / 'output.json', {'task_id': 'us-lead', 'gap_results': results})
        return gaps.check_round(self.round, self.lead, 'us-lead')['results']

    def test_filled_gaps_hold_only_when_new_records_of_the_right_kind_are_listed(self):
        rule = self.r.rule(self.lead)  # new, official, US side, from example.gov/rule
        events = jload(self.lead / 'events.json')
        next(e for e in events['events'] if e['id'] == rule)['case_id'] = 'A001'
        jsave(self.lead / 'events.json', events)
        rule_claim = jload(self.lead / 'events.json')['events'][-1]['claim_ids'][0]
        results = self.report([
            {'gap_id': 'G001', 'outcome': 'filled', 'event_ids': [rule]},
            {'gap_id': 'G002', 'outcome': 'filled', 'event_ids': [self.news]},  # still media-only
            {'gap_id': 'G003', 'outcome': 'filled', 'claim_ids': [rule_claim]},
            {'gap_id': 'G005', 'outcome': 'filled', 'event_ids': [rule]},
        ])
        self.assertEqual(results['G001']['outcome'], 'filled')
        self.assertEqual(results['G002']['outcome'], 'filled_unconfirmed')
        self.assertIn('none of the listed events or claims is new', results['G002']['detail'])
        self.assertEqual(results['G003']['outcome'], 'filled')
        self.assertEqual(results['G004'], {'outcome': 'not_reached', 'detail': 'the lead did not report this gap'})
        self.assertEqual(results['G005']['outcome'], 'filled')
        # The media-only event gets a new claim: a media one does not fill it, an official one does.
        news_source = next(e for e in jload(self.lead / 'events.json')['events'] if e['id'] == self.news)['sources'][0]
        call('add-claim', self.lead, self.news, news_source, '--quote', 'halted shipments of synthetic wafers',
             '--text', 'Synthetic Daily reported that Synthetic Foundry halted shipments of synthetic wafers.')
        self.assertIn('official, company or dataset', self.report([{'gap_id': 'G002', 'outcome': 'filled', 'event_ids': [self.news]}])['G002']['detail'])
        rule_source = next(e for e in jload(self.lead / 'events.json')['events'] if e['id'] == rule)['sources'][0]
        code, out = call('add-claim', self.lead, self.news, rule_source, '--quote', 'today issued a proposed rule on synthetic accelerators',
                         '--text', 'The Synthetic Agency issued a proposed rule on synthetic accelerators.')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.report([{'gap_id': 'G002', 'outcome': 'filled', 'event_ids': [self.news]}])['G002']['outcome'], 'filled')

    def test_an_old_or_unknown_record_does_not_fill_a_gap(self):
        results = self.report([{'gap_id': 'G003', 'outcome': 'filled', 'event_ids': [self.news]},
                               {'gap_id': 'G004', 'outcome': 'filled', 'event_ids': ['E099']}])
        self.assertIn('none of the listed events or claims is new', results['G003']['detail'])
        self.assertIn('E099', results['G004']['detail'])

    def test_nothing_found_needs_logged_searches(self):
        listed = ['federalregister.gov: synthetic rule', 'agency press releases']
        results = self.report([{'gap_id': 'G001', 'outcome': 'searched_none', 'searched': listed, 'note': 'No notice'}])
        self.assertEqual(results['G001']['outcome'], 'not_searched')
        for query in listed:
            call('search', self.lead, query, '--found', 'nothing in the window')
        results = self.report([{'gap_id': 'G001', 'outcome': 'searched_none', 'searched': listed, 'note': 'No notice'},
                               {'gap_id': 'G004', 'outcome': 'not_reached', 'reason': 'time budget'}])
        self.assertEqual(results['G001']['outcome'], 'searched_none')
        self.assertEqual(results['G004'], {'outcome': 'not_reached', 'detail': 'time budget'})

    def test_the_lead_handoff_refuses_malformed_gap_results(self):
        self.r.narrative(self.lead)
        jsave(self.lead / 'output.json', {'task_id': 'us-lead', 'gap_results': [
            {'gap_id': 'G001', 'outcome': 'filled'}, {'gap_id': 'G001', 'outcome': 'searched_none', 'searched': ['one']},
            {'gap_id': 'X', 'outcome': 'filled'}, {'gap_id': 'G003', 'outcome': 'not_reached'}, {'gap_id': 'G004', 'outcome': 'maybe'}]})
        fails = [i['message'] for i in check_handoff.check(self.lead, 'lead') if i['code'] == 'GAP_RESULTS']
        self.assertEqual(len(fails), 6, fails)
        jsave(self.lead / 'output.json', {'task_id': 'us-lead', 'gap_results': [{'gap_id': 'G003', 'outcome': 'not_reached', 'reason': 'time'}]})
        self.assertNotIn('GAP_RESULTS', codes(check_handoff.check(self.lead, 'lead')))


class SignoffTests(unittest.TestCase):
    def test_skipped_cases_and_empty_sides_come_first(self):
        report = {'not_listed': 1, 'gaps': [
            {'gap_id': 'G002', 'type': 'single_source', 'side': 'cn', 'target': {'event_id': 'E004', 'title': 'Foundry halt'},
             'outcome': 'searched_none', 'detail': '2 search(es) logged since the reopening'},
            {'gap_id': 'G001', 'type': 'case_unfollowed', 'side': 'us', 'target': {'case_id': 'A001', 'question': 'Rule extended?'},
             'outcome': 'skipped', 'detail': 'Covered by E002 already'}]}
        text = render_signoff({'claims': []}, {}, 'r', 'l', gaps=report)
        self.assertIn('## 补搜（缺口检查）', text)
        self.assertIn('另有 1 个未列出', text)
        first = text.index('### 先看')
        self.assertLess(first, text.index('G001'))
        self.assertLess(text.index('G001'), text.index('### 其余缺口'))
        self.assertLess(text.index('### 其余缺口'), text.index('G002'))
        self.assertIn('主编决定不补：Covered by E002 already', text)
        self.assertNotIn('补搜', render_signoff({'claims': []}, {}, 'r', 'l'))


if __name__ == '__main__':
    unittest.main()
