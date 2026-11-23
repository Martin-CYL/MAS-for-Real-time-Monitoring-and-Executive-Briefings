"""Offline tests for the incremental monitor (scripts/monitor_scan.py, `discover.py --monitor`).

Feeds are stand-ins served by a fake fetcher; no network is used and nothing here is a factual source.
"""
from datetime import datetime, timedelta, timezone
import io
import json
from contextlib import redirect_stdout
from pathlib import Path
import re
import shutil
import sys
import tempfile
import unittest

SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL / 'scripts'))
import discover as d  # noqa: E402
import monitor_scan as m  # noqa: E402

REAL_SOURCES = json.loads((SKILL / 'references' / 'discovery_sources.json').read_text(encoding='utf-8'))
T0 = datetime(2026, 11, 20, 1, 0, tzinfo=timezone.utc)  # 09:00 in Hong Kong

SOURCES = {
    'official_api': [{'id': 'fr-bis', 'side': 'us', 'name': 'Federal Register: BIS', 'kind': 'fr_api',
                      'params': {'conditions[agencies][]': 'industry-and-security-bureau'}}],
    'official_listing': [{'id': 'mofcom', 'side': 'cn', 'name': 'MOFCOM', 'url': 'https://www.mofcom.gov.cn/', 'keep_all': True},
                         {'id': 'bis-news', 'side': 'us', 'name': 'BIS news', 'url': 'https://www.bis.gov/news-updates'}],
    'rss': [{'id': 'nvidia', 'side': 'us', 'name': 'NVIDIA newsroom', 'url': 'https://nvidianews.nvidia.com/rss.xml'}],
    'news_search': {'themes_en': [], 'themes_zh': [], 'outlets': [], 'outlet_query': '', 'open_en': [], 'open_zh': [],
                    'official_domains_zh': {}, 'official_domains_en': {}},
    'lexicon': REAL_SOURCES['lexicon'],
}


def listing(*entries):
    return ''.join(f'<li><a href="{u}">{t}</a><span>{day}</span></li>' for u, t, day in entries)


def fr(*docs):
    return json.dumps({'results': [{'title': t, 'publication_date': day, 'html_url': u, 'document_number': n,
                                    'agencies': [{'name': 'Industry and Security Bureau'}], 'abstract': a}
                                   for n, (u, t, day, a) in enumerate(docs)]})


class Web:
    """A fake fetcher: responses by URL prefix, editable between ticks; records every URL asked for."""

    def __init__(self):
        self.pages = {
            'https://www.federalregister.gov/': (200, fr()),
            'https://www.mofcom.gov.cn/': (200, listing(('/a/1.html', '商务部新闻发布会（合成标题）', '2026-11-19'))),
            'https://www.bis.gov/': (200, listing(('/news/1', 'BIS synthetic press release about export controls on chips', '2026-11-19'))),
            'https://nvidianews.nvidia.com/': (200, '<rss><channel><item><title>Synthetic NVIDIA newsroom post</title>'
                                                    '<link>https://nvidianews.nvidia.com/news/x</link>'
                                                    '<pubDate>Thu, 19 Nov 2026 02:00:00 GMT</pubDate></item></channel></rss>'),
        }
        self.calls = []

    def __call__(self, url, retries=0):
        self.calls.append(url)
        for prefix, (st, body) in self.pages.items():
            if url.startswith(prefix):
                return (st, body, url) if st == 200 else (st, 'Forbidden', url)
        return 404, 'not found', url


