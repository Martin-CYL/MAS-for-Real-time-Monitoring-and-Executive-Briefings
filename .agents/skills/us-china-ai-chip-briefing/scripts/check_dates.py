"""Cross-field temporal QA, with intervals for date-only/coarse records.

Legacy date-only v1 fields use UTC unless ledger.timezone gives an IANA zone.
Naive timestamps require an explicit IANA timezone and must not be ambiguous/nonexistent.
Publication and checking are observations; event_date may describe a future event.
"""
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
import re
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from html_model import Document
from qa_common import finding

UTC=timezone.utc
DATE_RE=r'\d{4}-\d{2}-\d{2}'
TIME_RE=DATE_RE+r'T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})?'


class UnknownTime(ValueError):
    pass


@dataclass(frozen=True)
class Interval:
    start: datetime
    end: datetime
    precision: str
    raw: str


def zone_of(name):
    if name in (None,'UTC','Etc/UTC'): return UTC
    try:
        return ZoneInfo(name or 'UTC')
    except (ZoneInfoNotFoundError,TypeError,ValueError) as e:
        raise UnknownTime('Unknown IANA timezone; supply a valid ledger.timezone') from e


def interval(value,zone_name=None):
    if value is None or value=='':
        raise UnknownTime('Date is unknown; obtain it from the source or keep UNVERIFIED')
    if not isinstance(value,str):
        raise ValueError('Date/time must be an ISO string')
    if re.fullmatch(DATE_RE,value):
        day=date.fromisoformat(value); z=zone_of(zone_name)
        start=datetime.combine(day,datetime.min.time(),z)
        end=datetime.combine(day+timedelta(days=1),datetime.min.time(),z)
        return Interval(start.astimezone(UTC),end.astimezone(UTC),'date',value)
    if not re.fullmatch(TIME_RE,value):
        raise ValueError('Use YYYY-MM-DD or ISO 8601 timestamp with T and timezone offset')
    dt=datetime.fromisoformat(value.replace('Z','+00:00'))
    if dt.tzinfo is None:
        if not zone_name:
            raise UnknownTime('Naive timestamp needs explicit ledger.timezone or UTC offset')
        z=zone_of(zone_name)
        a=dt.replace(tzinfo=z,fold=0); b=dt.replace(tzinfo=z,fold=1)
        if a.utcoffset()!=b.utcoffset():
            raise UnknownTime('Ambiguous/nonexistent local time; supply an explicit UTC offset')
        if a.astimezone(UTC).astimezone(z).replace(tzinfo=None)!=dt:
            raise UnknownTime('Nonexistent local time; supply an explicit UTC offset')
        dt=a
    frac=re.search(r'\.(\d+)',value)
    duration=timedelta(microseconds=10**(6-len(frac[1]))) if frac else timedelta(seconds=1) if re.search(r'T\d{2}:\d{2}:',value) else timedelta(minutes=1)
    start=dt.astimezone(UTC)
    return Interval(start,start+duration,'timestamp',value)


def parse_runtime(now=None):
    if now is None:return datetime.now(UTC)
    if isinstance(now,str):now=datetime.fromisoformat(now.replace('Z','+00:00'))
    if not isinstance(now,datetime) or now.tzinfo is None:
        raise ValueError('Injected runtime clock must be timezone-aware')
    return now.astimezone(UTC)


