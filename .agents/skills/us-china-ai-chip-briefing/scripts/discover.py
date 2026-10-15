#!/usr/bin/env python3
"""Scripted news discovery for a reporting window: candidates, not evidence.

  python3 scripts/discover.py --start 2026-10-09 --end 2026-10-15 --out runs/2026-10-15 [--tz Asia/Hong_Kong]

Sweeps official APIs and listings (Federal Register, DOJ, BIS, Treasury/OFAC, USTR, MOFCOM, State Council, MIIT,
CAC), company and outlet RSS feeds, and date-bounded news searches (theme, outlet and open-ended queries) as listed in
references/discovery_sources.json. Items are filtered to the window, scored for topic and US-China relevance, and
clustered into candidate events without merging reports that name different people or companies.

Writes RUN/events.json (structured), RUN/candidates.md (ranked table for the writer) and RUN/discovery_log.json
(every source checked, with its access status). Everything here is discovery metadata as published by feeds and
listings: titles, publishers and dates are what the source says, nothing is verified, and aggregator links must be
resolved to the original before any claim is made. Blocked sources are recorded and skipped, never bypassed.
"""
import argparse
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
import html
import json
from pathlib import Path
import re
import sys
import time
from urllib.parse import urlencode, urljoin, quote_plus
from xml.etree import ElementTree as ET

SCRIPTS = Path(__file__).resolve().parent
SKILL = SCRIPTS.parent
sys.path.insert(0, str(SCRIPTS))

GENERIC_ENTITIES = {'us', 'u.s', 'u.s.', 'china', 'chinese', 'beijing', 'washington', 'ai', 'exclusive', 'the', 'reuters', 'bloomberg',
                    'nvidia', 'commerce', 'justice', 'department', 'trump', 'xi', 'america', 'american', 'asia', 'global', 'new',
                    'report', 'update', 'breaking', 'analysis', 'chip', 'chips', 'gpu', 'gpus', 'semiconductor', 'tech', 'us-china',
                    'with', 'after', 'over', 'amid', 'how', 'why', 'what', 'says', 'as', 'in', 'on', 'for', 'to', 'of', 'and', 'a', 'an'}
STOP = GENERIC_ENTITIES | {'from', 'its', 'into', 'than', 'that', 'this', 'will', 'more', 'about', 'could', 'would', 'their', 'has',
                           'have', 'are', 'was', 'were', 'not', 'but', 'by', 'at', 'be', 'is', 'it', 'his', 'her', 'they', 'year', 'week'}


# ------------------------------------------------------------------ fetching
def fetcher():
    from safe_http import safe_get

    def get(url, retries=2):
        last = None
        for attempt in range(retries + 1):
            try:
                r = safe_get(url, timeout=20, max_bytes=5_000_000)
                return r.status, r.body.decode('utf-8', errors='replace'), r.url
            except Exception as e:  # network/TLS/unsafe: record, never bypass
                last = f'{type(e).__name__}: {str(e)[:100]}'
                time.sleep(1.5 * (attempt + 1))
        return None, last, url
    return get


# ------------------------------------------------------------------ dates
def to_local(dt, tz):
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(tz)


DATE_PATTERNS = [
    (re.compile(r'(20\d\d)-(\d{1,2})-(\d{1,2})'), lambda m: (m[1], m[2], m[3])),
    (re.compile(r'(20\d\d)年(\d{1,2})月(\d{1,2})日'), lambda m: (m[1], m[2], m[3])),
    (re.compile(r'(\d{1,2})/(\d{1,2})/(20\d\d)'), lambda m: (m[3], m[1], m[2])),
    (re.compile(r'(20\d\d)-(\d\d)/(\d\d)/'), lambda m: (m[1], m[2], m[3])),          # /2026-10/14/ (CAC)
    (re.compile(r'[/_t](20\d\d)(\d\d)(\d\d)[_/.]'), lambda m: (m[1], m[2], m[3])),   # t20261014_ (gov.cn)
    (re.compile(r'\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2}),\s*(20\d\d)'),
     lambda m: (m[3], str(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].index(m[1][:3]) + 1), m[2])),
    (re.compile(r'(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(20\d\d)'),
     lambda m: (m[3], str(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
                           'November', 'December'].index(m[1]) + 1), m[2])),
]


def find_date(text):
    for pat, parts in DATE_PATTERNS:
        m = pat.search(text)
        if m:
            try:
                y, mo, d = (int(x) for x in parts(m))
                return date(y, mo, d)
            except ValueError:
                continue
    return None