class Base(unittest.TestCase):
    cases = []

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.skill = self.tmp / 'skill'
        (self.skill / 'references').mkdir(parents=True)
        shutil.copy(SKILL / 'references' / 'monitor.json', self.skill / 'references' / 'monitor.json')
        (self.skill / 'references' / 'discovery_sources.json').write_text(json.dumps(SOURCES), encoding='utf-8')
        (self.skill / 'references' / 'active_cases.json').write_text(json.dumps({'cases': self.cases}), encoding='utf-8')
        self.dir = self.tmp / 'monitor'
        self.web = Web()
        self.sleeps = []

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def tick(self, at, tiers=None):
        return m.run(self.dir, now=at, tiers=tiers, get=self.web, sleep=self.sleeps.append, skill=self.skill)

    def state(self):
        return json.loads((self.dir / 'state.json').read_text(encoding='utf-8'))

    def batch(self, summary):
        return json.loads((Path(summary['batch']) / 'items.json').read_text(encoding='utf-8'))


class NewItemTests(Base):
    def test_first_check_is_a_baseline_and_later_entries_are_new(self):
        first = self.tick(T0)
        self.assertEqual(first['new'], 0)
        self.assertGreater(first['baseline'], 0)
        self.web.pages['https://www.mofcom.gov.cn/'] = (200, listing(
            ('/a/1.html', '商务部新闻发布会（合成标题）', '2026-11-19'),
            ('/a/2.html', '商务部公告：关于两用物项出口管制的合成标题', '2026-11-20')))
        second = self.tick(T0 + timedelta(minutes=30))
        b = self.batch(second)
        self.assertEqual([i['title'] for i in b['new_items']], ['商务部公告：关于两用物项出口管制的合成标题'])
        self.assertEqual(b['new_items'][0]['group'], 'official_listing')
        self.assertIn('not evidence', b['note'])
        third = self.tick(T0 + timedelta(minutes=60))
        self.assertEqual(third['new'], 0)  # seen once, never reported again

    def test_tracking_parameters_do_not_make_an_item_new(self):
        a = {'title': 'Same headline', 'url': 'https://example.com/story/?utm_source=x&id=3#top'}
        b = {'title': 'Same  headline ', 'url': 'https://EXAMPLE.com/story?id=3'}
        self.assertEqual(m.fingerprint(a), m.fingerprint(b))
        self.assertNotEqual(m.fingerprint(a), m.fingerprint({**b, 'url': 'https://example.com/story?id=4'}))

    def test_tiers_run_at_their_own_intervals(self):
        self.assertEqual(self.tick(T0)['tiers'], ['official', 'feeds', 'news'])
        self.assertEqual(self.tick(T0 + timedelta(minutes=15))['tiers'], [])
        self.assertEqual(self.tick(T0 + timedelta(minutes=29))['tiers'], ['official'])  # a tick a little early still counts
        self.assertEqual(self.tick(T0 + timedelta(minutes=120))['tiers'], ['official', 'feeds'])

    def test_one_host_is_asked_at_most_once_per_interval(self):
        SOURCES_TWO = json.loads(json.dumps(SOURCES))
        SOURCES_TWO['official_api'].append({'id': 'fr-terms', 'side': 'us', 'name': 'FR terms', 'kind': 'fr_api', 'terms': ['a', 'b']})
        (self.skill / 'references' / 'discovery_sources.json').write_text(json.dumps(SOURCES_TWO), encoding='utf-8')
        self.tick(T0, tiers=['official'])
        self.assertEqual(len([u for u in self.web.calls if 'federalregister' in u]), 3)
        self.assertEqual(self.sleeps, [2, 2])  # three Federal Register requests in a row, other hosts in parallel

    def test_page_with_new_links_but_no_dated_entry_is_noted(self):
        self.tick(T0)
        self.web.pages['https://www.bis.gov/'] = (200, listing(('/news/1', 'BIS synthetic press release about export controls on chips', '2026-11-19'))
                                                  + '<a href="/about/new-page">About the bureau</a>')
        b = self.batch(self.tick(T0 + timedelta(minutes=30)))
        self.assertEqual([c['source_id'] for c in b['page_changes']], ['bis-news'])


