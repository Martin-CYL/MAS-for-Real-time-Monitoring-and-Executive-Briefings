"""Round 4 regressions: lightweight-model failure modes, readiness levels and the staged pipeline.

Fixture `lightweight_model_report.html` is a real report written by a lightweight model (2026-10-15). It is a
regression sample of structure and wording only, never a factual source; these tests never fetch its links.
"""
import io
import os
import json
from contextlib import redirect_stdout
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import unittest.mock

SKILL = Path(__file__).resolve().parents[1]
FIX = SKILL / 'tests' / 'fixtures'
sys.path.insert(0, str(SKILL / 'scripts'))

from check_report import validate_report  # noqa: E402
from check_quotes import claim_signals, load_domains  # noqa: E402
from qa_common import readiness, category, fix_lines, finding  # noqa: E402
from validate import run_all  # noqa: E402
import brief  # noqa: E402

LIGHT = (FIX / 'lightweight_model_report.html').read_text(encoding='utf-8')
GOOD = (FIX / 'synthetic_report.html').read_text(encoding='utf-8')
codes = lambda items: {x['code'] for x in items}
NOW = '2026-10-14T12:00:00+00:00'


class LightweightReportTests(unittest.TestCase):
    """The weak report passed every structural check before round 4."""

    def test_missing_sections_are_rule_violations(self):
        r = validate_report(LIGHT, '2026-10-15')
        missing = {x['field'] for x in r if x['code'] == 'SECTION_MISSING'}
        self.assertTrue({'本期三个判断', '事件状态表', '状态图例'} <= missing, missing)

    def test_custom_badges_cannot_bypass_status_checks(self):
        self.assertIn('STATUS_LABELS_MISSING', codes(validate_report(LIGHT, '2026-10-15')))
        bypass = GOOD.replace('class="st confirmed"', 'class="badge"')
        self.assertIn('STATUS_LABELS_MISSING', codes(validate_report(bypass, '2030-01-02')))

    def test_verified_wording_fails_once_with_count(self):
        hits = [x for x in validate_report(LIGHT, '2026-10-15') if x['code'] == 'VERIFIED_WORDING']
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]['status'], 'FAIL')
        self.assertIn('10 times', hits[0]['message'])

    def test_unverified_wording_is_not_flagged(self):
        r = validate_report(GOOD.replace('合成说明一。', '媒体报道或未经独立验证，尚未核验。'), '2030-01-02')
        self.assertNotIn('VERIFIED_WORDING', codes(r))

    def test_no_ledger_is_blocked_with_ledger_fix_first(self):
        result, md, _ = run_all(_tmp(LIGHT), expected_date='2026-10-15', now=NOW)
        self.assertEqual(result['readiness'], 'BLOCKED')
        allx = [x for xs in result['checks'].values() for x in xs]
        self.assertEqual(fix_lines(allx)[0][2], 'LEDGER_MISSING')
        self.assertIn('就绪状态：BLOCKED', md)
        self.assertIn('下一步：按顺序处理', md)


def _tmp(text, suffix='.html'):
    f = tempfile.NamedTemporaryFile('w', suffix=suffix, delete=False, encoding='utf-8')
    f.write(text); f.close()
    return f.name


