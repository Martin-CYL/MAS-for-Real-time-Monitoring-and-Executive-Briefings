"""Deliberately flawed fixtures; no public network needed for tests."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from urllib.error import HTTPError, URLError

SKILL=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(SKILL/'scripts'))
from check_links import check as _check, external_urls, validate_links as _validate_links
from check_report import validate_report, dates_in
from check_evidence import validate_evidence as _validate_evidence
from qa_common import exit_code
from validate import run as _run
from mock_network import public_dns, MockTransport, FIXTURE_NOW


def check(*args,**kwargs):
    kwargs.setdefault('resolver',public_dns)
    return _check(*args,**kwargs)


def validate_links(*args,**kwargs):
    kwargs.setdefault('resolver',public_dns)
    return _validate_links(*args,**kwargs)


def validate_evidence(*args,**kwargs):
    kwargs.setdefault('now',FIXTURE_NOW)
    return _validate_evidence(*args,**kwargs)


def run(*args,**kwargs):
    kwargs.setdefault('resolver',public_dns)
    kwargs.setdefault('now',FIXTURE_NOW)
    return _run(*args,**kwargs)

FIX=SKILL/'tests/fixtures'
GOOD=(FIX/'synthetic_report.html').read_text()
LEDGER=json.loads((FIX/'synthetic_ledger.json').read_text())
REVIEW=json.loads((FIX/'synthetic_review.json').read_text())
BAD=(FIX/'flawed_report.html').read_text()
BAD_LEDGER=json.loads((FIX/'flawed_ledger.json').read_text())
BAD_REVIEW=json.loads((FIX/'flawed_review.json').read_text())


def codes(items):
    return {i['code'] for i in items}


class Response:
    status=200
    def __init__(self,body=b'Public source; no legal provisions.',url='https://fixture.invalid/source'):
        self.body,self.url=body,url
    def geturl(self): return self.url
    def read(self,n): return self.body[:n]
    def __enter__(self): return self
    def __exit__(self,*args): pass


def fixture_opener(req,timeout):
    if req.full_url.endswith('/dead'):
        raise HTTPError(req.full_url,404,'Missing',{},None)
    if req.full_url.endswith('/blocked'):
        raise HTTPError(req.full_url,403,'Blocked',{},None)
    return Response(url=req.full_url)


class LinkTests(unittest.TestCase):
    def test_extract_actual_hyperlinks(self):
        raw="<!-- <a href='https://fake.invalid'> --><script>var a='href=\"https://fake.invalid\"'</script><A HREF = 'https://fixture.invalid/a?x=1&amp;y=2'>source</A><a href=https://fixture.invalid/b>b</a>"
        self.assertEqual(external_urls(raw),['https://fixture.invalid/a?x=1&y=2','https://fixture.invalid/b'])

    def test_offline_is_unchecked(self):
        results=validate_links(GOOD)
        self.assertEqual(codes(results),{'UNCHECKED'})
        self.assertEqual(exit_code(results),2)

    def test_empty_links_fail(self):
        self.assertEqual(exit_code(validate_links('<p>No links</p>')),1)

    def test_malformed_url_fail(self):
        for u in ('https:///missing','https://fixture.invalid/a b','https://fixture.invalid:bad/a','https://user:password@fixture.invalid/a','https://[bad/a'):
            with self.subTest(u=u):
                self.assertEqual(check(u,opener=fixture_opener)['status'],'FAIL')

    def test_dead_and_blocked_distinct(self):
        self.assertEqual(check('https://fixture.invalid/dead',opener=fixture_opener)['code'],'BROKEN')
        self.assertEqual(check('https://fixture.invalid/blocked',opener=fixture_opener)['status'],'UNVERIFIED')

    def test_http_status_table(self):
        for code,category in [(401,'BLOCKED'),(402,'BLOCKED'),(403,'BLOCKED'),(407,'BLOCKED'),(429,'BLOCKED'),(451,'BLOCKED'),(404,'BROKEN'),(410,'BROKEN'),(408,'NETWORK_ERROR'),(500,'NETWORK_ERROR'),(503,'NETWORK_ERROR'),(400,'UNCHECKED'),(302,'UNCHECKED')]:
            def blocked(req,timeout): raise HTTPError(req.full_url,code,'fixture',{},None)
            with self.subTest(code=code):
                r=check('https://fixture.invalid/source',opener=blocked)
                self.assertEqual(r['code'],category)
                self.assertNotEqual(r['status'],'PASS')

    def test_network_errors_do_not_claim_no_network(self):
        def timeout(req,timeout): raise URLError('synthetic transport error')
        r=check('https://fixture.invalid/source',opener=timeout)
        self.assertEqual(r['code'],'NETWORK_ERROR')
        self.assertEqual(r['status'],'UNVERIFIED')

    def test_200_interstitials_unverified(self):
        for body,category in [(b'verify you are human','BLOCKED'),(b'subscribe to continue','BLOCKED'),(b'<title>404 Not Found</title>','UNCHECKED')]:
            with self.subTest(body=body):
                self.assertEqual(check('https://fixture.invalid/source',opener=lambda req,timeout:Response(body))['code'],category)

    def test_mock_http_get_and_redirect(self):
        base='https://source.example.org'
        transport=MockTransport({base+'/ok':(200,{},b'local mock source'),base+'/dead':(404,{},b''),
                                 base+'/blocked':(403,{},b''),base+'/busy':(429,{},b''),
                                 base+'/redirect':(302,{'Location':'/ok'},b'')})
        self.assertEqual(check(base+'/dead',transport=transport)['code'],'BROKEN')
        self.assertEqual(check(base+'/blocked',transport=transport)['status'],'UNVERIFIED')
        self.assertEqual(check(base+'/busy',transport=transport)['status'],'UNVERIFIED')
        r=check(base+'/redirect',transport=transport)
        self.assertEqual(r['code'],'REACHABLE'); self.assertEqual(r['final_url'],base+'/ok')


class ReportTests(unittest.TestCase):
    def test_valid_mechanical_fixture(self):
        r=validate_report(GOOD,'2030-01-02')
        self.assertEqual(exit_code(r),0,r)

    def test_dates_auto_conflict(self):
        r=validate_report(GOOD.replace('2030 年 1 月 2 日','2030 年 1 月 3 日'))
        self.assertIn('DATE_CONFLICT',codes(r)); self.assertEqual(exit_code(r),1)

    def test_cutoff_and_event_dates_do_not_conflict(self):
        r=validate_report(GOOD.replace('1 月 1 日','2029 年 12 月 30 日')+'<p>事件发生在 2020 年 5 月 3 日。</p>')
        self.assertNotIn('DATE_CONFLICT',codes(r))

    def test_footer_year_mismatch(self):
        self.assertIn('DATE_CONFLICT',codes(validate_report(GOOD.replace('02 JAN 2030','02 JAN 2029'))))

    def test_invalid_calendar_dates(self):
        self.assertIn('DATE_INVALID',codes(validate_report(GOOD.replace('2030.01.02','2030.02.30'))))

    def test_missing_date_requires_review(self):
        self.assertIn('DATE_MISSING',codes(validate_report('<p>只提供来源</p><a href="https://fixture.invalid">来源</a>')))

    def test_annotation_does_not_override_visible(self):
        self.assertIn('DATE_CONFLICT',codes(validate_report(GOOD.replace('2030.01.02</strong>','2030.01.03</strong>'))))

    def test_date_formats(self):
        self.assertEqual(dates_in('2030.1.2 / 2030年1月2日 / 02 JAN 2030事实'),['2030-01-02']*3)

    def test_later_abbr_cannot_fix_first_use(self):
        r=validate_report(GOOD.replace('演示研究机构（<abbr','XYZ 首次出现。演示研究机构（<abbr'))
        self.assertIn('FIRST_USE',codes(r))

    def test_empty_or_self_title_not_definition(self):
        for title in ('','XYZ'):
            raw=GOOD.replace('演示研究机构（<abbr title="演示研究机构">XYZ</abbr>）','<abbr title="'+title+'">XYZ</abbr>')
            self.assertIn('FIRST_USE',codes(validate_report(raw)))

    def test_long_acronym_not_blindly_ignored(self):
        self.assertIn('FIRST_USE',codes(validate_report(GOOD+'<p>UNESCO 发出消息。</p>')))

    def test_prose_definition_accepted(self):
        raw=GOOD.replace('演示研究机构（<abbr title="演示研究机构">XYZ</abbr>）','演示研究机构（XYZ）')
        self.assertNotIn('FIRST_USE',codes(validate_report(raw)))

    def test_placeholders_and_draft(self):
        r=validate_report(GOOD+'<p>{{标题}} 根据反馈，草稿尚待修订。</p>')
        self.assertTrue({'PLACEHOLDER','DRAFT_LANGUAGE'}<=codes(r)); self.assertEqual(exit_code(r),1)

    def test_hidden_draft_does_not_leak(self):
        r=validate_report(GOOD+'<!-- 草稿 --><script>const draft=1;</script><p hidden>草稿</p>')
        self.assertNotIn('DRAFT_LANGUAGE',codes(r))

    def test_figure_duplicate_gap_order(self):
        for figures,code in [([1,1],'FIGURE_DUPLICATE'),([1,3],'FIGURE_SEQUENCE'),([2,1],'FIGURE_SEQUENCE')]:
            raw=GOOD.replace('<figure><div class="micro">FIGURE 01 / 合成示意</div></figure>', ''.join(f'<figure><div class="micro">FIGURE {i:02}</div></figure>' for i in figures))
            self.assertIn(code,codes(validate_report(raw)))

    def test_figure_missing_label(self):
        self.assertIn('FIGURE_MISSING',codes(validate_report(GOOD+'<figure><figcaption>图表未编号</figcaption></figure>')))

    def test_inline_figure_reference_not_duplicate(self):
        self.assertNotIn('FIGURE_DUPLICATE',codes(validate_report(GOOD+'<p>参见 FIGURE 01。</p>')))

    def test_status_class_and_legend_mismatch(self):
        raw=GOOD+'<span class="st confirmed" data-evidence-status="reported">官方公告</span>'
        self.assertIn('STATUS_MISMATCH',codes(validate_report(raw)))
        raw=GOOD.replace('官方或公司正式公告','媒体报道')+'<span class="st confirmed">官方公告</span>'
        self.assertIn('LEGEND_MISMATCH',codes(validate_report(raw)))

    def test_legacy_legend_synonyms(self):
        raw=GOOD.replace('官方或公司正式公告','政府或公司正式公告').replace('媒体报道或未经独立验证','媒体报道或尚未经独立核验的企业数据')+'<span class="st confirmed">公告</span><span class="st reported">媒体报道</span>'
        self.assertNotIn('LEGEND_MISMATCH',codes(validate_report(raw)))
        self.assertNotIn('LEGEND_MISSING',codes(validate_report(raw)))

    def test_repeated_sentence_review(self):
        sentence='<p>这是一段足够长且完全相同的合成解释，用于检测重复措辞。</p>'
        self.assertIn('REPETITION',codes(validate_report(GOOD+sentence*2)))

    def test_chapter_gap(self):
        self.assertIn('CHAPTER_SEQUENCE',codes(validate_report(GOOD+'<div class="kicker">01 / 章节</div><div class="kicker">03 / 章节</div>')))


class EvidenceTests(unittest.TestCase):
    def validate(self,raw=GOOD,ledger=None,review=None,ledger_file='synthetic_ledger.json'):
        return validate_evidence(raw,ledger if ledger is not None else LEDGER,review,(FIX/ledger_file).read_bytes())

    def test_author_supported_not_verified(self):
        r=self.validate()
        self.assertIn('CLAIM_REVIEW_PENDING',codes(r)); self.assertEqual(exit_code(r),2)
        self.assertNotIn('RECORDED_SOURCE_REVIEW',codes(r))

    def test_independent_review_record_and_fixture_hold(self):
        r=self.validate(review=REVIEW)
        self.assertIn('RECORDED_SOURCE_REVIEW',codes(r))
        self.assertIn('HUMAN_SIGNOFF',codes(r)); self.assertEqual(exit_code(r),2)

    def test_fabricated_legal_claim_rejected(self):
        r=self.validate(BAD,BAD_LEDGER,BAD_REVIEW,'flawed_ledger.json')
        rejected=[x for x in r if x.get('claim_id')=='C002']
        self.assertIn('CLAIM_UNSUPPORTED',codes(rejected)); self.assertEqual(exit_code(r),1)
        self.assertFalse(any(x['status']=='PASS' for x in rejected))

    def test_no_review_cannot_verify_legal_claim(self):
        r=self.validate(BAD,BAD_LEDGER,ledger_file='flawed_ledger.json')
        self.assertTrue(any(x['code']=='CLAIM_REVIEW_PENDING' and x.get('claim_id')=='C002' for x in r))

    def test_reachable_url_cannot_verify_legal_claim(self):
        r=validate_links(BAD,network=True,opener=lambda req,timeout:Response(url=req.full_url))
        self.assertEqual(exit_code(r),0)
        # Passing HTTP checks must have no effect on source-specific evidence.
        e=self.validate(BAD,BAD_LEDGER,ledger_file='flawed_ledger.json')
        self.assertIn('CLAIM_REVIEW_PENDING',codes(e)); self.assertNotIn('RECORDED_SOURCE_REVIEW',codes(e))

    def test_text_mismatch(self):
        self.assertIn('CLAIM_TEXT_MISMATCH',codes(self.validate(GOOD.replace('12 次','99 次'))))

    def test_stale_hash_invalidates_review(self):
        r=self.validate(GOOD+'\n',review=REVIEW)
        self.assertIn('REVIEW_STALE',codes(r)); self.assertNotIn('RECORDED_SOURCE_REVIEW',codes(r))

    def test_author_self_review_rejected(self):
        review=copy.deepcopy(REVIEW); review['reviewer']='fixture-author'
        self.assertIn('REVIEW_INDEPENDENCE',codes(self.validate(review=review)))

    def test_unsupported_quotation_not_verification(self):
        review=copy.deepcopy(REVIEW); review['claims'][0]['support_quote']='作者未收集的内容'
        r=self.validate(review=review)
        self.assertIn('REVIEW_SUPPORT_MISSING',codes(r)); self.assertNotIn('RECORDED_SOURCE_REVIEW',codes(r))

    def test_unknown_and_duplicate_claim_ids(self):
        self.assertIn('CLAIM_UNKNOWN',codes(self.validate(GOOD.replace('C001','C009'))))
        ledger=copy.deepcopy(LEDGER); ledger['claims'].append(copy.deepcopy(ledger['claims'][0]))
        self.assertIn('CLAIM_DUPLICATE',codes(self.validate(ledger=ledger)))

    def test_missing_quote_and_blocked_source(self):
        ledger=copy.deepcopy(LEDGER); ledger['claims'][0]['sources'][0]['quote']=''; ledger['claims'][0]['sources'][0]['access_status']='blocked'
        self.assertIn('SUPPORT_MISSING',codes(self.validate(ledger=ledger)))

    def test_missing_ledger_unverified(self):
        # Round 4: a report that marks claims but ships no ledger skipped the evidence step.
        # This was UNVERIFIED (exit 2), indistinguishable from a complete run awaiting sign-off.
        r=validate_evidence(GOOD)
        self.assertEqual(exit_code(r),1); self.assertIn('LEDGER_MISSING',codes(r))

    def test_unmarked_risk_requires_coverage_review(self):
        r=self.validate(GOOD+'<p>名单显示所有企业均受到制裁。</p>')
        self.assertIn('UNMARKED_RISK_CLAIM',codes(r))

    def test_ledger_schema_error(self):
        self.assertEqual(exit_code(validate_evidence(GOOD,{'schema_version':1,'claims':'invalid'})),1)

    def test_review_unknown_claim(self):
        r=copy.deepcopy(REVIEW); r['claims'][0]['claim_id']='C999'
        self.assertIn('REVIEW_CLAIM',codes(self.validate(review=r)))


class IntegrationTests(unittest.TestCase):
    def test_exact_crlf_report_fingerprint(self):
        with tempfile.TemporaryDirectory() as d:
            report=Path(d)/'report.html'; reviewpath=Path(d)/'review.json'
            data=GOOD.replace('\n','\r\n').encode('utf-8'); report.write_bytes(data)
            review=copy.deepcopy(REVIEW); review['report_sha256']=hashlib.sha256(data).hexdigest()
            reviewpath.write_text(json.dumps(review,ensure_ascii=False))
            result,_=run(report,FIX/'synthetic_ledger.json',reviewpath)
            self.assertEqual(result['report_sha256'],hashlib.sha256(data).hexdigest())
            self.assertNotIn('REVIEW_STALE',codes(result['checks']['evidence']))
            self.assertIn('RECORDED_SOURCE_REVIEW',codes(result['checks']['evidence']))

    def test_flawed_review_report_has_all_three_states(self):
        result,md=run(FIX/'flawed_report.html',FIX/'flawed_ledger.json',FIX/'flawed_review.json',network=True,opener=fixture_opener)
        self.assertEqual(result['outcome'],'FAIL')
        statuses={x['status'] for v in result['checks'].values() for x in v}
        self.assertEqual(statuses,{'PASS','FAIL','UNVERIFIED'})
        for word in ('C002','CLAIM_UNSUPPORTED','BROKEN','BLOCKED','人工签核','不等于事实全部核验'):
            self.assertIn(word,md)

    def test_cli_exit_and_files(self):
        with tempfile.TemporaryDirectory() as d:
            cmd=[sys.executable,str(SKILL/'scripts/validate.py'),str(FIX/'flawed_report.html'),'--ledger',str(FIX/'flawed_ledger.json'),'--review',str(FIX/'flawed_review.json'),'--output-dir',d,'--as-of',FIXTURE_NOW]
            r=subprocess.run(cmd,capture_output=True,text=True)
            self.assertEqual(r.returncode,1,r.stdout+r.stderr)
            self.assertEqual(json.loads((Path(d)/'review_report.json').read_text())['outcome'],'FAIL')
            cmd[2]=str(FIX/'synthetic_report.html'); cmd[4]=str(FIX/'synthetic_ledger.json'); cmd[6]=str(FIX/'synthetic_review.json')
            self.assertEqual(subprocess.run(cmd,capture_output=True).returncode,2)

    def test_cli_invalid_json_actionable(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'bad.json'; p.write_text('{broken')
            r=subprocess.run([sys.executable,str(SKILL/'scripts/validate.py'),str(FIX/'synthetic_report.html'),'--ledger',str(p)],capture_output=True,text=True)
            self.assertEqual(r.returncode,1); self.assertIn('INPUT_ERROR',r.stdout)

class AdditionalEvidenceTests(unittest.TestCase):
    def test_human_rejection_is_fail(self):
        r=copy.deepcopy(REVIEW); r['signoff']['decision']='reject'
        items=validate_evidence(GOOD,LEDGER,r,(FIX/'synthetic_ledger.json').read_bytes())
        self.assertIn('HUMAN_REJECTED',codes(items)); self.assertEqual(exit_code(items),1)

    def test_agent_cannot_complete_human_signoff(self):
        r=copy.deepcopy(REVIEW); r['actor']='independent_agent'; r['signoff']['decision']='approve'
        items=validate_evidence(GOOD,LEDGER,r,(FIX/'synthetic_ledger.json').read_bytes())
        self.assertIn('HUMAN_SIGNOFF',codes(items)); self.assertNotIn('RECORDED_SIGNOFF',codes(items))

    def test_changed_ledger_bytes_invalidate_review(self):
        items=validate_evidence(GOOD,LEDGER,REVIEW,(FIX/'synthetic_ledger.json').read_bytes()+b'\n')
        self.assertIn('REVIEW_STALE',codes(items))

    def test_missing_primary_legal_source_escalates(self):
        items=validate_evidence(BAD,BAD_LEDGER,None,(FIX/'flawed_ledger.json').read_bytes())
        self.assertIn('PRIMARY_LEGAL_SOURCE',codes(items))

    def test_nested_claims_fail(self):
        raw=GOOD.replace('<p data-claim-id="C001">','<p data-claim-id="C001"><span data-claim-id="C001">').replace('12 次运算。</p>','12 次运算。</span></p>')
        items=validate_evidence(raw,LEDGER)
        self.assertIn('CLAIM_NESTING',codes(items))

    def test_invalid_field_types_actionable(self):
        ledger=copy.deepcopy(LEDGER); ledger['claims'][0]['text']=None; ledger['claims'][0]['sources']=None
        items=validate_evidence(GOOD,ledger,REVIEW,(FIX/'synthetic_ledger.json').read_bytes())
        self.assertIn('CLAIM_TEXT',codes(items)); self.assertEqual(exit_code(items),1)

    def test_human_approval_cannot_erase_unsupported_claim(self):
        review=copy.deepcopy(BAD_REVIEW); review['signoff']['decision']='approve'
        items=validate_evidence(BAD,BAD_LEDGER,review,(FIX/'flawed_ledger.json').read_bytes())
        self.assertEqual(exit_code(items),1); self.assertIn('CLAIM_UNSUPPORTED',codes(items))


class HistoricalReferenceTests(unittest.TestCase):
    def test_v17_mechanical_compatibility(self):
        path=SKILL.parents[2]/'examples/V17_reference_2026-10-09.html'
        if not path.exists():
            path=SKILL/'examples/V17_reference_2026-10-09.html'
        if not path.exists():
            self.skipTest('Historical project example is not bundled in standalone Skill')
        items=validate_report(path.read_text(),'2026-10-09',SKILL/'references/glossary.md')
        unexpected={'DATE_CONFLICT','DATE_MISSING','FIGURE_SEQUENCE','FIGURE_DUPLICATE','LEGEND_MISSING','LEGEND_MISMATCH'} & codes(items)
        self.assertFalse(unexpected,items)


class MoreReportLinkTests(unittest.TestCase):
    def test_proxy_block_not_destination_response(self):
        def blocked(req,timeout):
            raise URLError(OSError('Tunnel connection failed: 403 Forbidden'))
        r=check('https://fixture.invalid/source',opener=blocked)
        self.assertEqual(r['status'],'UNVERIFIED'); self.assertEqual(r['code'],'BLOCKED')
        self.assertIsNone(r['http_status']); self.assertEqual(r['proxy_http_status'],403)

    def test_tls_error_is_not_silently_passed(self):
        import ssl
        def tls(req,timeout):
            raise URLError(ssl.SSLCertVerificationError('CERTIFICATE_VERIFY_FAILED'))
        r=check('https://fixture.invalid/source',opener=tls)
        self.assertEqual(r['code'],'NETWORK_ERROR'); self.assertEqual(r['status'],'UNVERIFIED')

    def test_relative_links_not_guessed(self):
        items=validate_links('<a href="/source">source</a><a href="//fixture.invalid/source">source</a>')
        self.assertEqual(codes(items),{'UNCHECKED'}); self.assertEqual(exit_code(items),2)

    def test_placeholder_and_unsafe_links_fail(self):
        for link in ('{{URL}}','javascript:alert(1)','#',''):
            self.assertEqual(exit_code(validate_links('<a href="'+link+'">source</a>')),1)

    def test_inert_template_hyperlinks_not_requested(self):
        raw='<template><a href="https://fake.invalid">not active</a></template><a href="https://fixture.invalid/source">source</a>'
        self.assertEqual(external_urls(raw),['https://fixture.invalid/source'])

    def test_bare_figure_label_numbering(self):
        raw=GOOD.replace('<div class="micro">FIGURE 01 / 合成示意</div>','<div>FIGURE 03 / 合成示意</div>')
        self.assertIn('FIGURE_SEQUENCE',codes(validate_report(raw)))

    def test_valueless_date_annotation_is_fail(self):
        raw=GOOD.replace('data-report-date="2030-01-02"','data-report-date')
        self.assertIn('DATE_INVALID',codes(validate_report(raw)))


if __name__=='__main__':
    unittest.main()
