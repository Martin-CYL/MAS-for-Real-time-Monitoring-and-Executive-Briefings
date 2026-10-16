#!/usr/bin/env python3
"""Automated anti-fabrication checks on the evidence ledger.

1. Quote check: confirm the recorded quote actually appears in the source.
   - From a saved snapshot (works offline and behind any proxy): the source's
     `snapshot` field points to the page text saved when the writer read it; its
     SHA-256 must match. Quote absent from the snapshot = FAIL.
   - From the live page (--network): fetched through safe_http (private targets
     blocked, redirects re-checked). Quote absent from a fetched page = FAIL.
   If both exist and the quote is in the snapshot but not on the live page, that is
   flagged for a person (the page may have changed, or the snapshot may be wrong).
2. Offline signals (always): numbers in a claim that appear in no quote, and source
   labels that do not fit the domain (e.g. a news site labelled official_document).
3. Risk score per claim, used to decide which claims need a human and which low-risk
   claims may pass automatically once their quote is confirmed.

None of this proves a claim is true. It proves the quote exists and flags what a
person should look at first.
"""
import argparse
import hashlib
from difflib import SequenceMatcher
import json
from pathlib import Path
import re
import unicodedata
from urllib.parse import urlsplit
import urllib.error
import urllib.request
from html_model import Document
from safe_http import safe_get, UnsafeURL, TransportUnavailable
from qa_common import finding, emit, exit_code

SKILL = Path(__file__).resolve().parents[1]
HIGH_RISK_KINDS = {'legal': 5, 'list': 5, 'negative': 4, 'statistic': 3, 'company_response': 3}
HIGH_RISK_THRESHOLD = 3
# Generic legal/list/negative wording (not issue-specific). Used only to stop under-labelling.
LEGAL_WORDS = r'export controls?|indict|charged|pleaded guilty|licen[cs]e requirement|名单|清单|制裁|禁令|禁止|生效|列入|移出|许可证|出口管制|法规|规则|条例|起诉|裁定|未发现|未列入|并未|尚未达成|sanction|entity list|\bban\b|prohibit'
MAX_BYTES = 3_000_000