# ------------------------------------------------------------------ parsers -> items
def item(title, url, published, source, kind, publisher='', summary='', official=False, access='listed'):
    title = html.unescape(re.sub(r'\s+', ' ', title or '')).strip()
    return {'title': title, 'url': url, 'published': published.isoformat() if published else None,
            'publisher': publisher, 'source_id': source, 'via': kind, 'summary': html.unescape(re.sub(r'<[^>]+>', ' ', summary or ''))[:300].strip(),
            'official': official, 'link_type': 'aggregator' if re.search(r'news\.google\.com|bing\.com/news', url or '') else 'direct',
            'access': access}


def parse_rss(body, source, kind, tz, publisher=''):
    out = []
    root = ET.fromstring(body)
    for it in root.iter('item'):
        title = it.findtext('title') or ''
        pub = it.findtext('pubDate') or it.findtext('{http://purl.org/dc/elements/1.1/}date')
        try:
            when = to_local(parsedate_to_datetime(pub), tz).date() if pub else None
        except (TypeError, ValueError):
            when = find_date(pub or '')
        src = it.findtext('source') or publisher
        if kind == 'google_news' and src and title.endswith(' - ' + src):
            title = title[: -len(src) - 3]
        out.append(item(title, it.findtext('link'), when, source, kind, src, it.findtext('description') or ''))
    return out


def parse_listing(body, base, source):
    """Anchors on an official listing page with a date in the anchor or within ~250 characters after it."""
    out, seen = [], set()
    for m in re.finditer(r'<a\b[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]{4,400}?)</a>', body):
        href, label = m[1], re.sub(r'<[^>]+>', ' ', m[2])
        label = html.unescape(re.sub(r'\s+', ' ', label)).strip()
        if len(label) < 6 or href.startswith(('javascript', 'mailto')):
            continue
        url = urljoin(base, href)
        if url in seen:
            continue
        after = body[m.end():m.end() + 250]
        after = after[:after.find('<a ')] if '<a ' in after else after  # never borrow the next entry's date
        when = find_date(label) or find_date(re.sub(r'<[^>]+>', ' ', after)) or find_date(url)
        month = None
        if not when:
            mm = re.search(r'/(20\d\d)(\d\d)/content_', url)  # gov.cn policy URLs carry only the month
            if not mm:
                continue
            month = f'{mm[1]}-{mm[2]}'
        seen.add(url)
        out.append(item(label, url, when, source, 'listing', '', official=True))
        if month:
            out[-1]['published_month'] = month
    return out


def parse_fr(body, source):
    out = []
    for x in json.loads(body).get('results') or []:
        when = date.fromisoformat(x['publication_date']) if x.get('publication_date') else None
        agencies = ', '.join(a.get('name', '') for a in x.get('agencies') or [] if isinstance(a, dict))
        out.append(item(x.get('title', ''), x.get('html_url'), when, source, 'fr_api', agencies or 'Federal Register',
                        (x.get('abstract') or ''), official=True))
        out[-1]['api_url'] = f"https://www.federalregister.gov/api/v1/documents/{x.get('document_number')}.json"
    return out


def parse_doj(body, source, tz):
    out = []
    for x in json.loads(body).get('results') or []:
        try:
            when = to_local(datetime.fromtimestamp(int(x.get('date')), timezone.utc), tz).date()
        except (TypeError, ValueError):
            when = None
        comps = x.get('component')
        comp = ', '.join(c.get('name', '') for c in comps if isinstance(c, dict)) if isinstance(comps, list) else ''
        body_text = re.sub(r'<[^>]+>', ' ', x.get('body') or '')
        out.append(item(x.get('title', ''), x.get('url'), when, source, 'doj_api', 'U.S. Department of Justice' + (f' ({comp})' if comp else ''),
                        body_text, official=True))
    return out


