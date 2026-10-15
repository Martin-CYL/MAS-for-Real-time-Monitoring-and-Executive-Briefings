"""Round-3 merge: proxy mode (default allow, strict refuse) and offline quote checks via snapshots.
All network access is mocked."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL / 'scripts'))
sys.path.insert(0, str(SKILL / 'tests'))
from safe_http import safe_get, Response, UnsafeURL, TransportUnavailable
from check_links import check
from check_quotes import validate_quotes
from validate import run_all
from test_hardening import claim, ledger, report, write_case, codes, all_items

URL = 'https://www.example-news.com/story'
PROXY_ENV = {'HTTPS_PROXY': 'http://proxy.example:8080'}


def fake_proxy(routes, calls):
    def hop(target, timeout, max_bytes):
        calls.append(target.url)
        code, headers, body = routes.get(target.url, (404, {}, b''))
        return Response(code, target.url, body, headers, [])
    return hop


class ProxyMode(unittest.TestCase):
    def test_default_allows_proxy_without_local_dns(self):
        calls = []
        with patch.dict('os.environ', PROXY_ENV), patch('safe_http.proxy_hop', fake_proxy({URL: (200, {}, b'<p>ok</p>')}, calls)), \
                patch('safe_http.socket.getaddrinfo') as dns:
            r = check(URL)
            dns.assert_not_called()
        self.assertEqual(r['code'], 'REACHABLE')
        self.assertEqual(r['transport'], 'proxy')
        self.assertIn('DNS not pinned', r['message'])

    def test_strict_mode_refuses(self):
        with patch.dict('os.environ', dict(PROXY_ENV, BRIEFING_PROXY_POLICY='refuse')):
            with self.assertRaises(TransportUnavailable):
                safe_get(URL)

    def test_private_literal_blocked_before_proxy(self):
        calls = []
        with patch.dict('os.environ', PROXY_ENV), patch('safe_http.proxy_hop', fake_proxy({}, calls)):
            r = check('http://169.254.169.254/latest/meta-data/')
        self.assertEqual(r['code'], 'UNSAFE_URL')
        self.assertEqual(calls, [])

    def test_redirect_to_private_blocked_via_proxy(self):
        calls = []
        routes = {URL: (302, {'location': 'http://127.0.0.1/admin'}, b'')}
        with patch.dict('os.environ', PROXY_ENV), patch('safe_http.proxy_hop', fake_proxy(routes, calls)):
            r = check(URL)
        self.assertEqual(r['code'], 'UNSAFE_URL')
        self.assertEqual(calls, [URL])  # the private target was never requested

    def test_public_redirect_followed_via_proxy(self):
        calls = []
        dest = 'https://www.example-news.com/final'
        routes = {URL: (301, {'location': dest}, b''), dest: (200, {}, b'<p>ok</p>')}
        with patch.dict('os.environ', PROXY_ENV), patch('safe_http.proxy_hop', fake_proxy(routes, calls)):
            r = safe_get(URL)
        self.assertEqual(r.status, 200)
        self.assertEqual(calls, [URL, dest])


def with_snapshot(tmp, c, text, tamper=False, path='snapshots/C001-1.txt'):
    d = Path(tmp) / 'snapshots'; d.mkdir(exist_ok=True)
    data = text.encode('utf-8')
    (Path(tmp) / path).write_bytes(data + (b' changed' if tamper else b''))
    c['sources'][0]['snapshot'] = {'path': path, 'sha256': hashlib.sha256(data).hexdigest(), 'retrieved_at': '2026-10-09'}
    return c


ARTICLE = 'Tencent is considering selling up to $5 billion of offshore bonds. The proceeds would fund AI and computing infrastructure.'


class Snapshots(unittest.TestCase):
    def test_quote_found_offline_from_snapshot_auto_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            c = with_snapshot(tmp, claim('C001', '腾讯称资金将用于 AI 与计算基础设施。', 'The proceeds would fund AI and computing infrastructure',
                                         url='https://www.tencent.com/n', etype='company_statement', role='primary'), ARTICLE)
            h, l, _ = write_case(tmp, report([('C001', c['text'])], ['https://www.tencent.com/n']), ledger(c))
            result, _, _ = run_all(h, l, network=False, cases_path='')
        self.assertEqual(result['risk']['C001']['quote_state'], 'FOUND')
        self.assertIn('AUTO_LOW_RISK', codes(result['checks']['evidence']))

    def test_invented_quote_fails_offline(self):
        with tempfile.TemporaryDirectory() as tmp:
            c = with_snapshot(tmp, claim('C001', '美国财政部已将腾讯列入证券投资限制名单。',
                                         'The U.S. Treasury added Tencent to its investment restriction list.'), ARTICLE)
            items, risk = validate_quotes(ledger(c), network=False, ledger_dir=tmp)
        self.assertIn('QUOTE_NOT_FOUND', codes(items))
        self.assertEqual(risk['C001']['tier'], 'high')

    def test_tampered_snapshot_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            c = with_snapshot(tmp, claim('C001', '腾讯考虑发债。', 'considering selling'), ARTICLE, tamper=True)
            items, _ = validate_quotes(ledger(c), network=False, ledger_dir=tmp)
        self.assertIn('SNAPSHOT_HASH_MISMATCH', codes(items))

    def test_missing_snapshot_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            c = claim('C001', '腾讯考虑发债。', 'considering selling')
            c['sources'][0]['snapshot'] = {'path': 'snapshots/none.txt', 'sha256': '0' * 64}
            items, _ = validate_quotes(ledger(c), network=False, ledger_dir=tmp)
        self.assertIn('SNAPSHOT_MISSING', codes(items))

    def test_snapshot_outside_run_folder_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            c = claim('C001', '腾讯考虑发债。', 'considering selling')
            c['sources'][0]['snapshot'] = {'path': '../../etc/passwd', 'sha256': ''}
            items, _ = validate_quotes(ledger(c), network=False, ledger_dir=tmp)
        self.assertIn('SNAPSHOT_MISSING', codes(items))

    def test_snapshot_and_live_page_disagree(self):
        url = 'https://www.example-news.com/story'
        def opener(req, timeout):
            from test_hardening import Page
            return Page(b'<p>Page now says something else entirely.</p>')
        with tempfile.TemporaryDirectory() as tmp:
            c = with_snapshot(tmp, claim('C001', '腾讯考虑发债。', 'considering selling up to $5 billion', url=url), ARTICLE)
            items, _ = validate_quotes(ledger(c), network=True, opener=opener, ledger_dir=tmp)
        self.assertIn('SNAPSHOT_LIVE_DIFFER', codes(items))
        self.assertNotIn('QUOTE_NOT_FOUND', codes(items))

    def test_save_snapshot_helper(self):
        import subprocess
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / 'page.txt'; src.write_text(ARTICLE, encoding='utf-8')
            out = subprocess.run([sys.executable, str(SKILL / 'scripts' / 'save_snapshot.py'), '--from-file', str(src),
                                  '--url', URL, '--run-dir', tmp, '--name', 'C001-1'], capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stderr)
            snap = json.loads(out.stdout)
            data = (Path(tmp) / snap['path']).read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(), snap['sha256'])


if __name__ == '__main__':
    unittest.main()
