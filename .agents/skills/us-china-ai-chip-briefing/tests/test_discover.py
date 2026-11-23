"""Offline tests for scripts/discover.py: parsing, dates, window, scoring and conservative clustering.

Titles below are realistic headline shapes; no network is used and nothing here is a factual source.
"""
import json
from datetime import date
from pathlib import Path
import sys
import tempfile
import unittest
from zoneinfo import ZoneInfo

SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL / 'scripts'))
import discover as d  # noqa: E402

TZ = ZoneInfo('Asia/Hong_Kong')
CFG = json.loads((SKILL / 'references' / 'discovery_sources.json').read_text(encoding='utf-8'))


def mk(title, pub='2026-10-10'):
    return {'title': title, 'published': pub, '_tok': d.tokens(title), '_ent': d.key_entities(title), '_fig': d.figures(title)}


class ClusteringTests(unittest.TestCase):
    def test_different_doj_cases_never_merge(self):
        pairs = [
            ('Super Micro contractor pleads guilty in scheme to divert AI servers with Nvidia chips to China',
             'Justice Department charges Greg Lui and Earthmade in scheme to smuggle Nvidia AI chips to China'),
            ('Former Super Micro contractor pleads guilty to smuggling Nvidia AI chips to China',
             'California man pleads guilty to smuggling Nvidia AI chips to China through Earthmade'),
        ]
        for a, b in pairs:
            self.assertFalse(d.same_event(mk(a), mk(b)), (a, b))

    def test_same_case_reported_twice_merges(self):
        self.assertTrue(d.same_event(mk('Super Micro contractor pleads guilty in scheme to divert AI servers with Nvidia chips to China'),
                                     mk('Super Micro smuggling co-conspirator pleads guilty to sending AI chips to China')))

    def test_title_case_headline_with_shared_figure_merges(self):
        self.assertTrue(d.same_event(mk('Chinese AI companies buy 1 million Nvidia gaming and workstation GPUs in a single year'),
                                     mk('Chinese Firms Buy Over 1 Million NVIDIA GPUs, Repurposing Gaming Chips for AI Inference')))

    def test_unrelated_stories_stay_apart(self):
        self.assertFalse(d.same_event(mk('Huawei, once hobbled by US sanctions, passes 100 million Kirin chip milestone'),
                                      mk('Chinese AI companies buy 1 million Nvidia gaming and workstation GPUs in a single year')))

    def test_far_apart_dates_do_not_merge(self):
        t = 'Super Micro contractor pleads guilty in scheme to divert AI servers with Nvidia chips to China'
        self.assertFalse(d.same_event(mk(t, '2026-10-01'), mk(t, '2026-10-12')))


class ParsingTests(unittest.TestCase):
    def test_date_formats(self):
        cases = {'2026-10-14': date(2026, 10, 14), '2026年10月9日': date(2026, 10, 9), '10/13/2026': date(2026, 10, 13),
                 'October 9, 2026': date(2026, 10, 9), 'Oct. 8, 2026': date(2026, 10, 8),
                 'https://www.cac.gov.cn/2026-10/14/c_1.htm': date(2026, 10, 14), '/xyzx/202610/t20261014_5381616.htm': date(2026, 10, 14)}
        for text, want in cases.items():
            self.assertEqual(d.find_date(text), want, text)

    def test_listing_keeps_month_only_gov_cn_links_flagged(self):
        body = ('<a href="/zhengce/202610/content_7082974.htm">中共中央 国务院关于发展合成政策的意见</a>'
                '<a href="/art/2026/art_1.html">合成新闻发布标题</a><span>2026-10-12</span><a href="/old">无日期链接文字</a>')
        items = d.parse_listing(body, 'https://www.gov.cn/', 'govcn')
        by = {i['title']: i for i in items}
        self.assertEqual(by['中共中央 国务院关于发展合成政策的意见'].get('published_month'), '2026-10')
        self.assertIsNone(by['中共中央 国务院关于发展合成政策的意见']['published'])
        self.assertEqual(by['合成新闻发布标题']['published'], '2026-10-12')
        self.assertNotIn('无日期链接文字', by)

    def test_google_rss_strips_publisher_and_marks_aggregator(self):
        body = ('<rss><channel><item><title>Example chip headline - Reuters</title><link>https://news.google.com/rss/articles/x</link>'
                '<pubDate>Tue, 13 Oct 2026 02:33:00 GMT</pubDate><source url="https://www.reuters.com">Reuters</source></item></channel></rss>')
        it = d.parse_rss(body, 'g', 'google_news', TZ)[0]
        self.assertEqual(it['title'], 'Example chip headline')
        self.assertEqual(it['publisher'], 'Reuters')
        self.assertEqual(it['link_type'], 'aggregator')
        self.assertEqual(it['published'], '2026-10-13')

    def test_federal_register_api(self):
        body = json.dumps({'results': [{'title': 'Additions to the Entity List', 'publication_date': '2026-10-14', 'html_url': 'https://www.federalregister.gov/d/x',
                                        'document_number': '2026-1', 'agencies': [{'name': 'Industry and Security Bureau'}], 'abstract': 'Entities added.'}]})
        it = d.parse_fr(body, 'fr')[0]
        self.assertTrue(it['official'])
        self.assertEqual(it['api_url'], 'https://www.federalregister.gov/api/v1/documents/2026-1.json')


