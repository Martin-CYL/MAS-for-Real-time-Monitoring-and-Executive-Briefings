"""Security/time regression tests: all DNS, clocks and network traffic are mocked."""
import copy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock
from urllib.error import URLError

SKILL=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(SKILL/'scripts'))
from safe_http import target_url, resolve_target, safe_get, direct_hop, public_ip, UnsafeURL, TransportUnavailable, Response
from check_links import check, validate_links, url_valid
from check_dates import interval, validate_dates, UnknownTime
from check_evidence import validate_evidence
from validate import run
from qa_common import exit_code
from mock_network import public_dns, MockTransport, PUBLIC_V4, PUBLIC_V6

FIX=SKILL/'tests/fixtures'
HTML=(FIX/'synthetic_report.html').read_text()
LEDGER=json.loads((FIX/'synthetic_ledger.json').read_text())
NOW='2030-01-02T18:00:00+00:00'
URL='https://news.example.org/article'


def codes(items):return {x['code'] for x in items}


def record():
    value=copy.deepcopy(LEDGER)
    value.update(timezone='UTC',cutoff='2030-01-01',generated_at='2030-01-02T12:00:00Z')
    return value


def dates(ledger,now=NOW,review=None):return validate_dates(HTML,ledger,review,now)


def address_answers(*ips):
    def resolve(host,port,*args):
        return [(socket.AF_INET6 if ':' in ip else socket.AF_INET,socket.SOCK_STREAM,socket.IPPROTO_TCP,'',
                 (ip,port,0,0) if ':' in ip else (ip,port)) for ip in ips]
    return resolve


