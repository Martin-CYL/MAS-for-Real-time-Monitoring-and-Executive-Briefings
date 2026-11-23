#!/usr/bin/env python3
"""Incremental monitoring over the discovery sources: what is new since the last scan. Candidates, not evidence.

  python3 scripts/discover.py --monitor --dir PROJECT/monitor [--now 2026-11-20T09:00:00+08:00] [--tiers official]

One call is one tick. Which tiers are due, how often, how far back to look, the per-host request interval, the health
thresholds and the daily digest time all come from references/monitor.json; case deadlines come from
references/active_cases.json. The caller only has to run this every `tick_minutes`.

DIR holds everything the monitor keeps:

  state.json          what has been seen (fingerprints), per-source health, tier and case state
  log.jsonl           one line per call
  batches/<stamp>/    items.json for every call that checked a source or raised an alert
  digests/<date>.md   the daily list of new official items, alerts and source health
  .lock               present while a call runs

The first check of a source is a baseline: what it lists then is recorded as seen and not reported as new. A
"no notice seen" alert after a deadline says only what the listed sources showed when searched; it never says that a
status is unchanged. Blocked sources are recorded and skipped, never bypassed.

The last line of stdout is `MONITOR {json}` with what the call did, for the process that runs it.
"""
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from xml.etree import ElementTree as ET
from zoneinfo import ZoneInfo

SCRIPTS = Path(__file__).resolve().parent
SKILL = SCRIPTS.parent
sys.path.insert(0, str(SCRIPTS))

import discover as d  # noqa: E402

STATE_SCHEMA = 'monitor-state-v1'
BATCH_SCHEMA = 'monitor-batch-v1'
GROUP_OF_PARSER = {'fr': 'official_api', 'doj': 'official_api', 'listing': 'official_listing', 'rss': 'rss', 'news': 'news_search'}
OFFICIAL_GROUPS = {'official_api', 'official_listing'}
TRACKING = re.compile(r'^(utm_|fbclid$|gclid$|mc_|ref$|cmpid$|ocid$)', re.I)
SLACK = timedelta(minutes=3)  # a tick that arrives a little early still counts as due


class MonitorError(Exception):
    pass


# ------------------------------------------------------------------ small helpers
def iso(dt):
    return dt.astimezone(timezone.utc).isoformat(timespec='seconds')


def parse_iso(text):
    if not text:
        return None
    dt = datetime.fromisoformat(text)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def normalize_url(url):
    if not url:
        return ''
    parts = urlsplit(url.strip())
    query = urlencode([(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if not TRACKING.match(k)])
    path = parts.path.rstrip('/') or '/'
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, query, ''))


def fingerprint(it):
    title = re.sub(r'\s+', ' ', (it.get('title') or '')).strip().lower()
    return hashlib.sha256(f"{normalize_url(it.get('url'))}\n{title}".encode('utf-8')).hexdigest()[:20]


def links_hash(body):
    """The set of links on a listing page. Changes when entries are added or removed, not when a timestamp ticks."""
    hrefs = sorted(set(re.findall(r'<a\b[^>]*href="([^"#][^"]*)"', body or '')))
    return hashlib.sha256('\n'.join(hrefs).encode('utf-8')).hexdigest()[:20] if hrefs else None


def write_json_atomic(path, doc):
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    os.replace(tmp, path)


def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return default


def new_state(now):
    return {'schema': STATE_SCHEMA, 'started_at': iso(now), 'tiers': {}, 'sources': {}, 'seen': {}, 'cases': {}, 'last_digest': None}


def load_config(skill=SKILL):
    cfg = json.loads((skill / 'references' / 'monitor.json').read_text(encoding='utf-8'))
    for name, tier in cfg['tiers'].items():
        unknown = set(tier['groups']) - set(GROUP_OF_PARSER.values())
        if unknown:
            raise MonitorError(f'monitor.json tier {name}: unknown source groups {sorted(unknown)}')
    return cfg


