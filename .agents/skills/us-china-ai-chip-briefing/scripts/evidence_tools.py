"""Deterministic evidence bookkeeping, so the model spends its effort on reading and judging.

register_source: save a page (fetched now, or text the agent already has) as RUN/sources/S###.txt, record URL,
    title, HTTP/access status and a publication date only when the page states it in metadata. Re-registering the
    same URL returns the existing ID. Blocked or failed fetches are recorded too (they are evidence of access
    limits, never of falsity).
add_claim: locate the agent's quote in the saved text (exact or near-exact, never paraphrase); on success write a
    complete ledger claim with snapshot hash and inferred labels; on failure show the closest passages and write
    nothing. It never invents a quote, a date or a "verified" status.
"""
from datetime import datetime, timezone
from difflib import SequenceMatcher
import hashlib
import json
import os
from pathlib import Path
import re

from check_quotes import page_text, quote_found, norm, host_of, is_official, is_news, load_domains, LEGAL_WORDS, claim_numbers

DATE_META = [
    r'<meta[^>]+(?:property|name|itemprop)=["\'](?:article:published_time|og:article:published_time|pubdate|publishdate|PubDate|datePublished|dc\.date|DC\.Date|publish_date|date)["\'][^>]+content=["\']([^"\']+)',
    r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name|itemprop)=["\'](?:article:published_time|PubDate|datePublished|publishdate)["\']',
    r'"datePublished"\s*:\s*"([^"]+)"',
    r'<time[^>]+datetime=["\']([^"\']+)',
]
ISO = re.compile(r'(20\d\d)[-/.年](\d{1,2})[-/.月](\d{1,2})')
EN_DATE = re.compile(r'\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),\s*(20\d\d)\b')
MON = {m: i + 1 for i, m in enumerate('Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split())}
MON['Sept'] = 9


def _load(path, default):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except FileNotFoundError:
        return default


def _save(path, obj):
    Path(path).write_text(json.dumps(obj, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def _iso(y, m, d):
    try:
        return datetime(int(y), int(m), int(d)).date().isoformat()
    except ValueError:
        return None


def detect_dates(raw, text):
    """(stated_date, candidates): a date only when metadata states it; text dates are only suggestions."""
    stated = None
    for pat in DATE_META:
        m = re.search(pat, raw, re.I)
        if m and ISO.search(m[1]):
            stated = _iso(*ISO.search(m[1]).groups())
            break
    if stated is None and raw.lstrip().startswith('{'):
        m = re.search(r'"publication_date"\s*:\s*"(\d{4}-\d{2}-\d{2})"', raw)
        stated = m[1] if m else None
    head = text[:3000]
    cands = [_iso(*m.groups()) for m in ISO.finditer(head)] + [_iso(m[3], MON[m[1][:4] if m[1] == 'Sept' else m[1][:3]], m[2]) for m in EN_DATE.finditer(head)]
    seen = []
    for c in cands:
        if c and c not in seen:
            seen.append(c)
    return stated, seen[:4]


MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
               'November', 'December']
MIN_UNDATED_REASON = 12


def date_on_page(day, text, url=''):
    """The text on the saved page (or in its URL) that writes `day`, or None. Formats: 2026-11-19, 2026/11/19,
    2026.11.19, 2026年11月19日, November 19, 2026, 19 November 2026, Nov. 19, 2026, 11/19/2026, 11/19/26, 20261119."""
    import unicodedata
    y, m, d = day.year, day.month, day.day
    mon = MONTH_NAMES[m - 1][:3]
    pats = [rf'(?<!\d){y}\s*[-/.年]\s*0?{m}\s*[-/.月]\s*0?{d}(?!\d)',
            rf'\b{mon}[a-z]*\.?\s+0?{d}(?:st|nd|rd|th)?,?\s+{y}\b',
            rf'(?<!\d)0?{d}(?:st|nd|rd|th)?\s+{mon}[a-z]*\.?,?\s+{y}\b',
            rf'(?<!\d)0?{m}[/.]0?{d}[/.](?:{y}|{y % 100:02d})(?!\d)',
            rf'(?<!\d){y}{m:02d}{d:02d}(?!\d)']
    for hay in (unicodedata.normalize('NFKC', text or ''), url or ''):
        for pat in pats:
            hit = re.search(pat, hay, re.I)
            if hit:
                return ' '.join(hit[0].split())
    return None


def _parse_pub_date(value):
    """(date, None) for YYYY-MM-DD or an ISO timestamp with its UTC offset; (None, problem) otherwise."""
    try:
        if re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
            return datetime.strptime(value, '%Y-%m-%d').date(), None
        stamp = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None, f'{value!r} is neither YYYY-MM-DD nor an ISO timestamp'
    if stamp.tzinfo is None:
        return None, f'{value!r} has a time but no UTC offset; add the offset the source gives (e.g. -05:00), or record the date alone'
    return stamp.date(), None


def set_source_date(run, source_id, pub_date=None, shown=None, undated=None):
    """Record the publication date a saved page shows, or why it shows none, on the source and on every claim citing
    it. Returns (changed claim IDs or None, messages); writes nothing on a refusal.

    A page saved from a browser keeps only its text, so register_source finds no date in its metadata (run
    mas-20261123-165809-59cd: 19 sources had no date although most pages showed one, which held readiness
    INCOMPLETE). The date must appear on the saved page or in its URL; it is never taken on the agent's word."""
    run = Path(run)
    reg = _load(run / 'sources.json', {'sources': []})
    src = next((s for s in reg['sources'] if s.get('id') == source_id), None)
    if src is None:
        return None, [f'unknown source {source_id}']
    if (pub_date is None) == (undated is None):
        return None, ['give either --date (the date the page shows) or --undated "why the page shows none"']
    text = (run / src['file']).read_text(encoding='utf-8') if src.get('file') and (run / src['file']).is_file() else ''
    url = f"{src.get('url', '')} {src.get('final_url') or ''}"
    if pub_date is not None:
        if src.get('access') != 'opened' or not text:
            return None, [f'{source_id} has no saved page to read the date from; register the page with brief.py fetch first']
        day, problem = _parse_pub_date(pub_date)
        if problem:
            return None, [problem + '. Nothing was written.']
        where = None
        if shown:
            flat = ' '.join(shown.split())
            if flat and (flat in ' '.join(text.split()) or flat in url) and re.search(rf'(?<!\d)0?{day.day}(?!\d)', flat):
                where = flat
            else:
                return None, [f'--shown {shown!r} is not on the saved page {src["file"]} or in its URL, or does not contain day '
                              f'{day.day}; copy the date exactly as the page writes it. Nothing was written.']
        else:
            where = date_on_page(day, text, url)
        if not where:
            seen = ', '.join(src.get('date_candidates') or []) or 'none'
            return None, [f'{day.isoformat()} is not written on the saved page {src["file"]} or in its URL (dates seen near the top: '
                          f'{seen}). If the page writes it another way, pass that text with --shown "…"; if the page shows no '
                          'date, use --undated "why". Nothing was written.']
        src['publication_date'], src['publication_date_shown'] = pub_date, where
        src.pop('undated', None)
    else:
        reason = ' '.join(undated.split())
        if len(reason) < MIN_UNDATED_REASON:
            return None, ['--undated needs a reason a reviewer can check, e.g. "FAQ page with no date; checked on the save date". '
                          'Nothing was written.']
        if src.get('publication_date'):
            return None, [f'{source_id} already has publication date {src["publication_date"]}; an undated source has none. '
                          'Nothing was written.']
        src['undated'] = reason
    ledger = _load(run / 'evidence_ledger.json', None)
    if ledger is None:
        return None, ['evidence_ledger.json missing; run brief.py init first']
    changed = []
    for c in ledger.get('claims') or []:
        clean = c.get('recorded_sha') == fingerprint(c)
        touched = False
        for s in c.get('sources') or []:
            if (s.get('snapshot') or {}).get('path') != src.get('file'):
                continue
            if pub_date is not None:
                s['publication_date'] = pub_date
                s.pop('undated_reason', None)
            else:
                s['undated_reason'] = src['undated']
            touched = True
        if touched:
            # A claim edited by hand stays detectable: only a clean fingerprint is renewed.
            if clean:
                c['recorded_sha'] = fingerprint(c)
            changed.append(c['id'])
    _save(run / 'sources.json', reg)
    _save(run / 'evidence_ledger.json', ledger)
    note = (f'{source_id}: publication date {pub_date} (the page shows "{src["publication_date_shown"]}")' if pub_date is not None
            else f'{source_id}: recorded as showing no publication date ({src["undated"]}); a person confirms it at sign-off')
    msgs = [note, f'  updated {", ".join(changed) if changed else "no claims yet (new claims from it take the date)"}']
    if undated is not None and src.get('date_candidates'):
        msgs.append(f'  the page does show dates near the top ({", ".join(src["date_candidates"])}): if one is when it was '
                    f'published, record it with --date instead')
    return changed, msgs


def _title(raw, text):
    for pat in (r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)', r'<title[^>]*>([^<]+)</title>', r'"title"\s*:\s*"([^"]+)"'):
        m = re.search(pat, raw, re.I)
        if m:
            return re.sub(r'\s+', ' ', m[1]).strip()[:160]
    return next((l.strip()[:160] for l in text.splitlines() if len(l.strip()) > 8 and not l.strip().startswith('http')), '')


def utc_now():
    """When a page is saved and so checked. BRIEFING_CLOCK (an ISO timestamp) replaces the real clock only for fixture
    runs that replay a past date (tests, scripts/replay_eval.py); a briefing run never sets it."""
    fixed = os.environ.get('BRIEFING_CLOCK')
    return datetime.fromisoformat(fixed).astimezone(timezone.utc) if fixed else datetime.now(timezone.utc)


def register_source(run, url, file=None, route=None, fetch=None):
    """Return (record, is_new). `fetch` is safe_http.safe_get or a test double; unused when `file` is given."""
    run = Path(run)
    reg = _load(run / 'sources.json', {'sources': []})
    for s in reg['sources']:
        if url in (s['url'], s.get('final_url')) and (s['access'] == 'opened' or file is None):
            return s, False
    sid = f"S{len(reg['sources']) + 1:03d}"
    rec = {'id': sid, 'url': url, 'host': host_of(url).removeprefix('www.'),
           'registered_at': utc_now().isoformat(timespec='seconds')}
    raw_bytes, ctype = None, ''
    if file:
        raw_bytes = Path(file).read_bytes()
        rec['route'] = route or 'browser'
        rec['http_status'] = None
    else:
        rec['route'] = route or 'http_tool'
        try:
            r = fetch(url, timeout=25, max_bytes=5_000_000)
            rec['http_status'], rec['final_url'] = r.status, r.url
            ctype = r.headers.get('content-type', '')
            if 200 <= r.status < 300:
                raw_bytes = r.body
            else:
                rec['access'], rec['access_note'] = 'blocked', f'HTTP {r.status}'
        except Exception as e:  # network, TLS, unsafe URL: record the limitation, never guess
            rec['access'], rec['access_note'] = 'blocked', f'{type(e).__name__}: {str(e)[:120]}'
    if raw_bytes is not None:
        raw = raw_bytes.decode('utf-8', errors='replace')
        text = page_text(raw_bytes, ctype) if ('<' in raw[:2000] or ctype) else raw
        text = re.sub(r'\n\s*\n+', '\n', re.sub(r'[ \t]+', ' ', text or '')).strip()
        low = text.lower()
        if len(text) < 40 or any(w in low for w in ('verify you are human', 'access denied', 'just a moment', 'enable javascript')):
            rec['access'] = 'blocked'
            rec['access_note'] = 'page text empty or an access-check page'
        else:
            rec['access'] = 'opened'
        (run / 'sources').mkdir(exist_ok=True)
        path = run / 'sources' / f'{sid}.txt'
        path.write_text(text, encoding='utf-8')
        rec['file'] = f'sources/{sid}.txt'
        rec['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        rec['chars'] = len(text)
        rec['title'] = _title(raw, text)
        rec['publication_date'], rec['date_candidates'] = detect_dates(raw, text)
    reg['sources'].append(rec)
    _save(run / 'sources.json', reg)
    return rec, True


def closest_passages(quote, text, n=2):
    q = norm(quote)
    t = norm(text)
    if not q or not t:
        return []
    step = max(4, len(q) // 4)
    scored = []
    for i in range(0, max(1, len(t) - len(q) + 1), step):
        w = t[i:i + len(q) + 20]
        scored.append((SequenceMatcher(None, q, w, autojunk=False).ratio(), i))
    out = []
    for ratio, i in sorted(scored, reverse=True)[:n]:
        out.append((round(ratio, 2), text[max(0, i - 10):i + len(quote) + 30].replace('\n', ' ')))
    return out


def classify(url, domains):
    host = host_of(url)
    if is_official(host, domains):
        return 'official_document', 'primary'
    if is_news(host, domains):
        return 'news', 'secondary'
    return None, None


def infer_kinds(text, given):
    kinds = list(dict.fromkeys(given or ['factual']))
    if re.search(LEGAL_WORDS, text) and not set(kinds) & {'legal', 'list', 'negative'}:
        kinds.append('legal')
    t = re.sub(r'\d{4}\s*年|\d{1,2}\s*[月日号]', '', text)
    if any(n for n, _ in claim_numbers(t)) and 'statistic' not in kinds:
        kinds.append('statistic')
    return kinds


def fingerprint(claim):
    """Hash of a claim as add_claim wrote it; a mismatch later means it was edited by hand."""
    body = {k: v for k, v in claim.items() if k != 'recorded_sha'}
    return hashlib.sha256(json.dumps(body, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:16]


def hand_edited(ledger):
    return [c['id'] for c in ledger.get('claims') or [] if c.get('recorded_sha') and c['recorded_sha'] != fingerprint(c)]


def add_claim(run, source_id, quote, text, kinds=None, evidence_type=None, role=None, event_date=None,
              uncertainty='', anchor=None, notes='', source_name=None, today=None):
    """Return (claim_id or None, messages). Writes nothing unless the quote is found in the saved source."""
    run = Path(run)
    reg = _load(run / 'sources.json', {'sources': []})
    src = next((s for s in reg['sources'] if s['id'] == source_id), None)
    if not src:
        return None, [f'Unknown source {source_id}. Register it first: brief.py fetch RUN URL [--file PAGE.txt]']
    if src.get('access') != 'opened':
        return None, [f'{source_id} could not be opened ({src.get("access_note", "blocked")}). Keep the event and record the '
                      'limitation (brief.py event RUN decide … track); a claim needs text you actually read.']
    saved = (run / src['file']).read_text(encoding='utf-8')
    ok, ratio = quote_found(quote, saved)
    if not ok:
        msgs = [f'Quote not found in {source_id} (best match {ratio:.0%}). Copy it character-for-character from {src["file"]}; nothing was written.']
        msgs += [f'  closest passage ({r:.0%}): …{p}…' for r, p in closest_passages(quote, saved)]
        return None, msgs
    domains = load_domains()
    auto_type, auto_role = classify(src['url'], domains)
    etype = evidence_type or auto_type
    msgs = []
    if not etype:  # unknown site: never assume it is primary, so it can never make an event "confirmed" by default
        etype, msgs = 'other', [f'{src["host"]} is neither a government nor a known news site: recorded as "other" (secondary). '
                                'If it is the company\'s own newsroom or investor page, rerun with --type company_statement; '
                                'if it is a news outlet, use --type news and start the text with 据…报道.']
    srole = role or auto_role or ('primary' if etype in ('official_document', 'company_statement', 'dataset') else 'secondary')
    if etype == 'news' and not re.search(r'据|报道|称|(?i:reportedly|according to|reported|said|says|told)', text):
        return None, [f'{source_id} is a news source, so the claim must be attributed: start the text with '
                      f'"According to {source_name or src["host"]}, …". Nothing was written.']
    ledger = _load(run / 'evidence_ledger.json', None)
    if ledger is None:
        return None, ['evidence_ledger.json missing; run brief.py init first']
    sha = hashlib.sha256((run / src['file']).read_bytes()).hexdigest()
    if src.get('sha256') and sha != src['sha256']:
        return None, [f'{src["file"]} changed after it was registered; register the page again.']
    entry = {'url': src.get('final_url') or src['url'], 'source_name': source_name or src['host'],
             'publication_date': src.get('publication_date'), 'date_checked': today or src.get('registered_at') or utc_now().isoformat(timespec='seconds'),
             'quote': quote, 'anchor': anchor or f'{src["file"]}, characters {norm(saved).find(norm(quote))}+',
             'source_role': srole, 'evidence_type': etype, 'access_status': 'opened', 'access_route': src.get('route', 'http_tool'),
             'notes': notes or '', 'snapshot': {'path': src['file'], 'sha256': sha, 'retrieved_at': src['registered_at'],
                                                'method': 'saved from reader' if src.get('route') == 'browser' else 'fetched'}}
    if src.get('undated') and not entry['publication_date']:
        entry['undated_reason'] = src['undated']
    if not entry['publication_date'] and not src.get('undated'):
        msgs.append(f'{source_id} has no publication date recorded (dates seen near the top: '
                    f'{", ".join(src.get("date_candidates") or []) or "none"}). Record the one the page shows: brief.py source-date '
                    f'RUN {source_id} --date YYYY-MM-DD, or --undated "why" if it shows none. The handoff check refuses it otherwise.')
    for c in ledger['claims']:
        if c.get('text') == text:  # same proposition from a second source: append, do not duplicate
            if not any(s.get('url') == entry['url'] for s in c['sources']):
                c['sources'].append(entry)
            c['recorded_sha'] = fingerprint(c)
            _save(run / 'evidence_ledger.json', ledger)
            return c['id'], msgs + [f'Added {source_id} as another source for {c["id"]}.']
    # Withdrawn claims keep their IDs, so a new claim never reuses one.
    used = {c.get('id') for c in ledger['claims']} | {w.get('claim', {}).get('id') for w in ledger.get('withdrawn') or []}
    cid = f"C{len(ledger['claims']) + 1:03d}"
    while cid in used:
        cid = f'C{int(cid[1:]) + 1:03d}'
    claim = {'id': cid, 'text': text, 'kinds': infer_kinds(text, kinds), 'author_status': 'supported',
             'event_date': event_date, 'uncertainty': uncertainty or '', 'sources': [entry]}
    claim['recorded_sha'] = fingerprint(claim)
    ledger['claims'].append(claim)
    _save(run / 'evidence_ledger.json', ledger)
    return cid, msgs