# ------------------------------------------------------------------ relevance
class Scorer:
    """Topic keywords x US-China dimension x source quality. Transparent and editable; a ranking aid, not a judgment."""

    def __init__(self, lex):
        self.strong = re.compile(lex.get('strong_publishers', '$^'), re.I)
        self.weak = re.compile(lex.get('weak_publishers', '$^'), re.I)
        self.topic = [(re.compile(p, re.I), w) for p, w in lex['topic'].items()]
        self.china, self.us, self.third = (re.compile(lex[k], re.I) for k in ('china', 'us', 'third'))

    def __call__(self, it):
        text = f"{it['title']} {it['summary']}"
        hits = [(p.pattern.split('|')[0], w) for p, w in self.topic if p.search(text)]
        topic = sum(w for _, w in hits)
        cn, us, th = bool(self.china.search(text)), bool(self.us.search(text)), bool(self.third.search(text))
        dim = 'us-china' if cn and (us or th) else 'china' if cn else 'us' if us else 'third-country' if th else 'none'
        mult = {'us-china': 1.6, 'china': 1.2, 'us': 0.8, 'third-country': 0.8, 'none': 0.3}[dim]
        pub = f"{it.get('publisher', '')} {it.get('url', '')}"
        quality = 1.3 if it.get('official') or self.strong.search(pub) else 0.6 if self.weak.search(pub) else 1.0
        score = round(topic * mult * quality + (2 if it.get('official') and topic else 0), 1)
        return {'score': score, 'topics': [h for h, _ in hits], 'dimension': dim, 'quality': quality}


# ------------------------------------------------------------------ clustering (conservative)
SYNONYM = {'firms': 'company', 'firm': 'company', 'companies': 'company', 'bought': 'buy', 'buys': 'buy', 'purchase': 'buy',
           'purchased': 'buy', 'purchases': 'buy', 'chips': 'chip', 'gpus': 'gpu', 'shipments': 'shipment', 'falls': 'fall',
           'fell': 'fall', 'drops': 'fall', 'slips': 'fall', 'reportedly': 'report', 'reports': 'report', 'pleads': 'plead',
           'pleaded': 'plead', 'mn': 'million', '1mn': '1 million'}


def norm_word(w):
    w = SYNONYM.get(w, w)
    return w[:-1] if len(w) > 4 and w.endswith('s') and not w.endswith('ss') else w


def figures(title):
    t = title.lower().replace(',', '')
    out = set(re.findall(r'\d+(?:\.\d+)?\s?%', t)) | set(re.findall(r'\d+(?:\.\d+)?\s?(?:million|billion|bn|mn|m\b|b\b)', t))
    return {re.sub(r'\s', '', x).replace('mn', 'million').replace('bn', 'billion') for x in out}


def tokens(title):
    t = title.lower()
    words = {norm_word(w) for w in re.findall(r'[a-z][a-z0-9\-]{2,}', t) if w not in STOP}
    cjk = ''.join(re.findall(r'[一-鿿]+', title))
    bigrams = {cjk[i:i + 2] for i in range(len(cjk) - 1)}
    return words | bigrams


KNOWN = re.compile(r"Super Micro|Supermicro|Nvidia|AMD|Intel|Qualcomm|Broadcom|Marvell|Micron|Applied Materials|Lam Research|KLA|"
                   r"OpenAI|Google|DeepMind|Microsoft|Amazon|AWS|Meta|Anthropic|xAI|Huawei|SMIC|Hua Hong|Cambricon|Alibaba|Tencent|"
                   r"ByteDance|DeepSeek|Baidu|Zhipu|Moonshot|MiniMax|Xiaomi|YMTC|CXMT|TSMC|ASML|Samsung|SK Hynix|Arm|MediaTek|Iluvatar|"
                   r"Tianyang|Lenovo|Inspur|Apple|Earthmade", re.I)


def key_entities(title):
    """Distinctive names and figures. Known company names and ALL-CAPS tokens always count; other capitalised words
    count only in sentence-case titles, where capitals mark names (Title Case headlines capitalise every word)."""
    ents = {m.lower().replace(' ', '') for m in KNOWN.findall(title)}
    words = re.findall(r"[A-Za-z][A-Za-z0-9&'.-]*", title)
    title_case = words and sum(w[0].isupper() for w in words) / len(words) > 0.6
    for w in words:
        lw = w.lower().strip(".'")
        if lw in GENERIC_ENTITIES or len(lw) < 2:
            continue
        if (w.isupper() and len(w) > 1) or (not title_case and w[0].isupper() and words.index(w) > 0):
            ents.add(lw.replace(' ', ''))
    ents |= {m.lower() for m in re.findall(r'\$\s?\d[\d.,]*\s?(?:bn|billion|million|m)?|\d+(?:\.\d+)?%', title)}
    ents |= set(re.findall(r'[一-鿿]{2,6}(?:公司|集团|科技|电子|半导体|部|局|委员会)', title))
    return ents


