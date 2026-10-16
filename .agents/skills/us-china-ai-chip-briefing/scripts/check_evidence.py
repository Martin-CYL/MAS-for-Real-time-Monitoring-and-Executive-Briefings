#!/usr/bin/env python3
"""Traceability and independent review records, not automated truth verification."""
import argparse
from datetime import date
import hashlib
import json
from pathlib import Path
import re
from check_dates import validate_dates, interval, UnknownTime
from html_model import Document, normalized
from check_links import external_urls, url_valid
from qa_common import finding, emit, exit_code

KINDS={'factual','technical','legal','list','negative','statistic','company_response'}
TYPES={'official_document','company_statement','news','dataset','other'}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def valid_date(value):
    try:
        return isinstance(value,str) and date.fromisoformat(value).isoformat()==value
    except (ValueError,TypeError):
        return False


def valid_temporal(value,zone=None):
    try:
        interval(value,zone)
        return True
    except UnknownTime:
        return True  # unknown precision is explicitly escalated by check_dates
    except (ValueError,OverflowError):
        return False


def load_object(path):
    value=json.loads(Path(path).read_text(encoding='utf-8'))
    if not isinstance(value,dict):
        raise ValueError('Expected a JSON object')
    return value


def validate_evidence(raw, ledger=None, review=None, ledger_bytes=None, now=None, risk=None):
    """risk: optional {claim_id: {'tier','quote_state',...}} from check_quotes. Low-risk claims
    whose quote was found pass without human review."""
    items=[]
    def add(status,code,msg,**kw):
        items.append(finding(status,code,msg,**kw))
    doc=Document(raw)
    markers=[n for n in doc.nodes if 'data-claim-id' in n.attrs]
    if not ledger:
        # A report that marks claims but ships no ledger skipped the evidence step: that is a
        # rule violation, not merely something unverified. Without claim markers there is
        # nothing to trace either, so the same applies.
        add('FAIL','LEDGER_MISSING',
            f'No evidence ledger; {len(markers)} claim markers in the report cannot be traced to any source'
            if markers else 'No evidence ledger; no fact in the report can be traced to a source')
        return items
    if not isinstance(ledger,dict) or ledger.get('schema_version')!=1 or not isinstance(ledger.get('claims'),list):
        return [finding('FAIL','LEDGER_SCHEMA','Require schema_version=1 and claims array')]
    date_findings=validate_dates(raw,ledger,review,now)
    items.extend(date_findings)
    bad_date_claims={x.get('claim_id') for x in date_findings if x['status']=='FAIL' and x.get('claim_id')}
    bad_review_dates=any(x['status']=='FAIL' and x.get('field','').startswith('review.') for x in date_findings)
    author=ledger.get('author')
    if not isinstance(author,str) or not author.strip() or not valid_date(ledger.get('report_date')) or not isinstance(ledger.get('fixture'),bool):
        add('FAIL','LEDGER_SCHEMA','Require author, valid report_date and explicit fixture boolean')
    if ledger.get('fixture'):
        add('UNVERIFIED','SYNTHETIC_FIXTURE','Synthetic fixture; not a news report or release candidate')
    report_dates={n.attrs['data-report-date'] for n in doc.nodes if 'data-report-date' in n.attrs}
    if report_dates and report_dates!={ledger.get('report_date')}:
        add('FAIL','LEDGER_DATE','HTML report date and ledger report_date disagree')
    claims={}
    urls=set(external_urls(raw))
    for c in ledger['claims']:
        if not isinstance(c,dict):
            add('FAIL','LEDGER_SCHEMA','Claim must be an object'); continue
        cid=c.get('id')
        if not isinstance(cid,str) or not re.fullmatch(r'C[0-9]{3,}',cid):
            add('FAIL','CLAIM_ID','Claim ID must be C plus at least 3 digits'); continue
        if cid in claims:
            add('FAIL','CLAIM_DUPLICATE','Duplicate ledger claim',claim_id=cid); continue
        claims[cid]=c
        if not isinstance(c.get('text'),str) or not c['text'].strip():
            add('FAIL','CLAIM_TEXT','Exact claim text required',claim_id=cid)
        kinds=c.get('kinds')
        if not isinstance(kinds,list) or not kinds or any(not isinstance(k,str) or k not in KINDS for k in kinds):
            add('FAIL','CLAIM_KINDS','Invalid/missing claim kinds',claim_id=cid)
        if c.get('author_status') not in ('supported','unsupported','unverified'):
            add('FAIL','AUTHOR_STATUS','Author label must not assert VERIFIED',claim_id=cid)
        if c.get('author_status')=='unsupported':
            add('FAIL','AUTHOR_UNSUPPORTED','Author records claim as unsupported; remove or correct',claim_id=cid)
        if 'event_date' not in c or (c['event_date'] is not None and not valid_date(c['event_date'])):
            add('FAIL','EVENT_DATE','Event date required; null if genuinely unknown',claim_id=cid)
        if not isinstance(c.get('uncertainty'),str):
            add('FAIL','UNCERTAINTY','Record uncertainty notes, even if empty',claim_id=cid)
        sources=c.get('sources')
        if not isinstance(sources,list) or not sources:
            add('UNVERIFIED','SOURCE_MISSING','No source-specific evidence',claim_id=cid); continue
        for s in sources:
            if not isinstance(s,dict):
                add('FAIL','SOURCE_SCHEMA','Source must be an object',claim_id=cid); continue
            u=s.get('url','')
            if not isinstance(u,str) or not url_valid(u):
                add('FAIL','SOURCE_URL','Actual absolute source URL required',claim_id=cid); continue
            if u not in urls:
                add('FAIL','SOURCE_NOT_LINKED','Ledger source is not an actual HTML hyperlink',claim_id=cid,url=u)
            if s.get('source_role') not in ('primary','secondary') or s.get('evidence_type') not in TYPES or not isinstance(s.get('notes'),str):
                add('FAIL','SOURCE_SCHEMA','Require role, evidence type and notes',claim_id=cid,url=u)
            if 'publication_date' not in s or (s['publication_date'] is not None and not valid_temporal(s['publication_date'],ledger.get('timezone'))):
                add('FAIL','PUBLICATION_DATE','Publication date required (null if unavailable)',claim_id=cid,url=u)
            if not valid_temporal(s.get('date_checked'),ledger.get('timezone')):
                add('FAIL','CHECK_DATE','Valid date_checked required',claim_id=cid,url=u)
            if s.get('access_status') not in ('opened','blocked','unchecked'):
                add('FAIL','ACCESS_STATUS','Access status required',claim_id=cid,url=u)
            if s.get('access_status')!='opened' or not isinstance(s.get('quote'),str) or not s['quote'].strip() or not isinstance(s.get('anchor'),str) or not s['anchor'].strip():
                add('UNVERIFIED','SUPPORT_MISSING','Need opened source, extracted support and locatable anchor',claim_id=cid,url=u)

    marked_ids=set()
    for n in markers:
        cid=n.attrs['data-claim-id']
        marked_ids.add(cid)
        if cid not in claims:
            add('FAIL','CLAIM_UNKNOWN','HTML claim ID not in ledger',claim_id=cid,line=n.line)
        elif normalized(n.text())!=normalized(claims[cid].get('text','') if isinstance(claims[cid].get('text'),str) else ''):
            add('FAIL','CLAIM_TEXT_MISMATCH','Marked HTML text differs from exact ledger claim',claim_id=cid,line=n.line)
        if any(p is not n and 'data-claim-id' in p.attrs for p in n.ancestors()):
            add('FAIL','CLAIM_NESTING','Do not nest claim markers',claim_id=cid,line=n.line)
    for cid in claims.keys()-marked_ids:
        add('UNVERIFIED','CLAIM_UNREFERENCED','Ledger claim not referenced by HTML',claim_id=cid)
    if not claims or not markers:
        add('FAIL','NO_CLAIMS','Ledger and HTML need at least one material claim')

    # This catches obvious omissions, not comprehensive natural-language coverage.
    risk_pattern=(r'制裁|名单|禁令|生效|未发现|未列入|没有达成|\d+(?:\.\d+)?\s*[%％]|\d+\s*(?:亿美元|亿元)'
                  r'|(?i:sanction|entity list|\bbanned?\b|takes? effect|in force|not listed|no agreement|\$\s?\d[\d.,]*\s?(?:bn|billion|million|m)\b)')
    for n in doc.nodes:
        if n.tag in ('p','td') and re.search(risk_pattern,n.text()):
            if not any('data-claim-id' in p.attrs for p in n.ancestors()) and not any('data-claim-id' in child.attrs and any(p is n for p in child.ancestors()) for child in doc.nodes):
                add('UNVERIFIED','UNMARKED_RISK_CLAIM','Possible unmarked material fact; reviewer must check coverage',line=n.line,excerpt=normalized(n.text())[:120])
    add('PASS','TRACEABILITY_SCAN','Traceability scan executed; author labels and quotations are not proof')

    for cid,c in claims.items():
        if isinstance(c.get('kinds'),list) and set(k for k in c['kinds'] if isinstance(k,str)) & {'legal','list'}:
            sources=c.get('sources') if isinstance(c.get('sources'),list) else []
            if not any(isinstance(s,dict) and s.get('source_role')=='primary' and s.get('evidence_type') in ('official_document','dataset') and s.get('access_status')=='opened' for s in sources):
                add('UNVERIFIED','PRIMARY_LEGAL_SOURCE','Legal/list conclusion needs applicable original instrument or list record',claim_id=cid)

    expected_ledger_hash=sha256(ledger_bytes if ledger_bytes is not None else json.dumps(ledger,ensure_ascii=False,sort_keys=True).encode())
    good_review=isinstance(review,dict)
    if bad_review_dates:
        add('FAIL','REVIEW_DATE_INVALID','Invalid review chronology; correct the actual review/sign-off time')
        good_review=False
    if not isinstance(review,dict):
        add('UNVERIFIED','INDEPENDENT_REVIEW_MISSING','Reviewer must reopen sources, not trust author labels')
    else:
        if review.get('report_sha256')!=sha256(raw.encode('utf-8')) or review.get('ledger_sha256')!=expected_ledger_hash:
            add('FAIL','REVIEW_STALE','Review hashes must match exact report and ledger bytes'); good_review=False
        if review.get('schema_version')!=1:
            add('FAIL','REVIEW_SCHEMA','Require review schema_version=1'); good_review=False
        if not isinstance(review.get('reviewer'),str) or not review['reviewer'].strip() or review.get('reviewer')==author or review.get('actor') not in ('human','independent_agent'):
            add('FAIL','REVIEW_INDEPENDENCE','Reviewer identity must differ from author, with explicit actor'); good_review=False
        if not valid_temporal(review.get('date_checked'),ledger.get('timezone')) or not isinstance(review.get('claims'),list):
            add('FAIL','REVIEW_SCHEMA','Review date and per-claim review array required'); good_review=False
    reviewed={}
    if good_review:
        for r in review['claims']:
            if not isinstance(r,dict) or r.get('claim_id') not in claims:
                add('FAIL','REVIEW_CLAIM','Review refers to invalid or unknown claim'); continue
            cid=r['claim_id']
            if cid in reviewed:
                add('FAIL','REVIEW_DUPLICATE','Duplicate per-claim review',claim_id=cid); continue
            reviewed[cid]=r
    for cid,c in claims.items():
        r=reviewed.get(cid)
        rk=(risk or {}).get(cid)
        if not r and cid not in bad_date_claims and rk and rk.get('tier')=='low' and rk.get('quote_state')=='FOUND' and c.get('author_status')=='supported':
            add('PASS','AUTO_LOW_RISK','Low-risk claim; quote found in fetched source or verified snapshot; no human review required',claim_id=cid); continue
        if not r:
            if rk and rk.get('tier')=='low':
                add('UNVERIFIED','CLAIM_REVIEW_PENDING','Low-risk claim; passes automatically once its quote is found (live page or snapshot) or a person confirms it',claim_id=cid,tier='low')
            else:
                add('UNVERIFIED','CLAIM_REVIEW_PENDING','No valid independent source review',claim_id=cid)
            continue
        disposition=r.get('disposition')
        if disposition not in ('supported','unsupported','unverified'):
            add('FAIL','REVIEW_DISPOSITION','Invalid review disposition',claim_id=cid); continue
        if disposition=='unsupported':
            add('FAIL','CLAIM_UNSUPPORTED',str(r.get('rationale','Unsupported claim')),claim_id=cid); continue
        if disposition=='unverified':
            add('UNVERIFIED','CLAIM_REVIEW_PENDING',str(r.get('rationale','Evidence unresolved')),claim_id=cid); continue
        if cid in bad_date_claims:
            add('UNVERIFIED','CLAIM_DATE_REVIEW_PENDING','Source dates are inconsistent; fix them and re-review before recording support',claim_id=cid)
            continue
        matched=next((s for s in (c.get('sources') if isinstance(c.get('sources'),list) else []) if isinstance(s,dict) and s.get('url')==r.get('source_url') and s.get('quote')==r.get('support_quote') and s.get('anchor')==r.get('anchor') and s.get('access_status')=='opened'),None)
        if not matched or not r.get('support_quote') or not r.get('anchor') or not isinstance(r.get('rationale'),str) or not r['rationale'].strip():
            add('UNVERIFIED','REVIEW_SUPPORT_MISSING','Review needs locatable support and explanation tied to ledger source',claim_id=cid)
        else:
            add('PASS','RECORDED_SOURCE_REVIEW','Independent source review recorded; semantic truth depends on reviewer',claim_id=cid,reviewer=review['reviewer'])
    coverage=review.get('coverage') if good_review else None
    if not isinstance(coverage,dict) or coverage.get('complete') is not True or not coverage.get('notes'):
        add('UNVERIFIED','COVERAGE_REVIEW','Human must check all material facts, including facts without claim markers')
    signoff=review.get('signoff') if good_review else None
    if isinstance(signoff,dict) and signoff.get('decision')=='reject':
        add('FAIL','HUMAN_REJECTED','Reviewer rejects release of these artifacts')
    elif not isinstance(signoff,dict) or review.get('actor')!='human' or signoff.get('decision')!='approve' or signoff.get('reviewer')!=review.get('reviewer') or not valid_temporal(signoff.get('date'),ledger.get('timezone')):
        add('UNVERIFIED','HUMAN_SIGNOFF','Final human sign-off pending; no automatic VERIFIED label')
    else:
        add('PASS','RECORDED_SIGNOFF','Human approval recorded for these exact artifacts; not authenticated by this script')
    return items


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('html'); ap.add_argument('--ledger',required=True); ap.add_argument('--review'); ap.add_argument('--json',dest='json_path'); ap.add_argument('--as-of',help='Fixture-only deterministic timezone-aware clock')
    args=ap.parse_args()
    try:
        raw=Path(args.html).read_bytes().decode('utf-8')
        ledger=load_object(args.ledger)
        if args.as_of and ledger.get('fixture') is not True: raise ValueError('Clock override is fixture-only')
        items=validate_evidence(raw,ledger,load_object(args.review) if args.review else None,Path(args.ledger).read_bytes(),args.as_of)
    except (OSError,ValueError) as e:
        items=[finding('FAIL','INPUT_ERROR',type(e).__name__+': invalid or unreadable input')]
    emit(items,args.json_path)
    return exit_code(items)


if __name__=='__main__':
    raise SystemExit(main())