class ReadinessTests(unittest.TestCase):
    def test_levels_are_distinct(self):
        f = lambda st, code: finding(st, code, 'x')
        self.assertEqual(readiness([f('FAIL', 'QUOTE_NOT_FOUND')])[0], 'BLOCKED')
        self.assertEqual(readiness([f('UNVERIFIED', 'SUPPORT_MISSING')])[0], 'INCOMPLETE')
        self.assertEqual(readiness([f('UNVERIFIED', 'FIRST_USE')])[0], 'INCOMPLETE')
        self.assertEqual(readiness([f('UNVERIFIED', 'BLOCKED'), f('UNVERIFIED', 'CLAIM_REVIEW_PENDING')])[0], 'READY_FOR_HUMAN_REVIEW')
        self.assertEqual(readiness([f('UNVERIFIED', 'HUMAN_SIGNOFF')])[0], 'AWAITING_SIGNOFF')
        self.assertEqual(readiness([f('PASS', 'QUOTE_FOUND')])[0], 'PASS')

    def test_blocked_source_is_access_not_violation(self):
        x = finding('UNVERIFIED', 'BLOCKED', 'HTTP 403', url='https://example.invalid')
        self.assertEqual(category(x), 'source_access')
        self.assertEqual(category(finding('FAIL', 'QUOTE_NOT_FOUND', 'x')), 'rule_violation')

    def test_unknown_unverified_defaults_to_human(self):
        self.assertEqual(category(finding('UNVERIFIED', 'SOMETHING_NEW', 'x')), 'human_review')

    def test_complete_fixture_is_not_blocked(self):
        result, _, _ = run_all(FIX / 'synthetic_report.html', FIX / 'synthetic_ledger.json', expected_date='2030-01-02',
                               coverage_path=FIX / 'synthetic_coverage.json', cases_path='', now='2030-01-03T00:00:00+00:00')
        self.assertNotEqual(result['readiness'], 'BLOCKED', result['categories'])


class NumberSignalTests(unittest.TestCase):
    D = load_domains()

    def sig(self, text, quote, pub='2026-10-08', event='2026-10-08'):
        c = {'text': text, 'event_date': event, 'kinds': ['factual'],
             'sources': [{'url': 'https://example.invalid/a', 'quote': quote, 'publication_date': pub, 'evidence_type': 'company_statement'}]}
        return {code for code, _ in claim_signals(c, self.D)}

    def test_sept_abbreviation(self):
        self.assertNotIn('NUMBER_NOT_IN_QUOTE', self.sig('2026 年 9 月营收 511,857 百万元，增长 54.6%。', 'Sept. | 511,857 | 54.6%'))

    def test_claim_date_backed_by_recorded_date(self):
        self.assertNotIn('NUMBER_NOT_IN_QUOTE', self.sig('双方于 2026 年 10 月 8 日宣布协议。', 'today announced an agreement'))

    def test_figure_still_needs_quote_even_if_it_matches_a_date(self):
        self.assertIn('NUMBER_NOT_IN_QUOTE', self.sig('公司于 2026 年 10 月 8 日获得 10 亿美元投资。', 'today announced an investment'))

    def test_unrecorded_date_still_flagged(self):
        self.assertIn('NUMBER_NOT_IN_QUOTE', self.sig('公司称 2027 年 3 月投产。', 'production will start'))