def validate_dates(raw,ledger,review=None,now=None):
    items=[]; clock=parse_runtime(now)
    if not isinstance(ledger,dict):return items
    zone=ledger.get('timezone')
    def add(status,code,message,field,**location):
        items.append(finding(status,code,message,field=field,**location))
    def read(value,field,optional=False,**loc):
        if optional and value is None:return None
        try:return interval(value,zone)
        except UnknownTime as e:
            add('UNVERIFIED','DATE_UNKNOWN',str(e),field,**loc)
        except (ValueError,OverflowError) as e:
            add('FAIL','DATE_INVALID',str(e)+'; correct the source record, do not invent dates',field,**loc)
        return None
    def not_future(value,field,**loc):
        if value and value.start>clock:
            add('FAIL','DATE_IN_FUTURE',f'{value.raw} is after runtime {clock.isoformat()}; correct the completed-observation time',field,**loc)
    def not_before(later,earlier,code,field,**loc):
        if not later or not earlier:return
        if later.end<=earlier.start:
            add('FAIL',code,f'{later.raw} precedes {earlier.raw}; correct dates from the original source',field,**loc)
        elif later.start<earlier.end:
            # Identical timestamps at equal precision can denote the same instant.
            if later.precision==earlier.precision=='timestamp' and later.start==earlier.start and later.end==earlier.end:return
            add('UNVERIFIED','DATE_ORDER_AMBIGUOUS',f'{later.raw} and {earlier.raw} overlap at recorded precision; add source-backed time/offset if ordering matters',field,**loc)
    report=read(ledger.get('report_date'),'report_date')
    generated=read(ledger.get('generated_at'),'generated_at',optional=True) or report
    not_future(generated,'generated_at' if ledger.get('generated_at') else 'report_date')
    if report and generated and (generated.end<=report.start or generated.start>=report.end):
        add('FAIL','GENERATION_REPORT_MISMATCH','generated_at is outside report_date in ledger timezone; correct generation metadata','generated_at')
    cutoff=read(ledger.get('cutoff'),'cutoff')
    if cutoff and generated:
        not_before(generated,cutoff,'CUTOFF_AFTER_GENERATION','cutoff')
    if cutoff: not_future(cutoff,'cutoff')
    # Never infer the missing year in legacy masthead cutoff prose.
    issues=Document(raw).selected('issue')
    for node in issues:
        m=re.search(r'(?:资料|数据|信息)截至\s*(.*)',node.text())
        if not m:continue
        full=re.match(r'(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日',m[1])
        iso=re.match(DATE_RE,m[1])
        partial=re.match(r'(\d{1,2})\s*月\s*(\d{1,2})\s*日',m[1])
        expected=None
        try:
            if full:expected=date(int(full[1]),int(full[2]),int(full[3]))
            elif iso:expected=date.fromisoformat(iso[0])
            elif partial and cutoff:
                z=zone_of(zone); localday=cutoff.start.astimezone(z).date()
                if (localday.month,localday.day)!=(int(partial[1]),int(partial[2])):
                    add('FAIL','HTML_CUTOFF_MISMATCH','Visible cutoff month/day differs from ledger.cutoff; align the issue metadata','cutoff',line=node.line)
            if expected and cutoff and expected!=cutoff.start.astimezone(zone_of(zone)).date():
                add('FAIL','HTML_CUTOFF_MISMATCH','Visible full cutoff date differs from ledger.cutoff','cutoff',line=node.line)
        except (ValueError,UnknownTime):
            add('FAIL','HTML_CUTOFF_INVALID','Invalid visible cutoff date; correct it from documented metadata','cutoff',line=node.line)
    claims=ledger.get('claims') if isinstance(ledger.get('claims'),list) else []
    for ci,c in enumerate(claims):
        if not isinstance(c,dict):continue
        cid=c.get('id'); sources=c.get('sources') if isinstance(c.get('sources'),list) else []
        for si,s in enumerate(sources):
            if not isinstance(s,dict):continue
            loc={'claim_id':cid,'source_index':si,'url':s.get('url'),'json_path':f'claims[{ci}].sources[{si}]'}
            pub=read(s.get('publication_date'),'publication_date',**loc)
            checked=read(s.get('date_checked'),'date_checked',**loc)
            if s.get('access_status') in ('opened','blocked'):
                not_future(checked,'date_checked',**loc)
            if s.get('access_status')=='opened':
                not_before(checked,pub,'CHECK_BEFORE_PUBLICATION','date_checked',**loc)
                if generated and checked and checked.start>=generated.end:
                    if isinstance(s.get('recheck_reason'),str) and s['recheck_reason'].strip():
                        add('PASS','POST_REPORT_RECHECK','Historical recheck explicitly documented; does not rewrite the original cutoff','date_checked',**loc)
                    else:
                        add('UNVERIFIED','CHECK_AFTER_GENERATION',f'{checked.raw} is later than the original report; document recheck_reason or correct generation metadata','date_checked',**loc)
            if pub and cutoff:
                if pub.start>=cutoff.end:
                    add('UNVERIFIED','PUBLICATION_AFTER_CUTOFF',f'{pub.raw} postdates the information cutoff; justify as a later corroboration or update cutoff and re-review','publication_date',**loc)
                elif cutoff.precision=='timestamp' and pub.end>cutoff.start and not (pub.precision=='timestamp' and pub.start==cutoff.start and pub.end==cutoff.end):
                    add('UNVERIFIED','CUTOFF_ELIGIBILITY_AMBIGUOUS','Publication overlaps the exact cutoff at available precision; supply a precise source timestamp or review eligibility','publication_date',**loc)
            # Future events are deliberately not compared to runtime/publication.
    if isinstance(review,dict):
        reviewed=read(review.get('date_checked'),'review.date_checked')
        not_future(reviewed,'review.date_checked')
        signoff=review.get('signoff')
        if isinstance(signoff,dict):
            signed=read(signoff.get('date'),'review.signoff.date')
            not_future(signed,'review.signoff.date')
            not_before(signed,reviewed,'SIGNOFF_BEFORE_REVIEW','review.signoff.date')
    items.append(finding('PASS','DATE_SCAN_COMPLETE','Cross-field date scan completed; future event_date is allowed, unknown precision is not manufactured',runtime=clock.isoformat(),timezone=zone or 'UTC (legacy date-only convention)'))
    return items
