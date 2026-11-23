"""Public-source HTTP boundary: deny non-public destinations, pin DNS, inspect redirects.

Without a proxy: a direct stdlib connection to a validated IP, with original Host/SNI
and normal CA validation (DNS pinned on every hop).

With an environment proxy (common on corporate and bank networks): requests go through
the proxy by default, because refusing them would switch off every link and quote check.
The URL text of every hop is still checked (private IPs, localhost, internal names), and
redirects are still followed manually and re-checked. DNS cannot be pinned because the
proxy resolves names, so rely on the network's own egress controls for that part.
Set BRIEFING_PROXY_POLICY=refuse (CLI: --strict-network) to restore fail-closed behaviour. Injected transports are trusted test doubles
and MUST return one hop without following redirects; never pass a real urlopen here.
"""
from dataclasses import dataclass
import http.client
import ipaddress
import os
import re
import socket
import ssl
import urllib.error
import urllib.request
from urllib.parse import urlsplit, urlunsplit, urljoin

MAX_REDIRECTS = 5
REDIRECTS = {301,302,303,307,308}
TRANSITION = tuple(ipaddress.ip_network(s) for s in ('64:ff9b::/96','64:ff9b:1::/48','2002::/16','2001::/32'))
# Stable conservative policy across Python versions whose special-purpose IP
# classifications differ. Rare globally reachable protocol-service exceptions
# within these special prefixes are intentionally unsupported by this client.
SPECIAL_V4 = tuple(ipaddress.ip_network(s) for s in ('192.0.0.0/24','192.88.99.0/24'))
SPECIAL_V6 = tuple(ipaddress.ip_network(s) for s in ('2001::/23','3fff::/20','5f00::/16'))


class UnsafeURL(ValueError):
    pass


class TransportUnavailable(OSError):
    pass


@dataclass(frozen=True)
class Target:
    url: str
    host: str
    port: int
    scheme: str
    ip: str = ''
    family: int = 0


@dataclass
class Response:
    status: int
    url: str
    body: bytes
    headers: dict
    redirects: list


def public_ip(value):
    try:
        ip=ipaddress.ip_address(value)
    except ValueError:
        return False
    if isinstance(ip,ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return public_ip(str(ip.ipv4_mapped))
        if any(ip in net for net in TRANSITION+SPECIAL_V6):
            return False
    elif any(ip in net for net in SPECIAL_V4):
        return False
    return ip.is_global and not (ip.is_multicast or ip.is_reserved or ip.is_unspecified or ip.is_loopback or ip.is_link_local or ip.is_private)


def target_url(url):
    """Lexical/literal check only, no DNS or I/O; also used by offline QA."""
    if not isinstance(url,str) or not url or any(c.isspace() or ord(c)<32 or ord(c)==127 or c in '\\{}<>' for c in url):
        raise UnsafeURL('Malformed/ambiguous URL; use a canonical public HTTP(S) source')
    try:
        s=urlsplit(url)
        if s.scheme.lower() not in ('http','https') or not s.hostname or s.username is not None or s.password is not None:
            raise UnsafeURL('Only HTTP(S) URLs without userinfo are allowed')
        port=s.port if s.port is not None else (443 if s.scheme.lower()=='https' else 80)
        if not 1<=port<=65535:
            raise UnsafeURL('Invalid destination port')
        host=s.hostname.encode('idna').decode('ascii').lower().rstrip('.')
    except (ValueError,UnicodeError) as e:
        if isinstance(e,UnsafeURL): raise
        raise UnsafeURL('Invalid URL/hostname/port') from e
    if '%' in host or not host:
        raise UnsafeURL('Encoded hostnames and IPv6 zone identifiers are not allowed')
    try:
        ip=ipaddress.ip_address(host)
    except ValueError:
        ip=None
    if ip is not None:
        if not public_ip(host):
            raise UnsafeURL('Non-public or policy-excluded special-purpose IP blocked; replace with a supported public source URL')
    else:
        if re.fullmatch(r'(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+)){0,3}',host):
            raise UnsafeURL('Non-canonical numeric IP notation is blocked')
        if host=='localhost' or host.endswith(('.localhost','.local','.internal','.lan','.home')) or '.' not in host:
            raise UnsafeURL('Local/internal hostname is blocked')
        labels=host.split('.')
        if len(host)>253 or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?',label) for label in labels):
            raise UnsafeURL('Ambiguous hostname; use canonical DNS labels')
    authority=('['+host+']') if ':' in host else host
    if port!=(443 if s.scheme.lower()=='https' else 80): authority+=':'+str(port)
    canonical=urlunsplit((s.scheme.lower(),authority,s.path or '/',s.query,''))
    return Target(canonical,host,port,s.scheme.lower())


def resolve_target(target,resolver=None):
    """Reject the entire DNS answer if ANY candidate is non-public."""
    try:
        literal=ipaddress.ip_address(target.host)
    except ValueError:
        literal=None
    if literal is not None:
        return Target(target.url,target.host,target.port,target.scheme,str(literal),socket.AF_INET6 if literal.version==6 else socket.AF_INET)
    resolver=resolver or socket.getaddrinfo
    answers=resolver(target.host,target.port,socket.AF_UNSPEC,socket.SOCK_STREAM)
    candidates=[]
    for family,kind,protocol,canon,sockaddr in answers:
        if family not in (socket.AF_INET,socket.AF_INET6) or kind!=socket.SOCK_STREAM:
            continue
        ip=str(sockaddr[0])
        if not public_ip(ip) or '%' in ip or (family==socket.AF_INET6 and len(sockaddr)>3 and sockaddr[3]):
            raise UnsafeURL('DNS includes a non-public/scoped address; no connection attempted')
        candidates.append((family,ip))
    if not candidates:
        raise socket.gaierror('No usable public address')
    family,ip=candidates[0]
    return Target(target.url,target.host,target.port,target.scheme,ip,family)


def proxy_present():
    return any(os.environ.get(k) for k in ('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'))


def direct_hop(target,timeout,max_bytes):
    """One hop with a pinned numeric sockaddr; never resolve the hostname again."""
    sock=socket.socket(target.family,socket.SOCK_STREAM)
    conn=None
    try:
        sock.settimeout(timeout)
        addr=(target.ip,target.port,0,0) if target.family==socket.AF_INET6 else (target.ip,target.port)
        sock.connect(addr)
        peer=sock.getpeername()[0]
        if ipaddress.ip_address(peer)!=ipaddress.ip_address(target.ip) or not public_ip(peer):
            raise UnsafeURL('Connected peer differs from the vetted public address')
        if target.scheme=='https':
            sock=ssl.create_default_context().wrap_socket(sock,server_hostname=target.host)
        conn=http.client.HTTPConnection(target.host,target.port,timeout=timeout)
        conn.auto_open=0  # never permit http.client to reconnect by hostname
        conn.sock=sock
        parsed=urlsplit(target.url)
        path=parsed.path or '/'
        if parsed.query: path+='?'+parsed.query
        conn.request('GET',path,headers={'Host':parsed.netloc,'User-Agent':'Briefing-QA/2.0 (public-source validation)','Accept-Encoding':'identity'})
        r=conn.getresponse()
        headers={k.lower():v for k,v in r.getheaders()}
        # Do not read redirect bodies; the next destination must first pass policy.
        body=b'' if r.status in REDIRECTS else r.read(max_bytes)
        return Response(r.status,target.url,body,headers,[])
    finally:
        if conn: conn.close()
        sock.close()


def proxy_policy():
    return os.environ.get('BRIEFING_PROXY_POLICY','allow').strip().lower()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):
        return None  # surface 3xx to safe_get so the next hop is checked first