class PublicDestinationTests(unittest.TestCase):
    def test_requested_private_examples_rejected_without_io(self):
        forbidden=['http://127.0.0.1:8080/admin','http://localhost:8000/private',
                   'http://169.254.169.254/latest/meta-data/','http://10.0.0.1:8080/']
        for url in forbidden:
            with self.subTest(url=url),patch('safe_http.socket.getaddrinfo') as dns,patch('safe_http.socket.socket') as sock:
                r=check(url)
                self.assertEqual(r['status'],'FAIL');self.assertEqual(r['code'],'UNSAFE_URL')
                dns.assert_not_called();sock.assert_not_called()

    def test_all_nonpublic_ipv4_classes(self):
        for ip in ('0.0.0.0','127.1.2.3','10.2.3.4','172.16.0.1','172.31.255.255','192.168.1.1','169.254.1.1',
                   '100.64.0.1','192.0.2.1','192.0.0.8','192.88.99.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','240.0.0.1','255.255.255.255'):
            self.assertFalse(url_valid('http://'+ip+'/'),ip)

    def test_nonpublic_ipv6(self):
        for ip in ('::','::1','fc00::1','fd00:ec2::254','fe80::1','ff02::1','2001:db8::1',
                   '::ffff:127.0.0.1','::ffff:10.0.0.1','::ffff:192.88.99.1','64:ff9b::a00:1','64:ff9b:1::1','2002:7f00:1::1','2001::1','2001:20::1','3fff::1','5f00::1'):
            self.assertFalse(url_valid('http://['+ip+']/'),ip)

    def test_canonical_public_literals(self):
        for url in ('https://8.8.8.8/source','https://[2606:4700:4700::1111]/source'):
            self.assertTrue(url_valid(url))

    def test_ipv6_zone_ids_blocked(self):
        self.assertFalse(url_valid('http://[fe80::1%25eth0]/'))
        self.assertFalse(url_valid('https://[2606:4700:4700::1111%25eth0]/'))

    def test_special_numeric_notation(self):
        for host in ('2130706433','0x7f000001','0177.0.0.1','127.1','127.0.1','0x7f.0.0.1','3232235777','0300.0250.1.1'):
            self.assertFalse(url_valid('http://'+host+'/'),host)

    def test_encoded_confusing_hosts(self):
        for url in ('http://%31%32%37.0.0.1/','http://public.example\\@127.0.0.1/',
                    'http://public.example@127.0.0.1/','http://127.0.0.1./','http://１２７.０.０.１/',
                    'http://localHOST./','http://localhost.example.local/','http://metadata.google.internal/'):
            self.assertFalse(url_valid(url),url)

    def test_userinfo_and_bad_schemes(self):
        for url in ('file:///etc/passwd','ftp://source.example/a','http://user:password@source.example/a','http://source.example:0/'):
            self.assertFalse(url_valid(url),url)

    def test_dns_mixed_private_answer_denied(self):
        t=MockTransport({URL:(200,{},b'ok')})
        r=check(URL,resolver=address_answers(PUBLIC_V4,'10.0.0.1'),transport=t)
        self.assertEqual(r['code'],'UNSAFE_URL');self.assertEqual(t.calls,[])

    def test_dns_ipv6_private_answer_denied(self):
        t=MockTransport({URL:(200,{},b'ok')})
        r=check(URL,resolver=address_answers(PUBLIC_V4,'::1'),transport=t)
        self.assertEqual(r['status'],'FAIL');self.assertFalse(t.calls)

    def test_public_dns_ipv6_supported(self):
        t=MockTransport({URL:(200,{},b'ok')})
        r=check(URL,resolver=address_answers(PUBLIC_V6),transport=t)
        self.assertEqual(r['status'],'PASS');self.assertEqual(t.calls[0].family,socket.AF_INET6)

    def test_dns_error_unverified(self):
        def failure(*args):raise socket.gaierror('Mock DNS failure')
        r=check(URL,resolver=failure,transport=MockTransport({}))
        self.assertEqual(r['status'],'UNVERIFIED');self.assertEqual(r['code'],'NETWORK_ERROR')

    def test_dns_timeout_unverified(self):
        def failure(*args):raise TimeoutError('Mock DNS timeout')
        self.assertEqual(check(URL,resolver=failure,transport=MockTransport({}))['status'],'UNVERIFIED')

    def test_no_dns_answer_unverified(self):
        r=check(URL,resolver=lambda *args:[],transport=MockTransport({}))
        self.assertEqual(r['status'],'UNVERIFIED')

    def test_proxy_fails_closed_without_request_or_dns(self):
        with patch.dict('os.environ',{'HTTPS_PROXY':'http://proxy.example:8080','BRIEFING_PROXY_POLICY':'refuse'}),patch('safe_http.socket.getaddrinfo') as dns,patch('safe_http.socket.socket') as sock:
            r=check(URL)
            self.assertEqual(r['status'],'UNVERIFIED');self.assertEqual(r['code'],'UNCHECKED')
            self.assertIn('cannot guarantee',r['message']);dns.assert_not_called();sock.assert_not_called()

    def test_offline_blocks_private_without_dns(self):
        with patch('safe_http.socket.getaddrinfo') as dns:
            r=validate_links('<a href="http://127.0.0.1/admin">source</a>')
            self.assertEqual(exit_code(r),1);dns.assert_not_called()

    def test_offline_public_remains_unchecked(self):
        self.assertEqual(exit_code(validate_links('<a href="'+URL+'">source</a>')),2)

    def test_dns_case_trailing_dot_idna(self):
        self.assertEqual(target_url('https://NEWS.Example.org./article').host,'news.example.org')
        self.assertEqual(target_url('https://例子.example/a').host,'xn--fsqu00a.example')


