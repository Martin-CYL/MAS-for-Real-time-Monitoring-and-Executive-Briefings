"""Independent verification in the multi-agent workflow: which claims are chosen, what a verifier must hand in,
and how its results reach the report labels and the sign-off sheet.

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
from check_report import validate_report  # noqa: E402

ENACTED_RULE = 'The Synthetic Agency today issued a final rule that adds Synthetic Foundry to the synthetic entity list.'


class SelectionTests(unittest.TestCase):
    def setUp(self):
        self.r = Runs()
        self.addCleanup(self.r.close)

    def test_high_risk_and_status_deciding_claims_are_chosen_without_their_sources(self):
        run = self.r.root
        self.r.rule(run)  # proposed: its claim decides the "pending" label
        self.r.news(run, decision='track')  # a plain media claim of low risk
        eid = self.r.event(run, 'https://www.example.gov/list', ENACTED_RULE, 'Synthetic agency adds foundry to entity list',
                           'adds Synthetic Foundry to the synthetic entity list',
                           'The Synthetic Agency added Synthetic Foundry to the synthetic entity list.')
        led = jload(run / 'evidence_ledger.json')
        listed = next(c for c in led['claims'] if 'entity list' in c['text'])
        listed['kinds'] = ['list']
        listed['recorded_sha'] = brief.ev.fingerprint(listed)
        jsave(run / 'evidence_ledger.json', led)
        targets, left = brief.verification_targets(run, 12)
        by = {t['claim_id']: t for t in targets}
        self.assertEqual(left, 0)
        self.assertEqual(targets[0]['claim_id'], listed['id'])  # highest risk first
        self.assertEqual(by[listed['id']]['event_id'], eid)
        self.assertEqual({t['asserted_status'] for t in targets}, {'proposed', 'official'})
        self.assertNotIn('According to Reuters', json.dumps(targets))
        for t in targets:
            self.assertFalse({'sources', 'quote', 'url', 'anchor'} & set(t), t)
        capped, rest = brief.verification_targets(run, 1)
        self.assertEqual((len(capped), rest), (1, len(targets) - 1))

    def test_cli_prints_json(self):
        self.r.rule(self.r.root)
        code, out = call('verify-select', self.r.root, '--max', '5')
        self.assertEqual(code, 0)
        self.assertEqual(len(json.loads(out)['claims']), 1)


class VerifierHandoffTests(unittest.TestCase):
    def setUp(self):
        self.r = Runs()
        self.addCleanup(self.r.close)
        self.task = self.r.task('verify-1')
        assignment = jload(self.task / 'assignment.json')
        assignment['claims'] = [{'claim_id': 'C002', 'text': 'x'}, {'claim_id': 'C005', 'text': 'y'}]
        jsave(self.task / 'assignment.json', assignment)

    def write(self, results):
        jsave(self.task / 'verification.json', {'results': results})
        return check_handoff.check(self.task, 'verifier')

    def test_every_assigned_claim_needs_a_verdict_with_own_evidence(self):
        self.r.rule(self.task)  # the verifier's own record: C001
        items = self.write([{'claim_id': 'C002', 'verdict': 'status_differs', 'evidence': ['C001'], 'note': 'The rule is only proposed.'}])
        self.assertIn('VERIFICATION_INCOMPLETE', codes(i for i in items if i['status'] == 'FAIL'))
        items = self.write([{'claim_id': 'C002', 'verdict': 'status_differs', 'evidence': ['C001'], 'note': 'The rule is only proposed.'},
                            {'claim_id': 'C005', 'verdict': 'not_found', 'note': 'No notice found on the agency site.'}])
        self.assertEqual([i for i in items if i['status'] == 'FAIL'], [])
        self.assertIn('HANDOFF_RECORDS', codes(items))

    def test_verdicts_without_evidence_or_with_foreign_evidence_are_refused(self):
        items = self.write([{'claim_id': 'C002', 'verdict': 'confirmed', 'note': 'Looks right.'},
                            {'claim_id': 'C005', 'verdict': 'contradicted', 'evidence': ['C009'], 'note': 'Other date.'}])
        fails = [i for i in items if i['status'] == 'FAIL']
        self.assertEqual(sum(1 for i in fails if i['code'] == 'VERIFICATION_EVIDENCE'), 2)

    def test_unassigned_claims_unknown_verdicts_and_missing_file_are_refused(self):
        items = self.write([{'claim_id': 'C001', 'verdict': 'confirmed', 'evidence': [], 'note': 'n'},
                            {'claim_id': 'C002', 'verdict': 'probably', 'note': 'n'},
                            {'claim_id': 'C005', 'verdict': 'not_found', 'note': ''}])
        self.assertTrue({'VERIFICATION_UNASSIGNED', 'VERIFICATION_VERDICT', 'VERIFICATION_NOTE'} <= codes(items))
        (self.task / 'verification.json').unlink()
        self.assertIn('VERIFICATION_MISSING', codes(check_handoff.check(self.task, 'verifier')))


class LabelTests(unittest.TestCase):
    def setUp(self):
        self.r = Runs()
        self.addCleanup(self.r.close)

    def build(self, verification=None):
        run = self.r.root
        eid = self.r.event(run, 'https://www.example.gov/list', ENACTED_RULE, 'Synthetic agency adds foundry to entity list',
                           'adds Synthetic Foundry to the synthetic entity list',
                           'The Synthetic Agency added Synthetic Foundry to the synthetic entity list.')
        led = jload(run / 'evidence_ledger.json')
        led['claims'][0]['kinds'] = ['list']
        led['claims'][0]['recorded_sha'] = brief.ev.fingerprint(led['claims'][0])
        led['generated_at'] = '2030-03-10T19:00:00+08:00'
        jsave(run / 'evidence_ledger.json', led)
        self.r.news(run, decision='track')
        events = jload(run / 'events.json')
        events['events'].append({'id': 'E099', 'title': 'Synthetic export licence decision', 'date': '2030-03-08', 'side': 'cn', 'sources': [],
                                 'materiality': 'high', 'decision': 'track', 'reason': 'No official decision published yet',
                                 'claim_ids': [], 'unsupported': True, 'followup': 'April 2030'})
        jsave(run / 'events.json', events)
        for q in ('q1', 'q2', 'q3'):
            call('search', run, q)
        self.r.report_json(run, eid)
        if verification:
            jsave(run / 'claim_verification.json', {'claims': verification})
        call('build', run)
        return (run / 'report.html').read_text(encoding='utf-8')

    def story_labels(self, html):
        article = html[html.index('<article class="story">'):]
        return [x.split('"')[0] for x in article[:article.index('</h3>')].split('class="st ')[1:]]

    def test_unsourced_tracked_item_is_unverified_not_a_media_report(self):
        html = self.build()
        row = html[html.index('Synthetic export licence decision'):]
        self.assertIn('<i class="dot u"></i>', row[:row.index('</tr>')])
        self.assertIn('<i class="dot u"></i>No supporting source located', html)
        report = validate_report(html, '2030-03-10', SKILL / 'references' / 'glossary.md')
        self.assertFalse([x for x in report if x['status'] == 'FAIL' and x['code'].startswith(('STATUS', 'LEGEND'))], report)

    def test_without_verification_a_primary_list_claim_is_confirmed(self):
        self.assertEqual(self.story_labels(self.build()), ['confirmed'])

    def test_a_list_claim_the_verifier_could_not_support_is_not_shown_as_confirmed(self):
        html = self.build({'C001': {'status': 'not_found', 'by': 'verify-1', 'note': 'No list entry found.'}})
        self.assertEqual(self.story_labels(html), ['unverified'])
        self.assertIn('an independent check found no source for a key claim', html)
        signoff = (self.r.root / 'qa' / 'signoff.md').read_text(encoding='utf-8')
        self.assertIn('独立核验：独立核验未能找到来源（verify-1）', signoff)

    def test_an_independent_confirmation_keeps_the_label(self):
        html = self.build({'C001': {'status': 'independent', 'by': 'verify-1'}})
        self.assertEqual(self.story_labels(html), ['confirmed'])


if __name__ == '__main__':
    unittest.main()