def load_cases(skill=SKILL):
    doc = load_json(skill / 'references' / 'active_cases.json', {'cases': []})
    cases = []
    for c in doc.get('cases', []):
        deadline = None
        if c.get('deadline'):
            deadline = datetime.fromisoformat(c['deadline']).replace(tzinfo=ZoneInfo(c.get('timezone') or 'UTC'))
        cases.append({**c, 'deadline_at': deadline, 'match_terms': [t.lower() for t in c.get('match_terms', [])]})
    return cases


# ------------------------------------------------------------------ what is due
def due_tiers(cfg, state, now, forced=None):
    if forced:
        unknown = set(forced) - set(cfg['tiers'])
        if unknown:
            raise MonitorError(f'unknown tiers {sorted(unknown)}; known: {sorted(cfg["tiers"])}')
        return list(forced)
    out = []
    for name, tier in cfg['tiers'].items():
        last = parse_iso(state['tiers'].get(name, {}).get('last_run'))
        if last is None or now - last >= timedelta(minutes=tier['interval_minutes']) - SLACK:
            out.append(name)
    return out


def case_window(cfg, case):
    if not case['deadline_at']:
        return None
    dl = cfg['deadline']
    return case['deadline_at'] - timedelta(hours=dl['boost_hours_before']), case['deadline_at'] + timedelta(hours=dl['watch_after_hours'])


def boosted_sources(cfg, state, cases, now):
    """Sources a case near its deadline asks to watch, due at the deadline interval whatever their tier says."""
    out = set()
    every = timedelta(minutes=cfg['deadline']['interval_minutes']) - SLACK
    for case in cases:
        win = case_window(cfg, case)
        if not win or not (win[0] <= now <= win[1]):
            continue
        for sid in case.get('watch_sources', []):
            last = parse_iso(state['sources'].get(sid, {}).get('last_checked'))
            if last is None or now - last >= every:
                out.add(sid)
    return sorted(out)


def select_requests(cfg, sources_cfg, tiers, boosted, now, tz):
    """Requests from discover.plan for the due tiers plus boosted sources, each with the window it was planned for."""
    today = now.astimezone(tz).date()
    lookback = max([cfg['tiers'][t]['lookback_days'] for t in tiers] + ([cfg['deadline'].get('lookback_days', 3)] if boosted else []))
    start = today - timedelta(days=lookback)
    groups = {g for t in tiers for g in cfg['tiers'][t]['groups']}
    max_news = min([cfg['tiers'][t].get('max_queries', 80) for t in tiers if 'news_search' in cfg['tiers'][t]['groups']] or [80])
    reqs, news = [], 0
    for r in d.plan(sources_cfg, start, today, tz):
        group = GROUP_OF_PARSER[r[3]]
        if group == 'news_search':
            if group in groups and news < max_news:
                reqs.append(r)
                news += 1
        elif group in groups or r[0] in boosted:
            reqs.append(r)
    return reqs, start, today


# ------------------------------------------------------------------ fetching
def fetch_all(reqs, get, min_interval, sleep=time.sleep, workers=6):
    """Hosts in parallel, one host's requests in order with `min_interval` seconds between them."""
    from concurrent.futures import ThreadPoolExecutor
    by_host = {}
    for i, r in enumerate(reqs):
        by_host.setdefault(urlsplit(r[2]).netloc.lower(), []).append(i)
    results = [None] * len(reqs)

    def run(indexes):
        for n, i in enumerate(indexes):
            if n:
                sleep(min_interval)
            results[i] = get(reqs[i][2])

    with ThreadPoolExecutor(max(1, min(workers, len(by_host)))) as pool:
        list(pool.map(run, by_host.values()))
    return results


def parse_response(r, response, tz):
    """Items a response lists, without any window filter. Raises ValueError/ParseError on unparseable bodies."""
    sid, label, url, parser, flags = r
    st, body, final = response
    if st != 200:
        return []
    if parser == 'fr':
        batch = d.parse_fr(body, sid)
    elif parser == 'doj':
        batch = d.parse_doj(body, sid, tz)  # the newest page is enough between ticks
    elif parser == 'listing':
        batch = d.parse_listing(body, final or url, sid)
    elif parser == 'rss':
        batch = d.parse_rss(body, sid, 'rss', tz, flags.get('publisher', ''))
    else:
        batch = d.parse_rss(body, f'{sid}:{label}', 'google_news' if sid.startswith('google') else 'bing', tz)
    for x in batch:
        x['keep_all'] = bool(flags.get('keep_all') or flags.get('policy'))
        if flags.get('official'):
            x['official_domain'] = True
        if flags.get('policy'):
            x['official'] = True
    return batch


