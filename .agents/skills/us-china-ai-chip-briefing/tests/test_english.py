"""English-language report support: the validator accepts English wording without loosening any rule.

Synthetic fixture only (.invalid URLs, fictitious 2030 dates). Chinese reports remain covered by the older tests.
"""
from pathlib import Path
import sys
import unittest

SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL / 'scripts'))
from check_report import validate_report  # noqa: E402
from check_dates import validate_dates  # noqa: E402
from check_quotes import claim_signals, load_domains  # noqa: E402

GLOSSARY = SKILL / 'references' / 'glossary.md'
EN = """<!doctype html><html lang="en"><head><meta charset="utf-8"><title>US-China AI &amp; Semiconductor Risk Briefing | 2030.01.02</title></head><body>
<div class="mastmeta"><strong data-report-date="2030-01-02">2030.01.02</strong></div>
<p class="issue">EXECUTIVE RISK &amp; TECHNOLOGY BRIEFING / January 2, 2030 / Data as of January 1, 2030</p>
<section class="takeaways"><div class="label">Three key judgments</div><div class="summary"><b>Synthetic one</b>Synthetic text one.</div>
<div class="summary"><b>Synthetic two</b>Synthetic text two.</div><div class="summary"><b>Synthetic three</b>Synthetic text three.</div></section>
<div class="panel"><div class="micro">MONITORING STATUS / Event status</div><table><tr><td>Synthetic item</td><td>Synthetic state</td></tr></table>
<div class="status-key"><span><i class="dot g"></i>Official or company announcement</span><span><i class="dot a"></i>Media report, not independently confirmed</span><span><i class="dot s"></i>Proposed, pending approval or not yet in force</span></div></div>
<article class="story"><span class="st reported">Media report, not independently confirmed</span>
<p>The US Bureau of Industry and Security (BIS) is a synthetic test subject here. <span data-claim-id="C001">The synthetic chip completed 12 runs in the test.</span></p>
<a href="https://fixture.invalid/source">Synthetic source</a></article>
<p>Management view: synthetic text four.</p>
<footer>PUBLIC-SOURCE RISK INTELLIGENCE · 02 JAN 2030</footer></body></html>"""
codes = lambda items: {x['code'] for x in items}


class EnglishReportTests(unittest.TestCase):
    def test_complete_english_report_has_no_failures(self):
        r = validate_report(EN, '2030-01-02', GLOSSARY)
        self.assertFalse([x for x in r if x['status'] == 'FAIL'], r)
        self.assertIn('DATES', codes(r))
        self.assertNotIn('FIRST_USE', codes(r))  # "the US Bureau of Industry and Security (BIS)"

    def test_english_dates_are_compared_across_regions(self):
        r = validate_report(EN.replace('January 2, 2030 /', 'January 3, 2030 /'), '2030-01-02')
        self.assertIn('DATE_CONFLICT', codes(r))

    def test_missing_english_sections_fail(self):
        broken = EN.replace('Three key judgments', 'Three principles').replace('Management view', 'Closing note')
        missing = {x['field'] for x in validate_report(broken, '2030-01-02') if x['code'] == 'SECTION_MISSING'}
        self.assertTrue({'本期三个判断', '管理层参考'} <= missing, missing)

    def test_unexplained_english_acronym_is_flagged(self):
        r = validate_report(EN.replace('Synthetic text one.', 'HBM supply tightened.'), '2030-01-02', GLOSSARY)
        self.assertIn('HBM', {x.get('term') for x in r if x['code'] == 'FIRST_USE'})

    def test_common_abbreviations_need_no_explanation(self):
        r = validate_report(EN.replace('Synthetic text one.', 'The US and EU met; the CEO spoke.'), '2030-01-02', GLOSSARY)
        self.assertFalse({'US', 'EU', 'CEO'} & {x.get('term') for x in r if x['code'] == 'FIRST_USE'})

    def test_verified_claims_fail_but_negations_do_not(self):
        self.assertNotIn('VERIFIED_WORDING', codes(validate_report(EN, '2030-01-02')))
        for bad in ('All figures were verified.', 'This is a fully verified report.'):
            self.assertIn('VERIFIED_WORDING', codes(validate_report(EN.replace('Synthetic text two.', bad), '2030-01-02')), bad)
        for ok in ('The figure is unverified.', 'The claim has not been independently verified.', 'It could not be verified.'):
            self.assertNotIn('VERIFIED_WORDING', codes(validate_report(EN.replace('Synthetic text two.', ok), '2030-01-02')), ok)

    def test_legend_label_mismatch_still_fails_in_english(self):
        r = validate_report(EN.replace('<span class="st reported">', '<span class="st confirmed">')
                              .replace('<span class="st confirmed">Media report, not independently confirmed', '<span class="st confirmed">Media report'), '2030-01-02')
        self.assertIn('STATUS_MISMATCH', codes(r))

    def test_english_cutoff_is_checked_against_ledger(self):
        ledger = {'schema_version': 1, 'fixture': True, 'author': 'a', 'report_date': '2030-01-02', 'timezone': 'Asia/Hong_Kong',
                  'cutoff': '2030-01-01T23:59:59+08:00', 'generated_at': '2030-01-02T09:00:00+08:00', 'claims': []}
        self.assertNotIn('HTML_CUTOFF_MISMATCH', codes(validate_dates(EN, ledger, None, '2030-01-03T00:00:00+00:00')))
        wrong = EN.replace('Data as of January 1, 2030', 'Data as of December 30, 2029')
        self.assertIn('HTML_CUTOFF_MISMATCH', codes(validate_dates(wrong, ledger, None, '2030-01-03T00:00:00+00:00')))


class EnglishClaimTests(unittest.TestCase):
    D = load_domains()

    def sig(self, text, quote, pub='2026-10-08', event='2026-10-08', etype='company_statement', url='https://example.invalid/a'):
        c = {'text': text, 'event_date': event, 'kinds': ['factual'],
             'sources': [{'url': url, 'quote': quote, 'publication_date': pub, 'evidence_type': etype}]}
        return {code for code, _ in claim_signals(c, self.D)}

    def test_english_claim_date_backed_by_recorded_date(self):
        self.assertNotIn('NUMBER_NOT_IN_QUOTE', self.sig('The two companies announced the agreement on October 8, 2026.', 'today announced an agreement'))
        self.assertNotIn('NUMBER_NOT_IN_QUOTE', self.sig('The rule was published on 8 October 2026.', 'the rule is published today'))

    def test_figure_in_english_claim_still_needs_quote(self):
        self.assertIn('NUMBER_NOT_IN_QUOTE', self.sig('On October 8, 2026 the company raised $10 billion.', 'the company announced financing'))

    def test_english_legal_wording_raises_risk(self):
        self.assertIn('KIND_UNDERSTATED', self.sig('A contractor pleaded guilty to violating export controls.', 'pleaded guilty to violating export controls'))


if __name__ == '__main__':
    unittest.main()