def same_event(a, b):
    """Merge only when titles overlap AND, if both name distinctive entities, they share one."""
    ta, tb = a['_tok'], b['_tok']
    if not ta or not tb:
        return False
    sim = len(ta & tb) / len(ta | tb)
    ea, eb = a['_ent'], b['_ent']
    shared = ea & eb
    da, db = ea - GENERIC_ENTITIES, eb - GENERIC_ENTITIES
    if da and db and not (da & db):
        return False  # different distinctive names, e.g. two DOJ cases that only share "Nvidia", "China", "smuggling"
    try:
        gap = abs((date.fromisoformat(a['published']) - date.fromisoformat(b['published'])).days)
    except (TypeError, ValueError):
        gap = 0
    if gap > 3:
        return False
    same_figure = bool(a['_fig'] & b['_fig'])
    return sim >= 0.5 or (sim >= 0.25 and len(shared) >= 2) or (sim >= 0.35 and len(shared) >= 1) or (same_figure and sim >= 0.15)


def cluster(items):
    clusters = []
    for it in sorted(items, key=lambda x: -x['relevance']['score']):
        it['_tok'], it['_ent'], it['_fig'] = tokens(it['title']), key_entities(it['title']), figures(it['title'])
        home = next((c for c in clusters if any(same_event(it, m) for m in c)), None)
        if home is None:
            clusters.append([it])
        else:
            home.append(it)
    return clusters


# ------------------------------------------------------------------ main sweep
def plan(cfg, start, end, tz):
    """Every request of the sweep as (source_id, label, url, parser, flags). Pure: no network."""
    reqs = []
    end_excl = end + timedelta(days=1)
    for s in cfg['official_api']:
        if s['kind'] == 'fr_api':
            queries = [s.get('params', {})] if 'params' in s else [{'conditions[term]': q} for q in s['terms']]
            for q in queries:
                params = {**q, 'conditions[publication_date][gte]': start.isoformat(), 'conditions[publication_date][lte]': end.isoformat(),
                          'per_page': 100, 'order': 'newest'}
                reqs.append((s['id'], s['name'] + (f" [{q['conditions[term]']}]" if 'conditions[term]' in q else ''),
                             'https://www.federalregister.gov/api/v1/documents.json?' + urlencode(params), 'fr', {}))
        elif s['kind'] == 'doj_api':
            reqs.append((s['id'], s['name'], 'https://www.justice.gov/api/v1/press_releases.json?pagesize=50&page=0&sort=date&direction=DESC',
                         'doj', {'pages': s.get('pages', 20)}))
    for s in cfg['official_listing']:
        reqs.append((s['id'], s['name'], s['url'], 'listing', {'keep_all': bool(s.get('keep_all'))}))
    for s in cfg['rss']:
        reqs.append((s['id'], s['name'], s['url'], 'rss', {'publisher': s['name']}))
    ns = cfg['news_search']
    span = f' after:{start.isoformat()} before:{end_excl.isoformat()}'
    queries = [(q, 'en') for q in ns['themes_en']] + [(q, 'zh') for q in ns['themes_zh']]
    queries += [(f"{ns['outlet_query']} site:{o}", 'en') for o in ns['outlets']]
    queries += [(q, 'en') for q in ns['open_en']] + [(q, 'zh') for q in ns['open_zh']]
    for key, lang in (('official_domains_zh', 'zh'), ('official_domains_en', 'en')):
        spec = ns.get(key) or {}
        queries += [(f"{spec['query']} site:{d}", lang) for d in spec.get('domains', [])]
    policy = []
    for q, lang in queries:
        hl = {'en': ('en-US', 'US', 'US:en'), 'zh': ('zh-CN', 'CN', 'CN:zh-Hans')}[lang]
        url = 'https://news.google.com/rss/search?' + urlencode({'q': q + span, 'hl': hl[0], 'gl': hl[1], 'ceid': hl[2]})
        is_policy = (q, lang) in policy
        reqs.append((f'google_news:{lang}', q, url, 'news', {'official': bool(re.search(r'site:\S*(?:gov\.cn|\.gov)\b', q)) and not is_policy,
                                                            'policy': is_policy}))
    if (datetime.now(tz).date() - end).days <= 1:  # Bing RSS cannot be bounded to past windows: only for "past week" runs
        for q in ns['themes_en'][:6] + ns['open_en'][:2]:
            reqs.append(('bing:en', q, 'https://www.bing.com/news/search?' + urlencode({'q': q, 'format': 'rss', 'qft': 'interval="8"'}), 'news', {}))
    return reqs


