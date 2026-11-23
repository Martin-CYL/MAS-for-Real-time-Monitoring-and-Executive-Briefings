"""Tests for quote checks, risk tiers, Markdown sign-off, coverage sweep and first-use fixes.
All network access is mocked; no public requests."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from urllib.error import HTTPError

SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL / 'scripts'))
from check_quotes import validate_quotes, quote_found, claim_signals, load_domains
from check_coverage import validate_coverage
from check_report import validate_report
from signoff import render_signoff, parse_signoff
from validate import run_all

DOMAINS = load_domains()

ARTICLE = ('<html><body><h1>Tencent mulls bond sale</h1>'
           '<p>Tencent Holdings is considering selling up to $5 billion of offshore bonds, '
           'according to people familiar with the matter.</p>'
           '<p>The proceeds would fund AI and computing infrastructure, the people said on October 8.</p>'
           '</body></html>').encode('utf-8')


class Page:
    def __init__(self, body, status=200, ctype='text/html'):
        self.body, self.status = body, status
        self.headers = {'Content-Type': ctype}
    def geturl(self): return 'https://fixture.invalid/page'
    def read(self, n=-1): return self.body if n < 0 else self.body[:n]
    def __enter__(self): return self
    def __exit__(self, *a): pass


def opener_for(pages):
    def opener(req, timeout):
        url = req.full_url
        v = pages.get(url)
        if v is None:
            raise HTTPError(url, 404, 'missing', {}, None)
        if isinstance(v, int):
            raise HTTPError(url, v, 'blocked', {}, None)
        return Page(v)
    return opener


def claim(cid, text, quote, url='https://www.reuters.com/x', kinds=('factual',), etype='news', role='secondary'):
    return {'id': cid, 'text': text, 'kinds': list(kinds), 'author_status': 'supported', 'event_date': '2026-10-08',
            'uncertainty': '', 'sources': [{'url': url, 'publication_date': '2026-10-08', 'date_checked': '2026-10-09',
                                             'quote': quote, 'anchor': 'para 1', 'evidence_type': etype,
                                             'source_role': role, 'access_status': 'opened', 'notes': ''}]}


def ledger(*claims):
    return {'schema_version': 1, 'fixture': False, 'author': 'agent', 'report_date': '2026-10-09', 'claims': list(claims)}


def report(spans, links):
    body = ''.join(f'<p data-claim-id="{cid}">{t}</p>' for cid, t in spans)
    a = ''.join(f'<a href="{u}">来源</a>' for u in links)
    return ('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>简报 2026.10.09</title></head><body>'
            '<div class="mastmeta"><strong data-report-date="2026-10-09">2026.10.09</strong></div>'
            '<p class="issue">简报 / 2026 年 10 月 9 日 / 资料截至 10 月 8 日</p>'
            '<div class="status-key"><span><i class="dot g"></i>官方或公司正式公告</span><span><i class="dot a"></i>媒体报道或未经独立验证</span><span><i class="dot s"></i>拟议、待审批或待生效</span></div>'
            f'{body}{a}<footer>PUBLIC-SOURCE INTELLIGENCE · 09 OCT 2026</footer></body></html>')


def write_case(tmp, html, led, cov=None):
    t = Path(tmp)
    (t / 'r.html').write_text(html, encoding='utf-8')
    (t / 'l.json').write_text(json.dumps(led, ensure_ascii=False), encoding='utf-8')
    if cov is not None:
        (t / 'c.json').write_text(json.dumps(cov, ensure_ascii=False), encoding='utf-8')
    return t / 'r.html', t / 'l.json', (t / 'c.json' if cov is not None else None)


def codes(items):
    return {i['code'] for i in items}


def all_items(result):
    return [x for xs in result['checks'].values() for x in xs]


class QuoteMatching(unittest.TestCase):
    def test_exact_and_normalised(self):
        text = 'Tencent Holdings is considering selling up to $5 billion of offshore bonds.'
        self.assertTrue(quote_found('considering selling up to $5 billion', text)[0])
        self.assertTrue(quote_found('“considering  selling up to $5 billion”', '"considering selling up to $5 billion"')[0])
        self.assertTrue(quote_found('ＡＢＣ公司宣布', 'ABC公司宣布')[0])  # full-width

    def test_invented_quote_not_found(self):
        self.assertFalse(quote_found('The U.S. Treasury added Tencent to its investment restriction list.', ARTICLE.decode())[0])


class FabricationProbe(unittest.TestCase):
    """The probe from the review: invented quote on a real-looking news URL, mislabelled as official."""
    def test_fabricated_quote_is_fail(self):
        url = 'https://www.reuters.com/tencent-bond'
        c = claim('C001', '美国财政部已将腾讯列入证券投资限制名单。',
                  'The U.S. Treasury added Tencent to its investment restriction list.', url=url,
                  kinds=('list',), etype='official_document', role='primary')
        with tempfile.TemporaryDirectory() as tmp:
            h, l, _ = write_case(tmp, report([('C001', c['text'])], [url]), ledger(c))
            result, md, so = run_all(h, l, network=True, opener=opener_for({url: ARTICLE}))
        found = codes(all_items(result))
        self.assertEqual(result['outcome'], 'FAIL')
        self.assertIn('QUOTE_NOT_FOUND', found)
        self.assertIn('SOURCE_TYPE_MISMATCH', found)
        self.assertEqual(result['risk']['C001']['tier'], 'high')
        self.assertIn('C001', so)  # appears on the human list


class RiskTiers(unittest.TestCase):
    def test_low_risk_auto_passes_when_quote_found(self):
        url = 'https://www.tencent.com/news'
        c = claim('C001', '腾讯称资金将用于 AI 与计算基础设施。',
                  'The proceeds would fund AI and computing infrastructure', url=url, etype='company_statement', role='primary')
        with tempfile.TemporaryDirectory() as tmp:
            h, l, _ = write_case(tmp, report([('C001', c['text'])], [url]), ledger(c))
            result, _, so = run_all(h, l, network=True, opener=opener_for({url: ARTICLE}))
        ev = result['checks']['evidence']
        self.assertIn('AUTO_LOW_RISK', codes(ev))
        self.assertNotIn('CLAIM_REVIEW_PENDING', codes(ev))
        self.assertNotIn('### C001', so)

    def test_legal_claim_never_auto_passes(self):
        url = 'https://www.federalregister.gov/x'
        page = b'<p>The suspension ends on November 9, 2026.</p>'
        c = claim('C001', '暂停期于 2026 年 11 月 9 日结束。', 'The suspension ends on November 9, 2026.', url=url,
                  kinds=('legal',), etype='official_document', role='primary')
        with tempfile.TemporaryDirectory() as tmp:
            h, l, _ = write_case(tmp, report([('C001', c['text'])], [url]), ledger(c))
            result, _, so = run_all(h, l, network=True, opener=opener_for({url: page}))
        self.assertIn('QUOTE_FOUND', codes(result['checks']['quotes']))
        self.assertIn('CLAIM_REVIEW_PENDING', codes(result['checks']['evidence']))
        self.assertNotIn('AUTO_LOW_RISK', codes(result['checks']['evidence']))
        self.assertIn('### C001', so)

    def test_blocked_source_escalates(self):
        url = 'https://www.bloomberg.com/x'
        c = claim('C001', '腾讯考虑发债。', 'Tencent is considering', url=url)
        items, risk = validate_quotes(ledger(c), network=True, opener=opener_for({url: 403}))
        self.assertIn('QUOTE_UNCHECKABLE', codes(items))
        self.assertEqual(risk['C001']['tier'], 'high')

    def test_offline_low_risk_stays_pending(self):
        c = claim('C001', '腾讯称资金将用于 AI。', 'fund AI', url='https://www.tencent.com/x', etype='company_statement', role='primary')
        items, risk = validate_quotes(ledger(c), network=False)
        self.assertIn('QUOTE_UNCHECKED', codes(items))
        self.assertEqual(risk['C001']['quote_state'], 'UNCHECKED')

    def test_pdf_source_needs_person(self):
        url = 'https://www.govinfo.gov/x.pdf'
        c = claim('C001', '文件已发布。', 'published', url=url, etype='official_document', role='primary')
        def opener(req, timeout): return Page(b'%PDF-1.7 ...', ctype='application/pdf')
        items, risk = validate_quotes(ledger(c), network=True, opener=opener)
        self.assertIn('QUOTE_UNCHECKABLE', codes(items))


class OfflineSignals(unittest.TestCase):
    def test_number_missing_from_quote(self):
        c = claim('C001', '腾讯考虑发行最多 80 亿美元债券。', 'selling up to $5 billion of offshore bonds')
        self.assertIn('NUMBER_NOT_IN_QUOTE', [x[0] for x in claim_signals(c, DOMAINS)])

    def test_unit_and_month_conversion_accepted(self):
        c = claim('C001', '价值逾 3 亿美元的服务器于 10 月 1 日被查。', 'servers worth more than $300 million, announced October 1')
        self.assertNotIn('NUMBER_NOT_IN_QUOTE', [x[0] for x in claim_signals(c, DOMAINS)])

    def test_thousands_separator(self):
        c = claim('C001', '带宽为 1,200GB/s。', 'bandwidth of 1200 GB/s')
        self.assertNotIn('NUMBER_NOT_IN_QUOTE', [x[0] for x in claim_signals(c, DOMAINS)])

    def test_news_site_labelled_official(self):
        c = claim('C001', '某事。', 'x', url='https://www.reuters.com/a', etype='official_document', role='primary')
        self.assertIn('SOURCE_TYPE_MISMATCH', [x[0] for x in claim_signals(c, DOMAINS)])

    def test_understated_kind_flagged(self):
        c = claim('C001', '美国财政部已将腾讯列入证券投资限制名单。', 'x', kinds=('factual',))
        self.assertIn('KIND_UNDERSTATED', [x[0] for x in claim_signals(c, DOMAINS)])

    def test_plain_technical_claim_not_understated(self):
        c = claim('C001', '新芯片带宽为 1200GB/s。', '1200 GB/s', kinds=('technical',))
        self.assertNotIn('KIND_UNDERSTATED', [x[0] for x in claim_signals(c, DOMAINS)])

    def test_government_site_not_flagged(self):
        c = claim('C001', '某事。', 'x', url='https://www.mofcom.gov.cn/a', etype='official_document', role='primary')
        self.assertNotIn('SOURCE_TYPE_MISMATCH', [x[0] for x in claim_signals(c, DOMAINS)])


class SignoffMarkdown(unittest.TestCase):
    def _setup(self, tmp, tick):
        url = 'https://www.federalregister.gov/x'
        c = claim('C001', '暂停期于 2026 年 11 月 9 日结束。', 'The suspension ends on November 9, 2026.', url=url,
                  kinds=('legal',), etype='official_document', role='primary')
        h, l, _ = write_case(tmp, report([('C001', c['text'])], [url]), ledger(c))
        opener = opener_for({url: b'<p>The suspension ends on November 9, 2026.</p>'})
        _, _, so = run_all(h, l, network=True, opener=opener)
        so = so.replace('reviewer: \n', 'reviewer: Jane Reviewer\n').replace('date: \n', 'date: 2026-10-09\n')
        so = so.replace('decision: hold', 'decision: approve').replace('coverage_checked: no', 'coverage_checked: yes')
        so = so.replace('[ ] ' + tick, '[x] ' + tick, 1)
        p = Path(tmp) / 'signoff.md'; p.write_text(so, encoding='utf-8')
        return h, l, p, opener

    def test_supported_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            h, l, p, op = self._setup(tmp, '支持')
            result, _, _ = run_all(h, l, network=True, opener=op, signoff_path=p)
        ev = codes(result['checks']['evidence'])
        self.assertIn('RECORDED_SOURCE_REVIEW', ev)
        self.assertIn('RECORDED_SIGNOFF', ev)

    def test_not_supported_is_fail_and_not_confused_with_supported(self):
        with tempfile.TemporaryDirectory() as tmp:
            h, l, p, op = self._setup(tmp, '不支持')
            result, _, _ = run_all(h, l, network=True, opener=op, signoff_path=p)
        ev = codes(result['checks']['evidence'])
        self.assertIn('CLAIM_UNSUPPORTED', ev)
        self.assertEqual(result['outcome'], 'FAIL')

    def test_unticked_is_unverified(self):
        with tempfile.TemporaryDirectory() as tmp:
            h, l, p, op = self._setup(tmp, 'NOTHING')
            result, _, _ = run_all(h, l, network=True, opener=op, signoff_path=p)
        self.assertNotIn('RECORDED_SOURCE_REVIEW', codes(result['checks']['evidence']))

    def test_blank_reviewer_incomplete(self):
        with tempfile.TemporaryDirectory() as tmp:
            h, l, p, op = self._setup(tmp, '支持')
            p.write_text(p.read_text(encoding='utf-8').replace('Jane Reviewer', ''), encoding='utf-8')
            result, _, _ = run_all(h, l, network=True, opener=op, signoff_path=p)
        self.assertIn('SIGNOFF_INCOMPLETE', codes(result['checks']['evidence']))

    def test_edit_after_signoff_is_stale(self):
        with tempfile.TemporaryDirectory() as tmp:
            h, l, p, op = self._setup(tmp, '支持')
            h.write_text(h.read_text(encoding='utf-8') + '<!-- edit -->', encoding='utf-8')
            result, _, _ = run_all(h, l, network=True, opener=op, signoff_path=p)
        self.assertIn('REVIEW_STALE', codes(result['checks']['evidence']))


def good_coverage():
    cands = [{'event': f'event {i}', 'date': '2026-10-05', 'side': 'us' if i % 2 else 'cn',
              'decision': 'excluded', 'reason': 'minor'} for i in range(8)]
    cands[0].update(decision='included', claim_ids=['C001'])
    return {'window': {'start': '2026-10-02', 'end': '2026-10-08'},
            'outlets_searched': ['Reuters', 'Caixin', 'Federal Register'], 'candidates': cands}


class Coverage(unittest.TestCase):
    LED = ledger(claim('C001', 'x', 'x'))

    def test_missing_sweep_unverified(self):
        self.assertIn('COVERAGE_SWEEP_MISSING', codes(validate_coverage(None)))

    def test_good_sweep_passes(self):
        items = validate_coverage(good_coverage(), self.LED, cases_path='')
        self.assertIn('COVERAGE_RECORDED', codes(items))
        self.assertFalse([x for x in items if x['status'] != 'PASS'])

    def test_thin_and_one_sided(self):
        cov = good_coverage(); cov['candidates'] = [c for c in cov['candidates'] if c['side'] == 'us'][:3]
        cov['candidates'][0].update(decision='included', claim_ids=['C001'])
        found = codes(validate_coverage(cov, self.LED, cases_path=''))
        self.assertIn('COVERAGE_THIN', found)
        self.assertIn('ONE_SIDED_SWEEP', found)

    def test_exclusion_needs_reason_and_ids_must_exist(self):
        cov = good_coverage()
        cov['candidates'][1]['reason'] = ''
        cov['candidates'][0]['claim_ids'] = ['C999']
        found = codes(validate_coverage(cov, self.LED, cases_path=''))
        self.assertIn('EXCLUSION_REASON', found)
        self.assertIn('COVERAGE_UNKNOWN_CLAIM', found)

    def test_active_case_must_be_followed(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'cases.md'
            p.write_text('| Case ID | Q |\n|---|---|\n| A001 | rule? |\n| A002 | rare earths? |\n', encoding='utf-8')
            cov = good_coverage(); cov['candidates'][2]['case_id'] = 'A001'
            items = validate_coverage(cov, self.LED, p)
        msgs = [x['message'] for x in items if x['code'] == 'CASE_NOT_FOLLOWED']
        self.assertEqual(len(msgs), 1); self.assertIn('A002', msgs[0])

    def test_shipped_active_cases_are_parsed(self):
        from check_coverage import active_case_ids
        self.assertGreaterEqual(len(active_case_ids(SKILL / 'references' / 'active_cases.md')), 10)


class FirstUseFixes(unittest.TestCase):
    def first_use(self, body):
        html = report([], ['https://fixture.invalid/a']).replace('<a href', body + '<a href', 1)
        return [x['term'] for x in validate_report(html, '2026-10-09') if x['code'] == 'FIRST_USE']

    def test_jiancheng_counts_as_definition(self):
        self.assertNotIn('1260H', self.first_use('<p>美国国防部"中国军事企业"名单（简称 1260H 名单）包含两家公司。</p>'))

    def test_link_label_and_currency_skipped(self):
        terms = self.first_use('<p>营收为 NT$511bn。<a href="https://fixture.invalid/b">AP 报道 ↗</a></p>')
        self.assertNotIn('NT', terms); self.assertNotIn('AP', terms)

    def test_real_undefined_term_still_flagged(self):
        self.assertIn('FCC', self.first_use('<p>FCC 将于下月表决。</p>'))


if __name__ == '__main__':
    unittest.main()