class RedirectAndTransportTests(unittest.TestCase):
    def get(self,routes,resolver=public_dns):
        t=MockTransport(routes)
        return check(URL,resolver=resolver,transport=t),t

    def test_redirect_to_private_literal_before_second_request(self):
        r,t=self.get({URL:(302,{'Location':'http://169.254.169.254/latest/meta-data/'},b'')})
        self.assertEqual(r['status'],'FAIL');self.assertEqual(len(t.calls),1)

    def test_redirect_to_private_dns_before_second_request(self):
        def resolver(host,port,*args):return address_answers('10.0.0.1' if host=='internal.example.org' else PUBLIC_V4)(host,port)
        r,t=self.get({URL:(301,{'Location':'https://internal.example.org/admin'},b'')},resolver)
        self.assertEqual(r['code'],'UNSAFE_URL');self.assertEqual(len(t.calls),1)

    def test_protocol_relative_unsafe_redirect(self):
        r,t=self.get({URL:(307,{'Location':'//127.0.0.1/admin'},b'')})
        self.assertEqual(r['code'],'UNSAFE_URL');self.assertEqual(len(t.calls),1)

    def test_ipv6_unsafe_redirect(self):
        r,t=self.get({URL:(308,{'Location':'https://[::1]/admin'},b'')})
        self.assertEqual(r['status'],'FAIL');self.assertEqual(len(t.calls),1)

    def test_relative_public_redirect(self):
        final='https://news.example.org/final'
        r,t=self.get({URL:(303,{'Location':'/final'},b''),final:(200,{},b'ok')})
        self.assertEqual(r['status'],'PASS');self.assertEqual(r['final_url'],final)
        self.assertEqual(len(r['redirects']),1)

    def test_all_redirect_statuses_revalidate(self):
        for code in (301,302,303,307,308):
            r,t=self.get({URL:(code,{'Location':'https://[::1]/'},b'')})
            self.assertEqual(r['status'],'FAIL');self.assertEqual(len(t.calls),1)

    def test_rebinding_same_host_second_hop(self):
        count=[0]
        def changing(host,port,*args):
            count[0]+=1
            return address_answers(PUBLIC_V4 if count[0]==1 else '127.0.0.1')(host,port)
        r,t=self.get({URL:(302,{'Location':'/next'},b'')},changing)
        self.assertEqual(r['code'],'UNSAFE_URL');self.assertEqual(len(t.calls),1)

    def test_single_hop_uses_pinned_dns_result(self):
        resolver=Mock(side_effect=public_dns)
        r,t=self.get({URL:(200,{},b'ok')},resolver)
        self.assertEqual(r['status'],'PASS');self.assertEqual(resolver.call_count,1)
        self.assertEqual(t.calls[0].ip,PUBLIC_V4)

    def test_uncontrolled_opener_unverified(self):
        r=check(URL,opener=Mock())
        self.assertEqual(r['status'],'UNVERIFIED');self.assertEqual(r['code'],'UNCHECKED')

    def test_auto_following_transport_not_accepted(self):
        def following(target,*args):return Response(200,'https://else.example.org/',b'ok',{},[])
        r=check(URL,resolver=public_dns,transport=following)
        self.assertEqual(r['status'],'UNVERIFIED');self.assertNotEqual(r['code'],'REACHABLE')

    def test_downgrade_not_followed(self):
        r,t=self.get({URL:(302,{'Location':'http://news.example.org/next'},b'')})
        self.assertEqual(r['status'],'UNVERIFIED');self.assertEqual(len(t.calls),1)

    def test_redirect_loop_unverified(self):
        r,t=self.get({URL:(302,{'Location':'/article'},b'')})
        self.assertEqual(r['status'],'UNVERIFIED');self.assertEqual(len(t.calls),1)

    def test_redirect_limit(self):
        routes={URL:(302,{'Location':'/0'},b'')}
        routes.update({f'https://news.example.org/{i}':(302,{'Location':f'/{i+1}'},b'') for i in range(7)})
        r,t=self.get(routes)
        self.assertEqual(r['status'],'UNVERIFIED');self.assertEqual(len(t.calls),6)

    def test_403_429_503_404_semantics(self):
        for code,status,category in [(403,'UNVERIFIED','BLOCKED'),(429,'UNVERIFIED','BLOCKED'),(503,'UNVERIFIED','NETWORK_ERROR'),(404,'FAIL','BROKEN')]:
            r,_=self.get({URL:(code,{},b'')})
            self.assertEqual((r['status'],r['code']),(status,category))

    def test_ssl_error_never_passes(self):
        r,_=self.get({URL:ssl.SSLCertVerificationError('Mock TLS failure')})
        self.assertEqual(r['status'],'UNVERIFIED')

    def test_pinned_direct_connect_host_sni_tls(self):
        target=resolve_target(target_url(URL),public_dns)
        sock=Mock();sock.getpeername.return_value=(PUBLIC_V4,443)
        context=Mock();context.wrap_socket.return_value=sock
        connection=Mock();connection.getresponse.return_value.status=200
        connection.getresponse.return_value.getheaders.return_value=[]
        connection.getresponse.return_value.read.return_value=b'ok'
        with patch('safe_http.socket.socket',return_value=sock),patch('safe_http.ssl.create_default_context',return_value=context) as ca,patch('safe_http.http.client.HTTPConnection',return_value=connection),patch('safe_http.socket.getaddrinfo') as dns:
            direct_hop(target,5,1024)
        sock.connect.assert_called_once_with((PUBLIC_V4,443))
        context.wrap_socket.assert_called_once_with(sock,server_hostname='news.example.org')
        self.assertEqual(connection.request.call_args.kwargs['headers']['Host'],'news.example.org')
        self.assertEqual(connection.auto_open,0);dns.assert_not_called();ca.assert_called_once_with()

    def test_peer_mismatch_rejected_before_http(self):
        sock=Mock();sock.getpeername.return_value=('10.0.0.1',443)
        with patch('safe_http.socket.socket',return_value=sock),patch('safe_http.http.client.HTTPConnection') as http:
            with self.assertRaises(UnsafeURL):direct_hop(resolve_target(target_url(URL),public_dns),5,1024)
            http.assert_not_called()