def sweep(cfg, start, end, tz, get, log, max_news_queries=80, workers=6):
    """Fetch the planned requests in parallel (news searches throttled to 3 at a time), then parse in plan order."""
    from concurrent.futures import ThreadPoolExecutor
    reqs = plan(cfg, start, end, tz)
    news = [r for r in reqs if r[3] == 'news'][:max_news_queries]
    other = [r for r in reqs if r[3] != 'news']
    with ThreadPoolExecutor(workers) as pool:
        got = list(pool.map(lambda r: get(r[2]), other))
    with ThreadPoolExecutor(3) as pool:
        got += list(pool.map(lambda r: get(r[2]), news))
    items = []

    months = {start.strftime('%Y-%m'), end.strftime('%Y-%m')}

    def keep(batch):
        # month-only dates (gov.cn policy URLs) are kept when the month overlaps the window and flagged for the writer
        inside = [x for x in batch if (x['published'] and start <= date.fromisoformat(x['published']) <= end)
                  or (not x['published'] and x.get('published_month') in months and x.get('keep_all'))]
        items.extend(inside)
        return len(inside)

    for r, (st, body, final) in zip(other + news, got):
        sid, label, url, parser, flags = r
        batch = []
        try:
            if st == 200:
                if parser == 'fr':
                    batch = parse_fr(body, sid)
                elif parser == 'doj':
                    batch = parse_doj(body, sid, tz)
                    page = 1
                    while page < flags['pages'] and batch and not all(x['published'] and date.fromisoformat(x['published']) < start for x in batch[-50:]):
                        st2, body2, _ = get(url.replace('page=0', f'page={page}'))
                        if st2 != 200:
                            break
                        batch += parse_doj(body2, sid, tz)
                        page += 1
                    label = f'{label} ({page} pages)'
                elif parser == 'listing':
                    batch = parse_listing(body, final or url, sid)
                elif parser == 'rss':
                    batch = parse_rss(body, sid, 'rss', tz, flags.get('publisher', ''))
                else:
                    batch = parse_rss(body, f'{sid}:{label}', 'google_news' if sid.startswith('google') else 'bing', tz)
        except (ET.ParseError, ValueError) as e:
            st = f'unparseable ({type(e).__name__})'
        for x in batch:
            x['keep_all'] = bool(flags.get('keep_all') or flags.get('policy'))
            if flags.get('official'):
                x['official_domain'] = True  # found via a search restricted to an official domain: a lead, ranked with news
            if flags.get('policy'):
                x['official'] = True  # top-level policy document listing (official domain); still unverified
        log.append({'id': sid, 'name': label, 'url': url, 'status': st if st is not None else body,
                    'items_in_window': keep(batch), 'note': '' if st == 200 else 'unavailable to the script; not bypassed'})
    return items


def build_events(items, scorer, min_score):
    seen_urls, uniq = set(), []
    for it in items:
        key = it['url'] or it['title']
        if key in seen_urls:
            continue
        seen_urls.add(key)
        it['relevance'] = scorer(it)
        # Official items are the primary channel: kept when they touch the topic at all, or when they come from a small
        # ministry listing flagged keep_all / a domain-restricted search (already filtered by its query).
        if it['relevance']['score'] >= min_score or (it.get('official') and (it['relevance']['topics'] or it.get('keep_all'))):
            uniq.append(it)
    events = []
    clusters = cluster(uniq)
    rank = lambda c: max(x['relevance']['score'] for x in c) + max(0.0, min(3.0, 0.5 * (len({x['publisher'] for x in c if x['publisher']}) - 1)))
    for i, c in enumerate(sorted(clusters, key=lambda c: -rank(c)), 1):
        lead = max(c, key=lambda x: (x['official'], x['relevance'].get('quality', 1), x['relevance']['score']))
        dims = {x['relevance']['dimension'] for x in c}
        dim = 'us-china' if 'us-china' in dims else next(iter(dims))
        side = {'us-china': 'both', 'china': 'cn', 'us': 'us'}.get(dim, 'other')
        pubs = sorted({x['publisher'] for x in c if x['publisher']})
        events.append({
            'id': f'D{i:03d}', 'title': lead['title'], 'side': side,
            'first_reported': min((x['published'] for x in c if x['published']), default=None)
                              or next((x['published_month'] + ' (month only)' for x in c if x.get('published_month')), None),
            'event_date': None,
            'relevance': {'score': round(max(x['relevance']['score'] for x in c) + max(0.0, min(3.0, 0.5 * (len(pubs) - 1))), 1), 'dimension': dim,
                          'topics': sorted({t for x in c for t in x['relevance']['topics']}),
                          'reports': len(c), 'official_source': any(x['official'] for x in c)},
            'publishers': pubs,
            'items': [{k: v for k, v in x.items() if not k.startswith('_') and k not in ('relevance', 'keep_all')} for x in c],
            'status': 'discovered', 'evidence': 'none: discovery metadata only (title/date/publisher as listed by the feed)',
        })
    return events