class HealthTests(Base):
    def test_a_source_down_for_six_hours_alerts_once_then_recovers(self):
        self.tick(T0)
        self.web.pages['https://www.mofcom.gov.cn/'] = (403, '')
        kinds = []
        for n in range(1, 15):
            kinds += [a['kind'] for a in self.tick(T0 + timedelta(minutes=30 * n), tiers=['official'])['alerts']]
        self.assertEqual(kinds.count('source_down'), 1)
        down = self.state()['sources']['mofcom']
        self.assertEqual(down['alerted'], 'down')
        self.web.pages['https://www.mofcom.gov.cn/'] = (200, listing(('/a/1.html', '商务部新闻发布会（合成标题）', '2026-11-19')))
        back = self.tick(T0 + timedelta(hours=8), tiers=['official'])
        self.assertEqual([a['kind'] for a in back['alerts']], ['source_recovered'])

    def test_down_alert_says_silence_is_not_evidence(self):
        self.tick(T0)
        self.web.pages['https://www.bis.gov/'] = (403, '')
        alerts = []
        for n in range(1, 14):
            alerts += self.tick(T0 + timedelta(minutes=30 * n), tiers=['official'])['alerts']
        msg = next(a for a in alerts if a['kind'] == 'source_down')
        self.assertIn('not evidence that nothing happened', msg['message'])
        self.assertIn('不代表没有发生变化', msg['message_zh'])

    def test_listing_that_parses_to_nothing_three_times_warns(self):
        self.tick(T0)
        self.web.pages['https://www.bis.gov/'] = (200, '<html><body>redesigned</body></html>')
        kinds = [a['kind'] for n in (1, 2, 3, 4) for a in self.tick(T0 + timedelta(minutes=30 * n), tiers=['official'])['alerts']]
        self.assertEqual(kinds, ['source_empty'])


DEADLINE = T0 + timedelta(hours=48)


class DeadlineTests(Base):
    cases = [{'case_id': 'A002', 'deadline': DEADLINE.astimezone(timezone(timedelta(hours=8))).strftime('%Y-%m-%dT%H:%M'),
              'timezone': 'Asia/Shanghai', 'watch_sources': ['mofcom'], 'match_terms': ['稀土', 'rare earth']}]

    def test_approaching_deadline_alerts_once_and_boosts_the_watched_source(self):
        first = self.tick(T0)
        self.assertEqual([a['kind'] for a in first['alerts']], ['deadline_approaching'])
        boosted = self.tick(T0 + timedelta(minutes=15))
        self.assertEqual(boosted['tiers'], [])
        self.assertEqual(boosted['boosted'], ['mofcom'])
        self.assertEqual(boosted['alerts'], [])
        quiet = self.tick(T0 + timedelta(minutes=20))
        self.assertEqual(quiet['boosted'], [])

    def test_no_matching_notice_after_the_deadline_is_reported_as_a_search_result(self):
        self.tick(T0)
        at = DEADLINE + timedelta(minutes=5)
        alerts = self.tick(at)['alerts']
        msg = next(a for a in alerts if a['kind'] == 'deadline_passed_no_notice')
        self.assertEqual(msg['level'], 'flash')
        self.assertIn('does not show that the status is unchanged', msg['message'])
        self.assertIn('这只是检索结果，不代表状态未变', msg['message_zh'])
        self.assertNotRegex(msg['message'] + msg['message_zh'], r'not extended|no extension|未延期|没有延期')
        again = self.tick(at + timedelta(minutes=15))['alerts']
        self.assertFalse([a for a in again if a['kind'].startswith('deadline')])

    def test_matching_official_item_is_flashed_and_named_after_the_deadline(self):
        self.tick(T0)
        self.web.pages['https://www.mofcom.gov.cn/'] = (200, listing(
            ('/a/1.html', '商务部新闻发布会（合成标题）', '2026-11-19'),
            ('/a/3.html', '商务部公告（合成）：关于稀土相关措施的标题', '2026-11-21')))
        found = self.tick(T0 + timedelta(hours=30))
        match = next(a for a in found['alerts'] if a['kind'] == 'case_match')
        self.assertEqual(match['level'], 'flash')
        self.assertIn('未核实', match['message_zh'])
        after = self.tick(DEADLINE + timedelta(minutes=5))['alerts']
        self.assertEqual([a['kind'] for a in after], ['deadline_passed_items_found'])

    def test_monitor_started_after_the_deadline_draws_no_conclusion(self):
        alerts = self.tick(DEADLINE + timedelta(hours=1))['alerts']
        self.assertEqual([a['kind'] for a in alerts], ['deadline_not_covered'])