def in_window(x, start, end):
    if x.get('published'):
        return start <= date.fromisoformat(x['published']) <= end
    return x.get('published_month') in {start.strftime('%Y-%m'), end.strftime('%Y-%m')} and x.get('keep_all')


# ------------------------------------------------------------------ one tick
def case_matches(cases, it):
    text = f"{it.get('title', '')} {it.get('summary', '')}".lower()
    return [c['case_id'] for c in cases if any(t in text for t in c['match_terms'])]


def scan(cfg, sources_cfg, state, cases, now, tz, get, sleep=time.sleep, forced_tiers=None):
    """Run one tick against `state` (mutated in place). Returns the batch document."""
    tiers = due_tiers(cfg, state, now, forced_tiers)
    boosted = boosted_sources(cfg, state, cases, now)
    batch = {'schema': BATCH_SCHEMA, 'generated_at': iso(now), 'timezone': str(tz), 'tiers': tiers, 'boosted_sources': boosted,
             'note': 'Discovery metadata, not evidence. Titles, dates and publishers are as listed by the feeds.',
             'sources_checked': [], 'new_items': [], 'page_changes': [], 'alerts': [],
             'counts': {'listed': 0, 'in_window': 0, 'new': 0, 'new_relevant': 0, 'baseline': 0}}
    reqs, start, end = select_requests(cfg, sources_cfg, tiers, boosted, now, tz) if (tiers or boosted) else ([], None, None)
    if start:
        batch['window'] = {'start': start.isoformat(), 'end': end.isoformat()}
    responses = fetch_all(reqs, get, cfg.get('min_interval_per_host_seconds', 2), sleep) if reqs else []
    scorer = d.Scorer(sources_cfg['lexicon'])
    min_score = cfg.get('min_score', 3)

    per_source = {}
    for r, resp in zip(reqs, responses):
        sid, label, url, parser, _ = r
        group = GROUP_OF_PARSER[parser]
        agg = per_source.setdefault(sid, {'id': sid, 'group': group, 'parser': parser, 'requests': 0, 'ok': 0, 'statuses': [], 'listed': 0,
                                          'items': [], 'links_hash': None})
        agg['requests'] += 1
        st = resp[0]
        try:
            listed = parse_response(r, resp, tz)
        except (ET.ParseError, ValueError) as e:
            st, listed = f'unparseable ({type(e).__name__})', []
        if st == 200:
            agg['ok'] += 1
            if parser == 'listing':
                agg['links_hash'] = links_hash(resp[1])
        agg['statuses'].append(st if st is not None else str(resp[1])[:120])
        agg['listed'] += len(listed)
        agg['items'] += [x for x in listed if in_window(x, start, end)]

    for sid, agg in per_source.items():
        src = state['sources'].setdefault(sid, {'first_checked': None, 'last_checked': None, 'last_ok': None, 'failing_since': None,
                                                'consecutive_failures': 0, 'consecutive_empty': 0, 'alerted': None, 'links_hash': None})
        baseline = src['first_checked'] is None
        if baseline:
            src['first_checked'] = iso(now)
        src['last_checked'] = iso(now)
        ok = agg['ok'] > 0
        new_here = 0
        for it in agg['items']:
            fp = fingerprint(it)
            if fp in state['seen']:
                continue
            it['relevance'] = scorer(it)
            # Case terms are specific enough to count on their own: a MOFCOM notice naming 稀土 matters to A002 even
            # when the general topic lexicon scores it low.
            cases_hit = case_matches(cases, it)
            relevant = bool(cases_hit) or it['relevance']['score'] >= min_score or bool(it.get('official') and (it['relevance']['topics'] or it.get('keep_all')))
            state['seen'][fp] = {'first_seen': iso(now), 'source_id': sid, 'title': it['title'][:200], 'published': it.get('published'),
                                 'baseline': baseline}
            for cid in cases_hit:
                state['cases'].setdefault(cid, {}).setdefault('matched', []).append(
                    {'fingerprint': fp, 'first_seen': iso(now), 'published': it.get('published'), 'official': bool(it.get('official')),
                     'title': it['title'][:200], 'url': it.get('url')})
            if baseline:
                batch['counts']['baseline'] += 1
                continue
            batch['counts']['new'] += 1
            new_here += 1
            if not relevant:
                continue
            batch['counts']['new_relevant'] += 1
            entry = {k: v for k, v in it.items() if k != 'keep_all'}
            entry.update({'fingerprint': fp, 'first_seen': iso(now), 'group': agg['group'], 'cases': cases_hit})
            batch['new_items'].append(entry)
            for cid in cases_hit:
                case = next(c for c in cases if c['case_id'] == cid)
                win = case_window(cfg, case)
                urgent = bool(it.get('official') and win and win[0] <= now <= win[1])
                batch['alerts'].append({'kind': 'case_match', 'level': 'flash' if urgent else 'notice', 'case_id': cid, 'fingerprint': fp,
                                        'message': f"{cid}: new {'official ' if it.get('official') else ''}item from {sid}: {it['title'][:160]}",
                                        'message_zh': f"{cid}：{sid} 出现新的{'官方' if it.get('official') else ''}条目：{it['title'][:160]}（未核实）"})
        batch['counts']['listed'] += agg['listed']
        batch['counts']['in_window'] += len(agg['items'])
        batch['sources_checked'].append({'id': sid, 'group': agg['group'], 'requests': agg['requests'], 'ok': agg['ok'],
                                         'statuses': sorted({str(s) for s in agg['statuses']}), 'listed': agg['listed'],
                                         'in_window': len(agg['items']), 'new': new_here, 'baseline': baseline})
        if agg['parser'] == 'listing' and ok and agg['links_hash']:
            if src['links_hash'] and src['links_hash'] != agg['links_hash'] and new_here == 0:
                batch['page_changes'].append({'source_id': sid, 'note': 'links on the page changed, but no new dated entry was parsed'})
            src['links_hash'] = agg['links_hash']
        health(cfg, src, sid, agg, ok, now, batch)

    for tier in tiers:
        state['tiers'].setdefault(tier, {})['last_run'] = iso(now)
    deadlines(cfg, state, cases, now, tz, batch)
    return batch