class CrossFieldDateTests(unittest.TestCase):
    def test_check_before_publication(self):
        led=record();led['claims'][0]['sources'][0]['date_checked']='2020-01-01'
        items=dates(led);self.assertIn('CHECK_BEFORE_PUBLICATION',codes(items));self.assertEqual(exit_code(items),1)
        x=next(x for x in items if x['code']=='CHECK_BEFORE_PUBLICATION')
        self.assertEqual(x['claim_id'],'C001');self.assertEqual(x['source_index'],0);self.assertIn('correct',x['message'])

    def test_normal_date_sequence_no_failure(self):
        self.assertNotEqual(exit_code(dates(record())),1)

    def test_future_completed_check_fails(self):
        led=record();led['claims'][0]['sources'][0]['date_checked']='2030-01-03'
        self.assertIn('DATE_IN_FUTURE',codes(dates(led)))

    def test_future_timestamp_check_fails(self):
        led=record();led['claims'][0]['sources'][0]['date_checked']='2030-01-02T19:00:00Z'
        self.assertIn('DATE_IN_FUTURE',codes(dates(led)))

    def test_today_date_only_not_falsely_future(self):
        led=record();led['generated_at']=None
        self.assertNotIn('DATE_IN_FUTURE',codes(dates(led,'2030-01-02T00:01:00Z')))

    def test_unknown_publication_unverified(self):
        led=record();led['claims'][0]['sources'][0]['publication_date']=None
        self.assertIn('DATE_UNKNOWN',codes(dates(led)))

    def test_unknown_check_unverified(self):
        led=record();led['claims'][0]['sources'][0]['date_checked']=None
        self.assertIn('DATE_UNKNOWN',codes(dates(led)))

    def test_invalid_date_fails(self):
        led=record();led['claims'][0]['sources'][0]['date_checked']='2030-02-30'
        self.assertIn('DATE_INVALID',codes(dates(led)))

    def test_missing_cutoff_unverified_no_year_inference(self):
        led=record();del led['cutoff']
        x=next(x for x in dates(led) if x['code']=='DATE_UNKNOWN')
        self.assertEqual(x['field'],'cutoff')

    def test_cutoff_after_generation_fails(self):
        led=record();led['cutoff']='2030-01-03'
        self.assertIn('CUTOFF_AFTER_GENERATION',codes(dates(led)))

    def test_visible_cutoff_mismatch_fails(self):
        led=record();led['cutoff']='2029-12-31'
        self.assertIn('HTML_CUTOFF_MISMATCH',codes(dates(led)))

    def test_source_published_after_cutoff_requires_review(self):
        led=record();led['claims'][0]['sources'][0]['publication_date']='2030-01-02'
        self.assertIn('PUBLICATION_AFTER_CUTOFF',codes(dates(led)))

    def test_post_report_recheck_requires_reason(self):
        led=record();led['claims'][0]['sources'][0]['date_checked']='2030-01-03'
        self.assertIn('CHECK_AFTER_GENERATION',codes(dates(led,'2030-01-04T12:00:00Z')))
        led['claims'][0]['sources'][0]['recheck_reason']='Historical revalidation of unchanged public source'
        found=codes(dates(led,'2030-01-04T12:00:00Z'))
        self.assertIn('POST_REPORT_RECHECK',found);self.assertNotIn('CHECK_AFTER_GENERATION',found)

    def test_recheck_reason_cannot_excuse_future_check(self):
        led=record();led['claims'][0]['sources'][0].update(date_checked='2099-01-01',recheck_reason='revalidation')
        self.assertIn('DATE_IN_FUTURE',codes(dates(led)))

    def test_future_event_is_permitted(self):
        led=record();led['claims'][0]['event_date']='2099-01-01'
        self.assertNotEqual(exit_code(dates(led)),1)

    def test_equivalent_offsets(self):
        a=interval('2030-01-02T08:00:00+08:00');b=interval('2030-01-02T00:00:00Z')
        self.assertEqual(a.start,b.start);self.assertEqual(a.end,b.end)

    def test_offset_order_not_string_order(self):
        led=record();led['claims'][0]['sources'][0].update(publication_date='2030-01-01T20:00:00Z',date_checked='2030-01-02T01:00:00+08:00')
        self.assertIn('CHECK_BEFORE_PUBLICATION',codes(dates(led)))

    def test_mixed_precision_overlap_unverified(self):
        led=record();led['claims'][0]['sources'][0].update(publication_date='2030-01-02',date_checked='2030-01-02T12:00:00Z')
        self.assertIn('DATE_ORDER_AMBIGUOUS',codes(dates(led)))

    def test_same_day_dates_ambiguous_not_fail(self):
        led=record();led['claims'][0]['sources'][0].update(publication_date='2030-01-02',date_checked='2030-01-02')
        self.assertIn('DATE_ORDER_AMBIGUOUS',codes(dates(led)));self.assertNotIn('CHECK_BEFORE_PUBLICATION',codes(dates(led)))

    def test_naive_timestamp_without_zone_unverified(self):
        led=record();del led['timezone'];led['claims'][0]['sources'][0]['date_checked']='2030-01-02T12:00:00'
        self.assertIn('DATE_UNKNOWN',codes(dates(led)))

    def test_naive_timestamp_with_zone(self):
        a=interval('2030-01-02T08:00:00','Asia/Hong_Kong')
        self.assertEqual(a.start,datetime(2030,1,2,tzinfo=timezone.utc))

    def test_iana_date_calendar_boundary(self):
        led=record();led.update(timezone='Asia/Hong_Kong',generated_at='2030-01-02T01:00:00+08:00')
        self.assertNotIn('DATE_IN_FUTURE',codes(dates(led,'2030-01-01T18:00:00Z')))

    def test_date_only_publication_vs_exact_cutoff_unverified(self):
        led=record();led['cutoff']='2030-01-01T12:00:00Z'
        self.assertIn('CUTOFF_ELIGIBILITY_AMBIGUOUS',codes(dates(led)))

    def test_same_instant_different_offsets_not_ambiguous(self):
        led=record();led['claims'][0]['sources'][0].update(publication_date='2030-01-01T00:00:00Z',date_checked='2030-01-01T08:00:00+08:00')
        self.assertNotIn('DATE_ORDER_AMBIGUOUS',codes(dates(led)))

    def test_blocked_attempt_cannot_be_in_future(self):
        led=record();led['claims'][0]['sources'][0].update(access_status='blocked',date_checked='2099-01-01')
        self.assertIn('DATE_IN_FUTURE',codes(dates(led)))

    def test_unknown_timezone_unverified(self):
        led=record();led['timezone']='Missing/Zone'
        self.assertIn('DATE_UNKNOWN',codes(dates(led)))

    def test_dst_ambiguous_and_nonexistent_unverified(self):
        for value in ('2029-11-04T01:30:00','2029-03-11T02:30:00'):
            with self.assertRaises(UnknownTime):interval(value,'America/New_York')

    def test_dst_date_only_day_length(self):
        a=interval('2029-03-11','America/New_York')
        self.assertEqual((a.end-a.start).total_seconds(),23*3600)

    def test_generation_must_fit_report_date(self):
        led=record();led['generated_at']='2029-12-31T23:00:00Z'
        self.assertIn('GENERATION_REPORT_MISMATCH',codes(dates(led)))

    def test_review_in_future_is_invalid(self):
        review={'date_checked':'2099-01-01','signoff':{'date':'2099-01-01'}}
        self.assertIn('DATE_IN_FUTURE',codes(dates(record(),review=review)))

    def test_signoff_before_review_fails(self):
        review={'date_checked':'2030-01-02','signoff':{'date':'2030-01-01'}}
        self.assertIn('SIGNOFF_BEFORE_REVIEW',codes(dates(record(),review=review)))

    def test_bad_dates_cannot_record_source_support(self):
        led=record();led['claims'][0]['sources'][0]['date_checked']='2020-01-01'
        blob=json.dumps(led).encode();rev=json.loads((FIX/'synthetic_review.json').read_text())
        rev.update(ledger_sha256=hashlib.sha256(blob).hexdigest(),report_sha256=hashlib.sha256(HTML.encode()).hexdigest())
        items=validate_evidence(HTML,led,rev,blob,now=NOW)
        self.assertIn('CLAIM_DATE_REVIEW_PENDING',codes(items));self.assertNotIn('RECORDED_SOURCE_REVIEW',codes(items));self.assertEqual(exit_code(items),1)

    def test_runtime_override_must_have_timezone(self):
        with self.assertRaises(ValueError):validate_dates(HTML,record(),now='2030-01-02T12:00:00')