class DigestTests(Base):
    def test_daily_digest_once_per_slot_with_new_official_items(self):
        self.tick(T0)  # 09:00 HKT: the 08:30 slot has passed, but the monitor only started now
        self.web.pages['https://www.mofcom.gov.cn/'] = (200, listing(
            ('/a/1.html', '商务部新闻发布会（合成标题）', '2026-11-19'),
            ('/a/2.html', '商务部公告：关于两用物项出口管制的合成标题', '2026-11-20')))
        self.assertIsNone(self.tick(T0 + timedelta(hours=1))['digest'])
        nxt = self.tick(T0 + timedelta(hours=24))  # 09:00 next day: the 08:30 slot is due
        self.assertIsNotNone(nxt['digest'])
        text = Path(nxt['digest']['path']).read_text(encoding='utf-8')
        self.assertIn('Nothing here is verified', text)
        self.assertIn('商务部公告：关于两用物项出口管制的合成标题', text)
        self.assertTrue(nxt['digest']['path'].endswith('2026-11-21.md'))
        self.assertIsNone(self.tick(T0 + timedelta(hours=24, minutes=15))['digest'])


class EntryPointTests(Base):
    def test_lock_refuses_a_second_concurrent_call(self):
        self.dir.mkdir()
        (self.dir / '.lock').write_text('1')
        with self.assertRaises(m.MonitorError):
            self.tick(T0)

    def test_cli_prints_a_monitor_line_and_logs(self):
        empty = {**SOURCES, 'official_api': [], 'official_listing': [], 'rss': []}
        path = self.tmp / 'sources.json'
        path.write_text(json.dumps(empty), encoding='utf-8')
        out = io.StringIO()
        sys_argv = sys.argv
        try:
            sys.argv = ['discover.py', '--monitor', '--dir', str(self.dir), '--now', T0.isoformat(), '--sources', str(path)]
            with redirect_stdout(out):
                code = d.main()
        finally:
            sys.argv = sys_argv
        self.assertEqual(code, 0)
        last = out.getvalue().strip().splitlines()[-1]
        self.assertTrue(last.startswith('MONITOR '))
        self.assertEqual(json.loads(last[len('MONITOR '):])['tiers'], ['official', 'feeds', 'news'])
        self.assertEqual(len((self.dir / 'log.jsonl').read_text(encoding='utf-8').splitlines()), 1)


class ReferenceTests(unittest.TestCase):
    def test_case_deadlines_match_active_cases_and_sources(self):
        cases = json.loads((SKILL / 'references' / 'active_cases.json').read_text(encoding='utf-8'))['cases']
        table = (SKILL / 'references' / 'active_cases.md').read_text(encoding='utf-8')
        ids = {s['id'] for k in ('official_api', 'official_listing', 'rss') for s in REAL_SOURCES[k]}
        for c in cases:
            self.assertRegex(table, rf'\|\s*{c["case_id"]}\s*\|')
            self.assertTrue(set(c['watch_sources']) <= ids, c)
            self.assertIn(c['deadline'][:10], table)  # the deadline is the one active_cases.md states
            self.assertTrue(c['match_terms'])
        self.assertTrue(m.load_cases())

    def test_monitor_config_loads(self):
        cfg = m.load_config()
        self.assertEqual(set(cfg['tiers']), {'official', 'feeds', 'news'})
        self.assertTrue(re.fullmatch(r'\d\d:\d\d', cfg['digest']['time']))


if __name__ == '__main__':
    unittest.main()