def write_outputs(out, start, end, tz, events, log, elapsed, top=40):
    out.mkdir(parents=True, exist_ok=True)
    blocked = [l for l in log if l['status'] != 200]
    doc = {'schema': 'discovery-v1', 'window': {'start': start.isoformat(), 'end': end.isoformat(), 'timezone': str(tz)},
           'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'elapsed_seconds': round(elapsed, 1),
           'note': 'Discovery metadata, not evidence. Verify every fact from the original page before using it.',
           'sources_checked': len(log), 'sources_unavailable': len(blocked), 'candidates': events}
    (out / 'events.json').write_text(json.dumps(doc, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    (out / 'discovery_log.json').write_text(json.dumps(log, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    def row(e):
        it = next((x for x in e['items'] if x['link_type'] == 'direct'), e['items'][0])
        pubs = ', '.join(e['publishers'][:4]) + (f' +{len(e["publishers"]) - 4}' if len(e['publishers']) > 4 else '')
        return (f"| {e['id']} | {e['first_reported'] or '—'} | {e['relevance']['score']} | {e['side']} | "
                f"{e['title'].replace('|', '/')[:110]} | {pubs.replace('|', '/')} | {it['url']} |")
    head = '| ID | First reported | Score | Side | Title | Reported by | Link |\n|---|---|---:|---|---|---|---|'
    official = [e for e in events if e['relevance']['official_source']]
    news = [e for e in events if not e['relevance']['official_source']]  # includes official-domain search leads
    lines = [f'# Discovery candidates {start} → {end} ({tz})', '',
             f'{len(events)} candidate events from {len(log)} source checks ({len(blocked)} unavailable). **Nothing here is verified.** '
             'Titles, dates and publishers are as listed by feeds. Aggregator links (news.google.com, bing.com) are not the original: '
             'find the publisher or official page before quoting. Record a decision in coverage.json for every relevant candidate, '
             'including official items you exclude.', '',
             f'## A. Official sources in the window ({len(official)}; keyword score not required)', '', head]
    lines += [row(e) for e in official]
    lines += ['', f'## B. News and company candidates, top {min(top, len(news))} of {len(news)} by score (rest in events.json)', '', head]
    lines += [row(e) for e in news[:top]]
    if blocked:
        lines += ['', '## Sources unavailable to the script (not evidence of anything)', '']
        lines += [f"- {l['name']}: {l['status']}" for l in blocked]
    (out / 'candidates.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--start', required=True); ap.add_argument('--end', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--tz', default='Asia/Hong_Kong'); ap.add_argument('--min-score', type=float, default=3)
    ap.add_argument('--max-news-queries', type=int, default=80); ap.add_argument('--sources', default=str(SKILL / 'references' / 'discovery_sources.json'))
    a = ap.parse_args()
    from zoneinfo import ZoneInfo
    tz = ZoneInfo(a.tz)
    start, end = date.fromisoformat(a.start), date.fromisoformat(a.end)
    cfg = json.loads(Path(a.sources).read_text(encoding='utf-8'))
    t0, log = time.time(), []
    items = sweep(cfg, start, end, tz, fetcher(), log, a.max_news_queries)
    events = build_events(items, Scorer(cfg['lexicon']), a.min_score)
    write_outputs(Path(a.out), start, end, tz, events, log, time.time() - t0)
    print(f'{len(items)} items in window → {len(events)} candidate events (score ≥ {a.min_score}); '
          f'{sum(1 for l in log if l["status"] != 200)} of {len(log)} source checks unavailable; {time.time() - t0:.0f}s')
    print(f'Wrote {Path(a.out) / "candidates.md"}, events.json, discovery_log.json')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