class SweepPlanTests(unittest.TestCase):
    def test_plan_bounds_every_news_query_to_the_window(self):
        reqs = d.plan(CFG, date(2026, 10, 1), date(2026, 10, 7), TZ)
        google = [r for r in reqs if r[0].startswith('google_news')]
        self.assertTrue(google)
        self.assertTrue(all('after%3A2026-10-01' in r[2] and 'before%3A2026-10-08' in r[2] for r in google))
        self.assertFalse([r for r in reqs if r[0].startswith('bing')])  # past window: Bing cannot be bounded

    def test_open_queries_are_not_entity_restricted(self):
        reqs = d.plan(CFG, date(2026, 10, 1), date(2026, 10, 7), TZ)
        labels = {r[1] for r in reqs}
        self.assertTrue(set(CFG['news_search']['open_en']) <= labels)

    def test_blocked_source_is_logged_not_bypassed(self):
        def fake_get(url, retries=0):
            return (403, 'Forbidden', url) if 'reuters' in url or 'ft.com' in url else (200, '<rss><channel></channel></rss>', url)
        cfg = {**CFG, 'official_api': [], 'official_listing': [], 'rss': [{'id': 'ft-tech', 'side': 'other', 'name': 'FT', 'url': 'https://www.ft.com/x'}],
               'news_search': {**CFG['news_search'], 'themes_en': [], 'themes_zh': [], 'outlets': [], 'open_en': [], 'open_zh': [],
                               'official_domains_zh': {}, 'official_domains_en': {}}}
        log = []
        d.sweep(cfg, date(2026, 10, 1), date(2026, 10, 7), TZ, fake_get, log)
        self.assertEqual(log[0]['status'], 403)
        self.assertIn('not bypassed', log[0]['note'])


class OutputTests(unittest.TestCase):
    def test_events_are_discovery_metadata_only(self):
        scorer = d.Scorer(CFG['lexicon'])
        items = [d.item('Super Micro contractor pleads guilty in scheme to divert AI servers with Nvidia chips to China',
                        'https://www.reuters.com/a', date(2026, 10, 9), 'g', 'rss', 'Reuters'),
                 d.item('Justice Department charges Greg Lui and Earthmade in scheme to smuggle Nvidia AI chips to China',
                        'https://www.justice.gov/b', date(2026, 10, 10), 'doj', 'doj_api', 'U.S. Department of Justice', official=True)]
        events = d.build_events(items, scorer, 3)
        self.assertEqual(len(events), 2)  # two different cases
        for e in events:
            self.assertEqual(e['status'], 'discovered')
            self.assertIn('metadata only', e['evidence'])
            self.assertIsNone(e['event_date'])
        with tempfile.TemporaryDirectory() as tmp:
            d.write_outputs(Path(tmp), date(2026, 10, 9), date(2026, 10, 15), TZ, events, [{'id': 'x', 'name': 'X', 'url': 'u', 'status': 403,
                                                                                               'items_in_window': 0, 'note': ''}], 1.0)
            md = (Path(tmp) / 'candidates.md').read_text(encoding='utf-8')
            self.assertIn('Nothing here is verified', md)
            self.assertIn('## A. Official sources', md)
            self.assertIn('Sources unavailable', md)


if __name__ == '__main__':
    unittest.main()