def proxy_hop(target,timeout,max_bytes):
    """One hop through the environment proxy. Never follows redirects itself."""
    opener=urllib.request.build_opener(urllib.request.ProxyHandler(),_NoRedirect())
    req=urllib.request.Request(target.url,headers={'User-Agent':'Briefing-QA/2.0 (public-source validation)','Accept-Encoding':'identity'})
    try:
        with opener.open(req,timeout=timeout) as r:
            headers={k.lower():v for k,v in r.headers.items()}
            body=b'' if r.status in REDIRECTS else r.read(max_bytes)
            return Response(r.status,target.url,body,headers,[])
    except urllib.error.HTTPError as e:
        return Response(e.code,target.url,b'',{k.lower():v for k,v in (e.headers or {}).items()},[])


def safe_get(url,timeout=10,max_bytes=65536,resolver=None,transport=None):
    """Validate EVERY hop and limit redirects. Direct: connect only to the vetted IP.
    Through a proxy: URL-text checks on every hop, no DNS pinning (see module doc)."""
    target=target_url(url)
    via_proxy=False
    if transport is None and proxy_present():
        if proxy_policy()=='refuse':
            raise TransportUnavailable('Proxy transport cannot guarantee a pinned public upstream; request left unchecked (strict network mode)')
        transport=proxy_hop
        via_proxy=True
    transport=transport or direct_hop
    visited=set(); redirects=[]
    for _ in range(MAX_REDIRECTS+1):
        if target.url in visited:
            raise TransportUnavailable('Redirect loop; source remains unverified')
        visited.add(target.url)
        vetted=target if via_proxy else resolve_target(target,resolver)
        r=transport(vetted,timeout,max_bytes)
        # A test transport must be one-hop; accepting an auto-following opener would
        # validate only after an unsafe request had already happened.
        if target_url(r.url).url!=target.url:
            raise TransportUnavailable('Transport followed redirects internally; use the single-hop interface')
        if r.status not in REDIRECTS:
            r.redirects=redirects
            if via_proxy:
                r.headers['x-briefing-transport']='proxy'
            return r
        headers={k.lower():v for k,v in r.headers.items()}
        location=headers.get('location')
        if not location:
            raise TransportUnavailable('Redirect missing Location; source remains unverified')
        next_target=target_url(urljoin(target.url,location))
        if target.scheme=='https' and next_target.scheme=='http':
            raise TransportUnavailable('HTTPS downgrade redirect; source remains unverified')
        redirects.append({'from':target.url,'to':next_target.url,'http_status':r.status})
        target=next_target
    raise TransportUnavailable('Too many redirects; source remains unverified')


def mocked_opener_transport(opener):
    """Compatibility adapter for trusted, NON-NETWORK test doubles only.

    Callers must also inject DNS. Production must never pass an auto-following
    urllib opener as a transport; CLI offers no transport override.
    """
    import urllib.request
    import urllib.error
    def one_hop(target,timeout,max_bytes):
        req=urllib.request.Request(target.url,headers={'User-Agent':'Briefing-QA/2.0 (mock transport)'})
        try:
            with opener(req,timeout=timeout) as r:
                headers=dict(getattr(r,'headers',{}) or {})
                return Response(r.status,r.geturl(),r.read(max_bytes),headers,[])
        except urllib.error.HTTPError as e:
            return Response(e.code,target.url,b'',dict(e.headers or {}),[])
    return one_hop