class PipelineRegressionTests(unittest.TestCase):
    def test_synthetic_bad_dates_generate_actionable_report(self):
        led=record();led['claims'][0]['sources'][0]['date_checked']='2020-01-01'
        with tempfile.TemporaryDirectory() as tmp:
            h=Path(tmp)/'r.html';l=Path(tmp)/'l.json';h.write_text(HTML);l.write_text(json.dumps(led))
            result,md=run(h,l,now=NOW)
        self.assertEqual(result['outcome'],'FAIL');self.assertIn('CHECK_BEFORE_PUBLICATION',md)
        self.assertIn('claims[0].sources[0].date_checked',md)
        result,md=run(FIX/'synthetic_report.html',FIX/'inconsistent_dates_ledger.json',network=True,resolver=public_dns,transport=MockTransport({'https://fixture.invalid/source':(200,{},b'ok')}),now=NOW)
        self.assertEqual(result['network_mode'],'mock');self.assertIn('未访问公共网络',md)

    def test_unsafe_source_exit_one_in_pipeline(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Path(tmp)/'r.html';h.write_text(HTML.replace('https://fixture.invalid/source','http://169.254.169.254/latest/meta-data/'))
            result,_=run(h,now=NOW)
        self.assertEqual(result['outcome'],'FAIL');self.assertIn('UNSAFE_URL',codes(result['checks']['links']))

    def test_clock_override_refused_for_real_record(self):
        with tempfile.TemporaryDirectory() as tmp:
            h=Path(tmp)/'r.html';l=Path(tmp)/'l.json';h.write_text(HTML);led=record();led['fixture']=False;l.write_text(json.dumps(led))
            r=subprocess.run([sys.executable,str(SKILL/'scripts/validate.py'),str(h),'--ledger',str(l),'--as-of',NOW],capture_output=True,text=True)
        self.assertEqual(r.returncode,1);self.assertIn('INPUT_ERROR',r.stdout)

    def test_pass_fail_unverified_exit_codes_preserved(self):
        for items,code in [([{'status':'PASS'}],0),([{'status':'UNVERIFIED'}],2),([{'status':'FAIL'},{'status':'UNVERIFIED'}],1)]:
            self.assertEqual(exit_code(items),code)


if __name__=='__main__':unittest.main()