def health(cfg, src, sid, agg, ok, now, batch):
    h = cfg['health']
    if ok:
        if src['alerted'] == 'down':
            batch['alerts'].append({'kind': 'source_recovered', 'level': 'info', 'source_id': sid,
                                    'message': f'{sid} is reachable again (unavailable since {src["failing_since"]}).',
                                    'message_zh': f'{sid} 已恢复访问（自 {src["failing_since"]} 起不可用）。'})
            src['alerted'] = None
        src.update(last_ok=iso(now), failing_since=None, consecutive_failures=0)
        # An official listing or feed that answers but lists nothing usually means the page or its layout changed.
        if agg['parser'] in ('listing', 'rss') and agg['listed'] == 0:
            src['consecutive_empty'] += 1
            if src['consecutive_empty'] >= h['empty_runs'] and src['alerted'] != 'empty':
                src['alerted'] = 'empty'
                batch['alerts'].append({'kind': 'source_empty', 'level': 'warning', 'source_id': sid,
                                        'message': f'{sid} answered but listed no entries {src["consecutive_empty"]} times in a row; the page layout may have changed.',
                                        'message_zh': f'{sid} 可以访问，但连续 {src["consecutive_empty"]} 次解析不到任何条目，页面结构可能变了。'})
        else:
            src['consecutive_empty'] = 0
            if src['alerted'] == 'empty':
                src['alerted'] = None
        return
    src['consecutive_failures'] += 1
    src['failing_since'] = src['failing_since'] or iso(now)
    since = parse_iso(src['failing_since'])
    if now - since >= timedelta(hours=h['fail_hours']) and src['alerted'] != 'down':
        src['alerted'] = 'down'
        batch['alerts'].append({'kind': 'source_down', 'level': 'warning', 'source_id': sid,
                                'message': f'{sid} unavailable since {src["failing_since"]} ({src["consecutive_failures"]} checks; last {agg["statuses"][-1]}). '
                                           'No news from it is not evidence that nothing happened.',
                                'message_zh': f'{sid} 自 {src["failing_since"]} 起无法访问（{src["consecutive_failures"]} 次检查，最近一次：{agg["statuses"][-1]}）。'
                                              '这个来源没有消息，不代表没有发生变化。'})