class PipelineTests(unittest.TestCase):
    """brief.py stages: discovery → selection → evidence → analysis → build. Synthetic .invalid sources only."""

    PAGE = '合成机构今日发布合成规则，自 2026 年 3 月 5 日起实施。该规则适用于合成产品。'

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.run_dir = Path(self.tmp.name) / 'run'
        # A run replayed on 10 March 2026: pages are saved (checked) that day, before the 19:00 build.
        patch = unittest.mock.patch.dict(os.environ, {'BRIEFING_CLOCK': '2026-03-10T12:00:00+08:00'})
        patch.start()
        self.addCleanup(patch.stop)
        self.call('init', str(self.run_dir), '--end', '2026-03-10', '--cutoff', '2026-03-10T18:00:00+08:00')
        led = self.j('evidence_ledger.json'); led['generated_at'] = '2026-03-10T19:00:00+08:00'; self.j('evidence_ledger.json', led)

    def tearDown(self):
        self.tmp.cleanup()

    def call(self, *args):
        out, old = io.StringIO(), sys.argv
        sys.argv = ['brief.py', *args]
        try:
            with redirect_stdout(out):
                code = brief.main()
        finally:
            sys.argv = old
        return code, out.getvalue()

    def j(self, name, obj=None):
        p = self.run_dir / name
        if obj is None:
            return json.loads(p.read_text(encoding='utf-8'))
        p.write_text(json.dumps(obj, ensure_ascii=False), encoding='utf-8')

    def page(self, text=None, name='page.txt'):
        p = Path(self.tmp.name) / name
        p.write_text(text or self.PAGE, encoding='utf-8')
        return str(p)

    def complete(self, url='https://www.example.gov/rule'):
        r = str(self.run_dir)
        self.call('fetch', r, url, '--file', self.page(), '--route', 'http_tool')
        self.call('event', r, 'add', '--title', '合成规则发布', '--date', '2026-03-05', '--side', 'both', '--source', 'S001',
                  '--materiality', 'high', '--why', '合成：影响中美出口管制比较')
        eid = self.j('events.json')['events'][-1]['id']
        for e in self.j('events.json')['events']:
            if e['id'] != eid:
                self.call('event', r, 'decide', e['id'], 'track', '--reason', '合成：无更新', '--side', 'us', '--title', '合成跟踪事项')
        self.call('event', r, 'decide', eid, 'include', '--reason', '合成：本期新规')
        for q in ('q1', 'q2', 'open query'):
            self.call('search', r, q)
        return eid

    def report(self, eid):
        rep = self.j('report.json')
        rep.update(thesis={'lead': '合成规则发布', 'emphasis': '出口管制比较需要更新'}, deck='合成摘要。', management_view='合成：后续文本。',
                   questions=['问一？', '问二？', '问三？'], judgments=[{'title': f'判断{i}', 'text': f'合成判断说明{i}。'} for i in range(1, 4)],
                   stories=[{'event': eid, 'chapter': '政策', 'title': '合成规则', 'impact': '合成：影响评估，涉及 BIS 对比。', 'watch': '3 月 20 日'}])
        self.j('report.json', rep)

    def test_init_computes_window_and_preloads_cases(self):
        cfg = self.j('run_config.json')
        self.assertEqual(cfg['window'], {'start': '2026-03-04', 'end': '2026-03-10'})
        cases = brief.active_cases()
        self.assertEqual([e['case_id'] for e in self.j('events.json')['events']], [c['id'] for c in cases])

    def test_add_claim_locates_quote_and_writes_complete_entry(self):
        eid = self.complete()
        code, out = self.call('add-claim', str(self.run_dir), eid, 'S001', '--quote', '合成机构今日发布合成规则', '--text', '合成机构发布合成规则。')
        self.assertEqual(code, 0, out)
        c = self.j('evidence_ledger.json')['claims'][0]
        s = c['sources'][0]
        self.assertEqual((s['evidence_type'], s['source_role'], s['access_status']), ('official_document', 'primary', 'opened'))
        self.assertEqual(s['snapshot']['path'], 'sources/S001.txt')
        self.assertIn('C001', self.j('events.json')['events'][-1]['claim_ids'])

    def test_hand_edited_claim_is_reported(self):
        eid = self.complete()
        self.call('add-claim', str(self.run_dir), eid, 'S001', '--quote', '合成机构今日发布合成规则', '--text', '合成机构发布合成规则。')
        led = self.j('evidence_ledger.json'); led['claims'][0]['sources'][0]['publication_date'] = '2026-03-01'; self.j('evidence_ledger.json', led)
        self.report(eid)
        _, out = self.call('build', str(self.run_dir))
        self.assertIn('changed by hand', out); self.assertIn('C001', out)

    def test_a_tracked_rows_status_claims_are_printed_with_their_sources(self):
        r = str(self.run_dir)
        eid = self.complete()
        self.call('add-claim', r, eid, 'S001', '--quote', '合成机构今日发布合成规则', '--text', '合成机构发布合成规则。')
        tracked = self.j('events.json')['events'][0]['id']
        code, out = self.call('add-claim', r, tracked, 'S001', '--quote', '该规则适用于合成产品', '--text', '该规则适用于合成产品。')
        self.assertEqual(code, 0, out)
        code, out = self.call('event', r, 'decide', tracked, 'track', '--reason', '合成：仍在跟踪', '--status-claim', 'C001')
        self.assertEqual(code, 1); self.assertIn('not a claim of', out)
        self.assertEqual(self.call('event', r, 'decide', tracked, 'track', '--reason', '合成：仍在跟踪', '--status-claim', 'C002')[0], 0)
        self.assertEqual(self.j('events.json')['events'][0]['status_claims'], ['C002'])
        self.report(eid)
        code, out = self.call('build', r)
        html = (self.run_dir / 'report.html').read_text(encoding='utf-8')
        table = html[html.index('<table'):html.index('</table>')]
        # The row says where the item stands in the claim's own words, with its source; the story's claim stays in the story.
        self.assertIn('<span data-claim-id="C002">该规则适用于合成产品。</span>', table)
        self.assertIn('https://www.example.gov/rule', table)
        self.assertNotIn('data-claim-id="C001"', table)
        self.assertEqual([c['id'] for c in self.j('report_ledger.json')['claims']], ['C001', 'C002'])
        result, _, _ = run_all(self.run_dir / 'report.html', self.run_dir / 'report_ledger.json', expected_date='2026-03-10',
                               coverage_path=self.run_dir / 'coverage.json', now='2026-03-11T00:00:00+00:00')
        allx = [x for xs in result['checks'].values() for x in xs]
        self.assertFalse([x for x in allx if x['status'] == 'FAIL'], [x for x in allx if x['status'] == 'FAIL'])
        self.assertNotIn('CLAIM_UNREFERENCED', {x['code'] for x in allx})

    def test_what_changed_is_split_into_the_paragraphs_the_story_names(self):
        r = str(self.run_dir)
        eid = self.complete()
        for i in range(1, 7):
            self.assertEqual(self.call('add-claim', r, eid, 'S001', '--quote', '合成机构今日发布合成规则', '--text', f'合成事实{i}。')[0], 0)
        self.report(eid)
        # Six claims would print as one block: the build asks for paragraphs instead.
        code, out = self.call('build', r)
        self.assertEqual(code, 1)
        self.assertIn('group them with "changes"', out)
        rep = self.j('report.json')
        for bad, message in (([['C001', 'C002', 'C003', 'C004', 'C005', 'C006']], 'paragraph 1 of "changes" has 6 claims'),
                             ([['C001', 'C009']], 'C009 in "changes" is not a claim of'), ([['C001'], ['C001']], 'a claim appears twice')):
            rep['stories'][0]['changes'] = bad
            self.j('report.json', rep)
            code, out = self.call('build', r)
            self.assertEqual(code, 1); self.assertIn(message, out)
        rep['stories'][0]['changes'] = [['C002', 'C001'], ['C004']]
        self.j('report.json', rep)
        self.assertEqual(self.call('build', r)[0] in (0, 2), True)
        html = (self.run_dir / 'report.html').read_text(encoding='utf-8')
        self.assertIn('<span data-claim-id="C002">合成事实2。</span><span data-claim-id="C001">合成事实1。</span></p>'
                      '<p><span data-claim-id="C004">合成事实4。</span></p>', html)
        # Claims the story leaves out stay in the evidence ledger but are not printed, nor bound to the report.
        for left_out in ('C003', 'C005', 'C006'):
            self.assertNotIn(f'data-claim-id="{left_out}"', html)
        self.assertEqual([c['id'] for c in self.j('report_ledger.json')['claims']], ['C002', 'C001', 'C004'])
        included = next(c for c in self.j('coverage.json')['candidates'] if c['decision'] == 'included')
        self.assertEqual(included['claim_ids'], ['C001', 'C002', 'C004'])
        self.assertEqual(len(self.j('evidence_ledger.json')['claims']), 6)

    def test_a_source_is_recorded_as_checked_when_its_page_was_saved(self):
        r = str(self.run_dir)
        eid = self.complete()
        self.call('add-claim', r, eid, 'S001', '--quote', '合成机构今日发布合成规则', '--text', '合成机构发布合成规则。', '--pub-date', '2026-03-09')
        source = self.j('evidence_ledger.json')['claims'][0]['sources'][0]
        self.assertEqual(source['date_checked'], '2026-03-10T04:00:00+00:00')
        self.assertEqual(source['date_checked'], source['snapshot']['retrieved_at'])
        self.report(eid)
        self.call('build', r)
        result, _, _ = run_all(self.run_dir / 'report.html', self.run_dir / 'report_ledger.json', expected_date='2026-03-10',
                               coverage_path=self.run_dir / 'coverage.json', now='2026-03-11T00:00:00+00:00')
        codes_seen = {x['code'] for xs in result['checks'].values() for x in xs}
        # Published the day before it was saved, the source is ordered by the saved time. The old stand-in (the report
        # date, day precision) overlapped every same-day publication of a one-day run, whenever it was really checked.
        self.assertNotIn('DATE_ORDER_AMBIGUOUS', codes_seen)
        self.assertNotIn('CHECK_AFTER_GENERATION', codes_seen)

    def test_add_claim_refuses_invented_quote_and_shows_closest(self):
        eid = self.complete()
        code, out = self.call('add-claim', str(self.run_dir), eid, 'S001', '--quote', '合成机构今日废除全部规则', '--text', 'x')
        self.assertEqual(code, 1)
        self.assertIn('nothing was written', out); self.assertIn('closest passage', out)
        self.assertEqual(self.j('evidence_ledger.json')['claims'], [])

    def test_unknown_site_is_never_primary_by_default(self):
        eid = self.complete(url='https://unknown-blog.example/post')
        self.call('add-claim', str(self.run_dir), eid, 'S001', '--quote', '合成机构今日发布合成规则', '--text', '合成机构发布合成规则。')
        s = self.j('evidence_ledger.json')['claims'][0]['sources'][0]
        self.assertEqual((s['evidence_type'], s['source_role']), ('other', 'secondary'))
        events, *_ = brief.snapshot_state(self.run_dir)
        self.assertEqual(events['events'][-1]['evidence_status'], 'partial')  # cannot become "confirmed"

    def test_news_claim_must_be_attributed(self):
        eid = self.complete(url='https://www.reuters.com/x')
        code, out = self.call('add-claim', str(self.run_dir), eid, 'S001', '--quote', '合成机构今日发布合成规则', '--text', '合成机构发布合成规则。')
        self.assertEqual(code, 1); self.assertIn('According to', out)

    def test_blocked_source_cannot_carry_a_claim_but_event_stays(self):
        r = str(self.run_dir)
        self.call('fetch', r, 'https://www.example.gov/blocked', '--file', self.page('Access denied'))
        code, out = self.call('event', r, 'add', '--title', '难以核实的重要事件', '--date', '2026-03-06', '--side', 'us', '--source', 'S001', '--materiality', 'high')
        eid = self.j('events.json')['events'][-1]['id']
        code, out = self.call('add-claim', r, eid, 'S001', '--quote', 'x', '--text', 'x')
        self.assertEqual(code, 1); self.assertIn('track', out)
        self.call('event', r, 'decide', eid, 'track', '--reason', '原文未能取得')
        _, out = self.call('status', r)
        self.assertNotIn(f'{eid} 难以核实的重要事件: decide', out)

    def test_status_reports_current_stage(self):
        code, out = self.call('status', str(self.run_dir))
        self.assertEqual(code, 1)
        self.assertIn('CURRENT STAGE: 1 discovery', out)

    def test_included_event_without_evidence_must_be_tracked_or_supported(self):
        eid = self.complete()
        _, out = self.call('status', str(self.run_dir))
        self.assertIn('3 evidence', out); self.assertIn('decide it as track', out)

    def test_build_renders_valid_report_with_tracked_events_in_status_table(self):
        eid = self.complete()
        self.call('add-claim', str(self.run_dir), eid, 'S001', '--quote', '合成机构今日发布合成规则', '--text', '合成机构发布合成规则。')
        self.report(eid)
        code, out = self.call('build', str(self.run_dir))
        html = (self.run_dir / 'report.html').read_text(encoding='utf-8')
        self.assertIn('<span data-claim-id="C001">合成机构发布合成规则。</span>', html)
        self.assertIn('class="st confirmed"', html)
        table = html[html.index('<table'):html.index('</table>')]
        self.assertEqual(table.count('合成跟踪事项'), len(brief.active_cases()))  # every tracked case is in the table
        r = validate_report(html, '2026-03-10', SKILL / 'references' / 'glossary.md')
        self.assertFalse([x for x in r if x['status'] == 'FAIL'], r)
        self.assertNotIn('FIRST_USE', codes(r))
        result, _, _ = run_all(self.run_dir / 'report.html', self.run_dir / 'report_ledger.json', expected_date='2026-03-10',
                               coverage_path=self.run_dir / 'coverage.json', now='2026-03-11T00:00:00+00:00')
        allx = [x for xs in result['checks'].values() for x in xs]
        self.assertFalse([x for x in allx if x['status'] == 'FAIL'], [x for x in allx if x['status'] == 'FAIL'])

    def test_status_table_groups_items_and_shows_notes_not_reasons(self):
        eid = self.complete()
        self.call('add-claim', str(self.run_dir), eid, 'S001', '--quote', '合成机构今日发布合成规则', '--text', '合成机构发布合成规则。')
        case = next(e['id'] for e in self.j('events.json')['events'] if e.get('case_id'))
        code, out = self.call('event', str(self.run_dir), 'decide', case, 'track', '--reason', '合成：保留其法律状态可见',
                              '--status-note', '合成通知把暂停延长到 2027 年 1 月。')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.j('events.json')['events'][[e['id'] for e in self.j('events.json')['events']].index(case)]['status_note'],
                         '合成通知把暂停延长到 2027 年 1 月。')
        self.report(eid)
        self.call('build', str(self.run_dir))
        html = (self.run_dir / 'report.html').read_text(encoding='utf-8')
        table = html[html.index('<table'):html.index('</table>')]
        self.assertLess(table.index('本期新增'), table.index('延续跟踪的事项'))
        self.assertIn('合成通知把暂停延长到 2027 年 1 月。', table)
        self.assertNotIn('保留其法律状态可见', table)          # the selection reason stays in coverage.json
        self.assertIn('<a href="#ch1">见第 1 章</a>', table)
        self.assertIn('3 月 20 日', table)                     # the story's watch date fills an empty milestone

    def test_review_report_names_the_codes_that_hold_readiness_back(self):
        eid = self.complete()
        self.call('add-claim', str(self.run_dir), eid, 'S001', '--quote', '合成机构今日发布合成规则', '--text', '合成机构发布合成规则。')
        self.report(eid)
        self.call('build', str(self.run_dir))
        qa = json.loads((self.run_dir / 'qa' / 'review_report.json').read_text(encoding='utf-8'))
        from qa_common import category
        lowering = {x['code'] for xs in qa['checks'].values() for x in xs
                    if x['status'] != 'PASS' and category(x) in ('rule_violation', 'author_fix', 'evidence_gap')}
        self.assertEqual(set(qa['readiness_codes']), lowering)
        self.assertEqual(qa['readiness'] in ('READY_FOR_HUMAN_REVIEW', 'AWAITING_SIGNOFF', 'PASS'), not lowering)

    def test_status_note_is_one_short_sentence(self):
        self.complete()
        case = next(e['id'] for e in self.j('events.json')['events'] if e.get('case_id'))
        code, out = self.call('event', str(self.run_dir), 'decide', case, 'track', '--reason', 'x', '--status-note', 'x' * 241)
        self.assertEqual(code, 1); self.assertIn('--status-note', out)

    def test_story_label_comes_from_evidence_not_writer(self):
        eid = self.complete(url='https://www.reuters.com/x')
        self.call('add-claim', str(self.run_dir), eid, 'S001', '--quote', '合成机构今日发布合成规则', '--text', '据路透社报道，合成机构发布合成规则。')
        self.report(eid)
        self.call('build', str(self.run_dir))
        html = (self.run_dir / 'report.html').read_text(encoding='utf-8')
        self.assertNotIn('class="st confirmed"', html)
        self.assertIn('class="st reported"', html)


if __name__ == '__main__':
    unittest.main()
