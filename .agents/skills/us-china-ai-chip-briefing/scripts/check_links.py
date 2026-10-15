#!/usr/bin/env python3
"""Actual <a href> validation; offline by default. HTTP never verifies a claim."""
import argparse
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit
import urllib.error
import urllib.request
from safe_http import target_url, safe_get, UnsafeURL, TransportUnavailable, mocked_opener_transport
from html_model import Document
from qa_common import finding, emit, exit_code

CATEGORIES = ('REACHABLE', 'BROKEN', 'BLOCKED', 'NETWORK_ERROR', 'UNCHECKED', 'UNSAFE_URL')


def external_urls(raw):
    return sorted({n.attrs['href'].strip() for n in Document(raw).nodes
                   if n.tag == 'a' and n.attrs.get('href')
                   and n.attrs['href'].strip().lower().startswith(('http:', 'https:'))
                   and not any(p.tag in ('script','style','template','noscript') for p in n.ancestors())})


def url_valid(url):
    try:
        target_url(url)
        return True
    except UnsafeURL:
        return False


def check(url, timeout=10, opener=None, resolver=None, transport=None):
    """Public-source GET with pinned DNS and a validated single-hop transport."""
    try:
        target_url(url)
    except UnsafeURL as e:
        return finding('FAIL','UNSAFE_URL',str(e),url=url,http_status=None,remediation='Use an external public HTTP(S) source')
    if opener is not None:
        if resolver is None:
            return finding('UNVERIFIED','UNCHECKED','Legacy mock opener needs an explicit mocked resolver; production uses safe_get',url=url,http_status=None)
        transport=transport or mocked_opener_transport(opener)
    try:
        r=safe_get(url,timeout=timeout,resolver=resolver,transport=transport)
        code, final=r.status,r.url
        body=r.body.decode('utf-8',errors='replace').lower()
        if code in (401,402,403,407,429,451):
            cat, status = 'BLOCKED', 'UNVERIFIED'
        elif code in (404,410):
            cat, status = 'BROKEN', 'FAIL'
        elif code >= 500 or code == 408:
            cat, status = 'NETWORK_ERROR', 'UNVERIFIED'
        elif not 200 <= code < 300:
            cat, status = 'UNCHECKED', 'UNVERIFIED'
        elif any(x in body for x in ('<title>page not found', '<title>404', '<title>not found')):
            cat, status = 'UNCHECKED', 'UNVERIFIED'
        elif any(x in body for x in ('verify you are human','cf-chl-','<title>access denied','subscribe to continue','sign in to continue')):
            cat, status = 'BLOCKED', 'UNVERIFIED'
        else:
            cat, status = 'REACHABLE', 'PASS'
        via=r.headers.get('x-briefing-transport')=='proxy'
        msg='HTTP response only; source support not checked'+('; fetched via proxy (URL checks applied, DNS not pinned)' if via else '')
        return finding(status,cat,msg,url=url,http_status=code,final_url=final,redirects=r.redirects,transport='proxy' if via else 'direct')
    except UnsafeURL as e:
        return finding('FAIL','UNSAFE_URL',str(e),url=url,http_status=None,remediation='Replace unsafe source/redirect; no private target was requested')
    except TransportUnavailable as e:
        return finding('UNVERIFIED','UNCHECKED',str(e),url=url,http_status=None,remediation='Use a supported pinned public-source transport; do not disable TLS or bypass the proxy')
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
        reason=getattr(e,'reason',e)
        tunnel=re.search(r'Tunnel connection failed:\s*(\d{3})',str(reason))
        proxy_code=int(tunnel[1]) if tunnel else None
        if proxy_code in (401,402,403,407,429,451):
            return finding('UNVERIFIED','BLOCKED','Proxy refused HTTPS tunnel; no destination HTTP response',url=url,http_status=None,proxy_http_status=proxy_code)
        return finding('UNVERIFIED','NETWORK_ERROR',type(reason).__name__+'; retry or review source',url=url,http_status=None)


def validate_links(raw, network=False, timeout=10, workers=4, opener=None, resolver=None, transport=None):
    urls = external_urls(raw)
    unresolved=[]
    for n in Document(raw).nodes:
        if n.tag!='a' or 'href' not in n.attrs or any(p.tag in ('script','style','template','noscript') for p in n.ancestors()):
            continue
        href=(n.attrs['href'] or '').strip()
        if href.lower().startswith(('http:','https:','mailto:','tel:')) or (href.startswith('#') and len(href)>1):
            continue
        invalid=not href or href=='#' or any(c in href for c in '{}<>') or href.lower().startswith(('javascript:','data:'))
        unresolved.append(finding('FAIL' if invalid else 'UNVERIFIED','BROKEN' if invalid else 'UNCHECKED',
                                  'Placeholder/unsafe link' if invalid else 'Relative or unsupported link; not resolved by guessing',url=href,http_status=None))
    if not urls:
        return unresolved or [finding('FAIL','NO_LINKS','No external hyperlinks found')]
    if not network:
        def offline_check(url):
            try: target_url(url)
            except UnsafeURL as e:
                return finding('FAIL','UNSAFE_URL',str(e),url=url,http_status=None,remediation='Replace with a canonical public source URL')
            return finding('UNVERIFIED','UNCHECKED','Network checks disabled; DNS/public reachability not established',url=url,http_status=None)
        return unresolved+[offline_check(url) for url in urls]
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return unresolved+list(pool.map(lambda u: check(u,timeout,opener,resolver,transport), urls))


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('html')
    ap.add_argument('--network',action='store_true',help='Opt in to public HTTP GET requests')
    ap.add_argument('--timeout',type=float,default=10)
    ap.add_argument('--strict-network',action='store_true',help='Refuse to fetch through a proxy')
    ap.add_argument('--json',dest='json_path')
    args=ap.parse_args()
    if args.strict_network:
        import os
        os.environ['BRIEFING_PROXY_POLICY']='refuse'
    items=validate_links(Path(args.html).read_text(encoding='utf-8'),args.network,args.timeout)
    emit(items,args.json_path)
    return exit_code(items)


if __name__=='__main__':
    raise SystemExit(main())