def deadlines(cfg, state, cases, now, tz, batch):
    for case in cases:
        if not case['deadline_at']:
            continue
        cid, dl = case['case_id'], case['deadline_at']
        cs = state['cases'].setdefault(cid, {})
        key = dl.isoformat()
        if cs.get('deadline') != key:  # a new or moved deadline starts its alerts over
            cs.update(deadline=key, approaching_alerted=False, passed_alerted=False)
        win = case_window(cfg, case)
        local = dl.astimezone(tz).strftime('%Y-%m-%d %H:%M %Z')
        watch = case.get('watch_sources', [])
        if win[0] <= now < dl and not cs['approaching_alerted']:
            cs['approaching_alerted'] = True
            hours = int((dl - now).total_seconds() // 3600)
            batch['alerts'].append({'kind': 'deadline_approaching', 'level': 'notice', 'case_id': cid,
                                    'message': f'{cid} deadline {local} (in about {hours} h). Watching {", ".join(watch) or "no listed source"} '
                                               f'every {cfg["deadline"]["interval_minutes"]} min.',
                                    'message_zh': f'{cid} 截止时间 {local}（约 {hours} 小时后）。{", ".join(watch) or "未列来源"} '
                                                  f'改为每 {cfg["deadline"]["interval_minutes"]} 分钟检查一次。'})
        if now < dl or cs['passed_alerted']:
            continue
        srcs = {sid: state['sources'].get(sid, {}) for sid in watch}
        checked_after = [sid for sid, s in srcs.items() if parse_iso(s.get('last_checked')) and parse_iso(s['last_checked']) >= dl]
        if len(checked_after) < len(watch) and now <= win[1]:
            continue  # wait until every watched source has been checked after the deadline
        cs['passed_alerted'] = True
        started = [parse_iso(s.get('first_checked')) for s in srcs.values()]
        if not watch or not all(started) or max(started) > dl:
            batch['alerts'].append({'kind': 'deadline_not_covered', 'level': 'info', 'case_id': cid,
                                    'message': f'{cid} deadline {local} passed before the monitor watched {", ".join(watch) or "any source"}; no conclusion.',
                                    'message_zh': f'{cid} 的截止时间 {local} 已过，但监测在截止前没有覆盖 {", ".join(watch) or "任何来源"}，不作判断。'})
            continue
        since = win[0]
        found = [m for m in cs.get('matched', []) if m['official'] and (not m.get('published') or date.fromisoformat(m['published']) >= since.astimezone(tz).date())]
        down = [sid for sid, s in srcs.items() if s.get('last_ok') is None or parse_iso(s['last_ok']) < dl]
        gaps = f' Unavailable after the deadline: {", ".join(down)}.' if down else ''
        gaps_zh = f'截止后无法访问：{", ".join(down)}。' if down else ''
        searched = now.astimezone(tz).strftime('%Y-%m-%d %H:%M %Z')
        if found:
            titles = '; '.join(m['title'][:100] for m in found[:3])
            batch['alerts'].append({'kind': 'deadline_passed_items_found', 'level': 'notice', 'case_id': cid,
                                    'message': f'{cid} deadline {local} passed; official items matching the case were listed: {titles}. Unverified: open the original.{gaps}',
                                    'message_zh': f'{cid} 截止时间 {local} 已过；官方来源列出了与该案件相关的条目：{titles}。未核实，请打开原文。{gaps_zh}'})
        else:
            batch['alerts'].append({'kind': 'deadline_passed_no_notice', 'level': 'flash', 'case_id': cid,
                                    'message': f'As of {searched}, a search of {", ".join(watch)} listed no official item matching {cid} '
                                               f'(deadline {local}). This is a search result only; it does not show that the status is unchanged.{gaps}',
                                    'message_zh': f'截至 {searched} 检索 {", ".join(watch)}，未见与 {cid} 相关的官方条目（截止时间 {local}）。'
                                                  f'这只是检索结果，不代表状态未变。{gaps_zh}'})


def prune(cfg, state, now):
    keep = now - timedelta(days=cfg.get('seen_retention_days', 45))
    state['seen'] = {fp: v for fp, v in state['seen'].items() if parse_iso(v['first_seen']) >= keep}


# ------------------------------------------------------------------ digest
def digest_due(cfg, state, now):
    dg = cfg['digest']
    tz = ZoneInfo(dg['timezone'])
    h, m = (int(x) for x in dg['time'].split(':'))
    slot = now.astimezone(tz).replace(hour=h, minute=m, second=0, microsecond=0)
    if now < slot:
        slot -= timedelta(days=1)
    # The first digest is the first slot after the monitor started, not one at start-up.
    last = parse_iso(state.get('last_digest')) or parse_iso(state['started_at'])
    return slot if last < slot else None


def build_digest(cfg, state, batches_dir, since, now, tz):
    batches = []
    for p in sorted(batches_dir.glob('*/items.json')):
        b = load_json(p, None)
        if b and parse_iso(b['generated_at']) > since:
            batches.append(b)
    items = [i for b in batches for i in b['new_items']]
    alerts = [a for b in batches for a in b['alerts']]
    official = [i for i in items if i['group'] in OFFICIAL_GROUPS or i.get('official')]
    other = sorted((i for i in items if i not in official), key=lambda i: -i['relevance']['score'])
    changes = [c for b in batches for c in b['page_changes']]
    span = f"{since.astimezone(tz):%Y-%m-%d %H:%M} → {now.astimezone(tz):%Y-%m-%d %H:%M} ({tz})"

    def row(i):
        cases = ', '.join(i.get('cases') or []) or '—'
        link = i.get('url') or ''
        return (f"| {parse_iso(i['first_seen']).astimezone(tz):%m-%d %H:%M} | {i.get('published') or i.get('published_month') or '—'} | "
                f"{i['source_id']} | {cases} | {i['title'].replace('|', '/')[:110]} | {link} |")

    head = '| First seen | Published | Source | Case | Title | Link |\n|---|---|---|---|---|---|'
    lines = [f'# Monitor digest {span}', '',
             f'{len(batches)} scans; {len(items)} new relevant items ({len(official)} official), {len(alerts)} alerts. '
             '**Nothing here is verified.** Titles and dates are as the sources list them; open the original before using any of it.', '']
    if alerts:
        lines += ['## Alerts', ''] + [f"- **{a['level']}** {a.get('message_zh') or a['message']}" for a in alerts] + ['']
    lines += [f'## A. New official items ({len(official)})', '', head] + [row(i) for i in official] + ['']
    lines += [f'## B. Other new items, top {min(30, len(other))} of {len(other)} by score', '', head] + [row(i) for i in other[:30]] + ['']
    down = sorted(sid for sid, s in state['sources'].items() if s.get('failing_since'))
    lines += ['## Source health', '']
    lines += [f"- {sid}: unavailable since {state['sources'][sid]['failing_since']} ({state['sources'][sid]['consecutive_failures']} checks)" for sid in down] or ['- All checked sources answered at their last check.']
    if changes:
        lines += ['', f'Listing pages whose links changed without a new dated entry: {len(changes)} '
                      f"({', '.join(sorted({c['source_id'] for c in changes}))})."]
    return '\n'.join(lines) + '\n', {'scans': len(batches), 'items': len(items), 'official': len(official), 'alerts': len(alerts)}


# ------------------------------------------------------------------ entry point
class Lock:
    def __init__(self, path, stale_after):
        self.path, self.stale_after = path, stale_after

    def __enter__(self):
        try:
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            if time.time() - self.path.stat().st_mtime < self.stale_after:
                raise MonitorError(f'another monitor call holds {self.path}')
            self.path.unlink()  # left by a call that died
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        return self

    def __exit__(self, *exc):
        self.path.unlink(missing_ok=True)


def run(mon_dir, now=None, tiers=None, get=None, sleep=time.sleep, skill=SKILL, sources_path=None):
    """One tick: scan what is due, write the batch, log and digest, save state. Returns the summary printed after MONITOR."""
    mon_dir = Path(mon_dir)
    mon_dir.mkdir(parents=True, exist_ok=True)
    cfg = load_config(skill)
    sources_cfg = json.loads(Path(sources_path or skill / 'references' / 'discovery_sources.json').read_text(encoding='utf-8'))
    cases = load_cases(skill)
    tz = ZoneInfo(cfg.get('timezone', 'Asia/Hong_Kong'))
    now = now or datetime.now(timezone.utc)
    with Lock(mon_dir / '.lock', cfg.get('scan_timeout_minutes', 10) * 60):
        state = load_json(mon_dir / 'state.json', None) or new_state(now)
        if state.get('schema') != STATE_SCHEMA:
            raise MonitorError(f'{mon_dir / "state.json"} is not a {STATE_SCHEMA} file')
        t0 = time.time()
        batch = scan(cfg, sources_cfg, state, cases, now, tz, get or d.fetcher(), sleep, tiers)
        batch['elapsed_seconds'] = round(time.time() - t0, 1)
        batch_path = None
        if batch['sources_checked'] or batch['alerts']:
            stamp = now.astimezone(tz).strftime('%Y%m%dT%H%M%S')
            batch_path = mon_dir / 'batches' / stamp
            batch_path.mkdir(parents=True, exist_ok=True)
            write_json_atomic(batch_path / 'items.json', batch)
        failed = [s['id'] for s in batch['sources_checked'] if not s['ok']]
        summary = {'at': iso(now), 'tiers': batch['tiers'], 'boosted': batch['boosted_sources'], 'sources': len(batch['sources_checked']),
                   'failed': failed, 'new': batch['counts']['new'], 'new_relevant': batch['counts']['new_relevant'],
                   'baseline': batch['counts']['baseline'], 'page_changes': len(batch['page_changes']),
                   'alerts': [{k: a[k] for k in ('kind', 'level', 'message', 'message_zh') if k in a} for a in batch['alerts']],
                   'batch': str(batch_path) if batch_path else None, 'digest': None}
        slot = digest_due(cfg, state, now)
        if slot is not None:
            since = parse_iso(state.get('last_digest')) or parse_iso(state['started_at']) - timedelta(seconds=1)
            # A digest also covers what the call that produced it found.
            text, counts = build_digest(cfg, state, mon_dir / 'batches', since, now, tz)
            (mon_dir / 'digests').mkdir(exist_ok=True)
            path = mon_dir / 'digests' / f"{slot.strftime('%Y-%m-%d')}.md"
            path.write_text(text, encoding='utf-8')
            state['last_digest'] = iso(now)
            summary['digest'] = {'path': str(path), **counts}
        prune(cfg, state, now)
        write_json_atomic(mon_dir / 'state.json', state)
        with (mon_dir / 'log.jsonl').open('a', encoding='utf-8') as log:
            log.write(json.dumps({**summary, 'alerts': len(summary['alerts']), 'elapsed_seconds': batch['elapsed_seconds']}, ensure_ascii=False) + '\n')
    return summary


def main(argv):
    import argparse
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--monitor', action='store_true', required=True)
    ap.add_argument('--dir', required=True, help='monitor directory (state, log, batches, digests)')
    ap.add_argument('--now', help='ISO time to act as now (tests and replays)')
    ap.add_argument('--tiers', help='comma-separated tiers to run now, whatever is due')
    ap.add_argument('--sources', help='discovery_sources.json to use instead of the Skill\'s')
    a = ap.parse_args(argv)
    try:
        summary = run(a.dir, now=parse_iso(a.now) if a.now else None, tiers=a.tiers.split(',') if a.tiers else None, sources_path=a.sources)
    except MonitorError as e:
        print(f'monitor: {e}', file=sys.stderr)
        print('MONITOR ' + json.dumps({'error': str(e)}, ensure_ascii=False))
        return 2
    print(f"tiers {','.join(summary['tiers']) or '-'}; {summary['sources']} sources ({len(summary['failed'])} unavailable); "
          f"{summary['new_relevant']} new relevant of {summary['new']} new; {summary['baseline']} baseline; {len(summary['alerts'])} alerts")
    print('MONITOR ' + json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