def load_domains(path=None):
    p = Path(path) if path else SKILL / 'references' / 'source_domains.json'
    try:
        return json.loads(p.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {'official_suffixes': ['.gov', '.mil'], 'official_hosts': [], 'news_hosts': []}


def host_of(url):
    try:
        return (urlsplit(url).hostname or '').lower()
    except ValueError:
        return ''


def host_matches(host, entries):
    return any(host == e or host.endswith('.' + e) for e in entries)


def is_official(host, domains):
    return host_matches(host, domains.get('official_hosts', [])) or any(
        host.endswith(s) for s in domains.get('official_suffixes', []))


def is_news(host, domains):
    return host_matches(host, domains.get('news_hosts', []))


def norm(text):
    """Normalise width, quotes, dashes, case and whitespace for quote matching."""
    t = unicodedata.normalize('NFKC', text or '')
    t = re.sub(r'[‘’‚‛′`´]', "'", t)
    t = re.sub(r'[“”„‟″«»「」『』]', '"', t)
    t = re.sub(r'[‐-―−]', '-', t)
    t = re.sub(r'\s+', ' ', t).strip().lower()
    return t


MONTHS = {m: str(i + 1) for i, m in enumerate(
    'january february march april may june july august september october november december'.split())}
MONTHS.update({m[:3]: n for m, n in list(MONTHS.items())})
MONTHS['sept'] = '9'  # "Sept." is common in company tables (e.g. monthly revenue)


def date_numbers(*values):
    """Year/month/day numbers from recorded ISO dates, so a claim's date need not be in the quote."""
    out = set()
    for v in values:
        m = re.match(r'(\d{4})-(\d{2})-(\d{2})', str(v or ''))
        if m:
            out |= {str(int(x)) for x in m.groups()}
    return out


def fmt(x):
    s = f'{x:.4f}'.rstrip('0').rstrip('.')
    return s


def numbers_in(text):
    """Arabic-digit numbers (thousands separators removed) plus month names as numbers."""
    t = unicodedata.normalize('NFKC', text or '')
    nums = {fmt(float(m.replace(',', ''))) for m in re.findall(r'\d+(?:,\d{3})*(?:\.\d+)?', t)}
    nums |= {MONTHS[w] for w in re.findall(r'[a-z]+', t.lower()) if w in MONTHS}
    return nums


def claim_numbers(text):
    """Numbers in a (Chinese) claim with acceptable equivalents for 亿/万 units."""
    t = unicodedata.normalize('NFKC', text or '')
    out = []
    for m in re.finditer(r'(\d+(?:,\d{3})*(?:\.\d+)?)\s*(亿|万)?', t):
        n = float(m[1].replace(',', ''))
        eq = {fmt(n)}
        if m[2] == '亿':
            eq |= {fmt(n * 100), fmt(n / 10)}      # hundred million = 100 million = 0.1 billion
        elif m[2] == '万':
            eq |= {fmt(n * 10), fmt(n / 100)}      # ten thousand = 10 thousand = 0.01 million
        out.append((fmt(n), eq))
    return out


def page_text(body, content_type=''):
    if 'pdf' in (content_type or '').lower() or body[:5] == b'%PDF-':
        return None  # PDF text extraction is not attempted here
    raw = body.decode('utf-8', errors='replace')
    if '<' in raw[:2000]:
        doc = Document(raw)
        return ''.join(s for s, _ in doc.visible_segments())
    return raw


def quote_found(quote, text):
    q, t = norm(quote), norm(text)
    if not q:
        return False, 0.0
    if q in t:
        return True, 1.0
    # tolerate small differences (punctuation, an elided word); never below 0.9
    m = SequenceMatcher(None, t, q, autojunk=False).find_longest_match(0, len(t), 0, len(q))
    if m.size / len(q) >= 0.9:
        return True, round(m.size / len(q), 2)
    # long quotes: accept if every sentence-sized piece is present
    pieces = [p for p in re.split(r'[.。;；!?！？]\s*', q) if len(p) >= 12]
    if len(pieces) >= 2 and all(p in t for p in pieces):
        return True, 0.95
    return False, round(m.size / len(q), 2)


def _classify(code, body, ctype):
    if code in (401, 402, 403, 407, 429, 451):
        return 'BLOCKED', None, code
    if not 200 <= code < 300:
        return 'ERROR', None, code
    text = page_text(body, ctype)
    if text is None:
        return 'PDF', None, code
    low = text.lower()
    if any(x in low for x in ('verify you are human', 'subscribe to continue', 'sign in to continue', 'access denied')):
        return 'BLOCKED', None, code
    return 'OK', text, code


def fetch(url, timeout, opener=None, resolver=None, transport=None):
    """Production: safe_http.safe_get. `opener` is a trusted test double only."""
    if opener is not None:
        req = urllib.request.Request(url, headers={'User-Agent': 'Briefing-QA/1.0 (test)'})
        try:
            with opener(req, timeout=timeout) as r:
                headers = getattr(r, 'headers', None)
                return _classify(getattr(r, 'status', 200), r.read(MAX_BYTES), headers.get('Content-Type', '') if headers else '')
        except urllib.error.HTTPError as e:
            return ('BLOCKED' if e.code in (401, 402, 403, 407, 429, 451) else 'ERROR'), None, e.code
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            return 'ERROR', None, None
    try:
        r = safe_get(url, timeout=timeout, max_bytes=MAX_BYTES, resolver=resolver, transport=transport)
        return _classify(r.status, r.body, r.headers.get('content-type', ''))
    except UnsafeURL:
        return 'UNSAFE', None, None
    except (TransportUnavailable, OSError, TimeoutError, ValueError):
        return 'ERROR', None, None


def read_snapshot(source, ledger_dir):
    """Return ('OK', text) / ('MISSING'|'HASH_MISMATCH'|'NONE', None)."""
    snap = source.get('snapshot')
    if not isinstance(snap, dict) or not snap.get('path'):
        return 'NONE', None
    base = Path(ledger_dir) if ledger_dir else Path('.')
    p = (base / snap['path']).resolve()
    try:
        if base.resolve() not in p.parents and p != base.resolve():
            return 'MISSING', None  # refuse paths outside the run folder
        data = p.read_bytes()
    except OSError:
        return 'MISSING', None
    if snap.get('sha256') and hashlib.sha256(data).hexdigest() != snap['sha256']:
        return 'HASH_MISMATCH', None
    return 'OK', page_text(data, 'text/html' if p.suffix.lower() in ('.html', '.htm') else 'text/plain') or ''


def claim_signals(c, domains):
    """Offline red flags for one claim. Returns list of (code, message)."""
    out = []
    sources = [s for s in (c.get('sources') or []) if isinstance(s, dict)]
    quotes = ' '.join(s.get('quote') or '' for s in sources)
    qnums = numbers_in(quotes)
    # Date parts written as 2026 年 10 月 5 日 may be backed by the recorded dates instead of the
    # quote. Only numbers in a date position qualify, so a figure such as "10 亿" still needs a quote.
    text = unicodedata.normalize('NFKC', c.get('text', ''))
    recorded = date_numbers(c.get('event_date'), *(s.get('publication_date') for s in sources))
    missing = set()
    for (n, eq), m in zip(claim_numbers(text), re.finditer(r'(\d+(?:,\d{3})*(?:\.\d+)?)\s*(亿|万)?', text)):
        mon = r'(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?'
        in_date = not m[2] and bool(re.match(r'\s*[年月日号]', text[m.end():])  # 2026 年 10 月 9 日
                                    or re.search(mon + r'\s*$', text[:m.start()], re.I)  # October 9 / Oct. 9
                                    or re.search(mon + r'\s+\d{1,2},?\s*$', text[:m.start()], re.I)  # year in "October 9, 2026"
                                    or re.match(r'\s*' + mon, text[m.end():], re.I))  # 9 October
        if not eq & qnums and not (in_date and n in recorded):
            missing.add(n)
    missing = sorted(missing)
    if missing:
        out.append(('NUMBER_NOT_IN_QUOTE',
                     f"Numbers {', '.join(missing)} in the claim appear in no recorded quote or recorded date; check the source or unit conversion"))
    for s in sources:
        host = host_of(s.get('url', ''))
        if s.get('evidence_type') == 'official_document' and not is_official(host, domains):
            out.append(('SOURCE_TYPE_MISMATCH', f'{host} is labelled official_document but is not a recognised government domain; '
                                                'a company newsroom or investor-relations page is company_statement'))
        if is_news(host, domains) and (s.get('source_role') == 'primary' or s.get('evidence_type') in ('official_document', 'dataset')):
            out.append(('SOURCE_TYPE_MISMATCH', f'{host} is a news site but labelled primary/{s.get("evidence_type")}'))
    kinds = set(k for k in (c.get('kinds') or []) if isinstance(k, str))
    if not kinds & {'legal', 'list', 'negative'} and re.search(LEGAL_WORDS, c.get('text', '')):
        out.append(('KIND_UNDERSTATED', 'Wording looks legal/list/negative but the claim is not labelled so; it is treated as high risk'))
    if sources and all(is_news(host_of(s.get('url', '')), domains) or s.get('evidence_type') == 'news' for s in sources):
        out.append(('MEDIA_ONLY', 'Supported only by media reporting; wording must attribute it ("reportedly", "according to Reuters" / 据报)'))
    return out


def risk_score(c, signals, quote_state):
    kinds = set(k for k in (c.get('kinds') or []) if isinstance(k, str))
    score = max([HIGH_RISK_KINDS.get(k, 0) for k in kinds] or [0])
    reasons = [k for k in kinds if k in HIGH_RISK_KINDS]
    for code in dict.fromkeys(code for code, _ in signals):
        score += 2 if code == 'MEDIA_ONLY' else 4
        reasons.append(code)
    if quote_state in ('NOT_FOUND',):
        score += 10; reasons.append('QUOTE_NOT_FOUND')
    elif quote_state in ('BLOCKED', 'ERROR', 'PDF', 'UNSAFE'):
        score += 2; reasons.append('QUOTE_UNCHECKABLE')
    return score, reasons


def validate_quotes(ledger, network=False, timeout=15, opener=None, domains=None, ledger_dir=None, resolver=None, transport=None):
    """Return (findings, per-claim risk dict {cid: {'score','reasons','quote_state','tier'}})."""
    items, risk = [], {}
    if not isinstance(ledger, dict) or not isinstance(ledger.get('claims'), list):
        return [finding('UNVERIFIED', 'QUOTE_CHECK_SKIPPED', 'No usable ledger')], risk
    domains = domains or load_domains()
    cache = {}
    unchecked = 0
    for c in ledger['claims']:
        if not isinstance(c, dict) or not isinstance(c.get('id'), str):
            continue
        cid = c['id']
        signals = claim_signals(c, domains)
        for code, msg in signals:
            if code != 'MEDIA_ONLY':
                items.append(finding('UNVERIFIED', code, msg, claim_id=cid))
        opened = [s for s in (c.get('sources') or []) if isinstance(s, dict)
                  and s.get('access_status') == 'opened' and (s.get('quote') or '').strip()]
        results = []
        for s in opened:
            url = s.get('url', '')
            snap_state, snap_text = read_snapshot(s, ledger_dir)
            if snap_state in ('MISSING', 'HASH_MISMATCH'):
                items.append(finding('FAIL', 'SNAPSHOT_' + snap_state,
                                     'Snapshot file missing or outside the run folder' if snap_state == 'MISSING'
                                     else 'Snapshot file changed after its fingerprint was recorded', claim_id=cid, url=url))
                results.append('NOT_FOUND'); continue
            in_snap = None
            if snap_state == 'OK':
                in_snap, ratio = quote_found(s['quote'], snap_text)
                if not in_snap:
                    items.append(finding('FAIL', 'QUOTE_NOT_FOUND', f'Quote is not in the saved snapshot (best match {ratio:.0%})', claim_id=cid, url=url))
            live = None
            if network:
                if url not in cache:
                    cache[url] = fetch(url, timeout, opener, resolver, transport)
                status, text, code = cache[url]
                if status == 'OK':
                    live, ratio = quote_found(s['quote'], text)
                    if not live and in_snap is None:
                        items.append(finding('FAIL', 'QUOTE_NOT_FOUND',
                                             f'Page fetched (HTTP {code}) but the recorded quote is not on it (best match {ratio:.0%}). Quote may be invented or from another page',
                                             claim_id=cid, url=url))
                    elif not live and in_snap:
                        items.append(finding('UNVERIFIED', 'SNAPSHOT_LIVE_DIFFER', 'Quote is in the snapshot but not on the live page; the page may have changed or the snapshot may be wrong', claim_id=cid, url=url))
                elif status == 'UNSAFE':
                    items.append(finding('FAIL', 'UNSAFE_URL', 'Source URL or redirect points to a non-public address; not fetched', claim_id=cid, url=url))
                elif in_snap is None:
                    items.append(finding('UNVERIFIED', 'QUOTE_UNCHECKABLE',
                                         {'BLOCKED': 'Source blocked/paywalled; save a snapshot when you read it, or a person must open it',
                                          'PDF': 'PDF source; save the relevant text as a snapshot, or a person must confirm the quote',
                                          'ERROR': 'Source could not be fetched'}[status], claim_id=cid, url=url, http_status=code))
            if in_snap is False or live is False and in_snap is None:
                results.append('NOT_FOUND')
            elif in_snap or live:
                results.append('FOUND')
            elif network:
                results.append(cache.get(url, ('ERROR',))[0])
            else:
                results.append('UNCHECKED')
        if not opened:
            state = 'NO_QUOTE'
        elif 'NOT_FOUND' in results:
            state = 'NOT_FOUND'
        elif 'FOUND' in results:
            state = 'FOUND'
        else:
            state = results[0]
            if state == 'UNCHECKED':
                unchecked += 1
        if state == 'FOUND':
            items.append(finding('PASS', 'QUOTE_FOUND', 'Recorded quote found in the source (does not prove the claim follows from it)', claim_id=cid))
        score, reasons = risk_score(c, signals, state)
        risk[cid] = {'score': score, 'reasons': reasons, 'quote_state': state,
                     'tier': 'high' if score >= HIGH_RISK_THRESHOLD else 'low'}
    if unchecked:
        items.append(finding('UNVERIFIED', 'QUOTE_UNCHECKED',
                             f'{unchecked} claim quotes not checked (offline, no snapshot). Save snapshots or run with --network so low-risk claims can pass automatically'))
    return items, risk


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--ledger', required=True)
    ap.add_argument('--network', action='store_true')
    ap.add_argument('--timeout', type=float, default=15)
    ap.add_argument('--json', dest='json_path')
    args = ap.parse_args()
    ledger = json.loads(Path(args.ledger).read_text(encoding='utf-8'))
    items, risk = validate_quotes(ledger, args.network, args.timeout, ledger_dir=Path(args.ledger).resolve().parent)
    emit(items, args.json_path)
    for cid, r in sorted(risk.items(), key=lambda kv: -kv[1]['score']):
        print(f"{cid}: risk {r['score']} ({r['tier']}) quote={r['quote_state']} {', '.join(r['reasons'])}")
    return exit_code(items)


if __name__ == '__main__':
    raise SystemExit(main())
