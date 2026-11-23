"""Trusted test doubles; no DNS, socket or public HTTP traffic."""
import socket
from safe_http import Response

FIXTURE_NOW='2030-01-02T18:00:00+00:00'
PUBLIC_V4='93.184.215.14'
PUBLIC_V6='2606:4700:4700::1111'


def public_dns(host,port,*args):
    return [(socket.AF_INET,socket.SOCK_STREAM,socket.IPPROTO_TCP,'',(PUBLIC_V4,port))]


class MockTransport:
    def __init__(self,routes):
        self.routes=routes; self.calls=[]
    def __call__(self,target,timeout,max_bytes):
        self.calls.append(target)
        value=self.routes.get(target.url)
        if isinstance(value,Exception):raise value
        if value is None:return Response(404,target.url,b'',{},[])
        code,headers,body=value
        return Response(code,target.url,body[:max_bytes],headers,[])
