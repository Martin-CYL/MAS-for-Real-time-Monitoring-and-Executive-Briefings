#!/usr/bin/env python3
"""One command for mechanical QA, optional HTTP checks, evidence QA and review report."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import json
import os
from pathlib import Path
from check_report import validate_report
from check_links import validate_links
from check_evidence import validate_evidence, load_object, sha256
from check_dates import parse_runtime
from check_quotes import validate_quotes
from check_coverage import validate_coverage, excluded_summary
from signoff import render_signoff, parse_signoff
from qa_common import finding, outcome, exit_code, readiness, category, fix_lines, CATEGORY_LABEL

SKILL=Path(__file__).resolve().parents[1]


def cell(value):
    return str(value).replace('|','\\|').replace('\n',' ').replace('\r',' ')


def render_review(result, ledger=None):
    lines=['# 质量检查与人工签核报告', '',
           f"- 生成时间（UTC）：{result['generated_at']}",
           f"- 总体状态：**{result['outcome']}**；不等于事实全部核验。",
           f"- HTML SHA-256：`{result['report_sha256']}`",
           f"- 台账 SHA-256：`{result.get('ledger_sha256') or '未提供'}`",
           f"- 校验时钟：{result['validation_clock']}（{result['clock_mode']}）",
           f"- 网络请求：{ {'mock': '本地模拟，未访问公共网络', 'public-http': '公共 HTTP 检查已开启', 'offline': '未执行（离线模式）'}[result['network_mode']] }",
           '- 本报告为 QA 工件，不得复制进管理层简报正文。', '',
           '| 检查层 | 结果 | PASS | FAIL | UNVERIFIED |', '|---|---|---:|---:|---:|']
    for name,items in result['checks'].items():
        c=Counter(x['status'] for x in items)
        lines.append(f"| {name} | {outcome(items)} | {c['PASS']} | {c['FAIL']} | {c['UNVERIFIED']} |")
    allx=[x for xs in result['checks'].values() for x in xs]
    verdict,meaning=readiness(allx)
    cats=Counter(category(x) for x in allx if x['status']!='PASS')
    lines+=['',f'## 就绪状态：{verdict}','',f'{meaning}。','',
            '| 类别 | 数量 |','|---|---:|']
    for key,label in CATEGORY_LABEL.items():
        lines.append(f'| {label} | {cats.get(key,0)} |')
    lines+=['','## 下一步：按顺序处理','','| # | 类别 | 代码 | 定位 | 涉及文字 | 怎么做 |','|---:|---|---|---|---|---|']
    for i,(cat,_,code,where,excerpt,detail,fix) in enumerate(fix_lines(allx),1):
        lines.append(f"| {i} | {CATEGORY_LABEL[cat]} | {code} | {cell(where or '—')} | {cell(excerpt or '—')} | {cell(fix + (' （' + detail + '）' if detail else ''))} |")
    lines+=['','## 可执行发现','','| 状态 | 检查代码 | 定位 | 说明 |','|---|---|---|---|']
    for items in result['checks'].values():
        for x in items:
            where=(x['json_path']+'.'+x['field'] if x.get('json_path') else x.get('field')) or x.get('claim_id') or ('line '+str(x['line']) if 'line' in x else x.get('url','—'))
            msg=x['message']+(f"（文字：{x['excerpt']}）" if x.get('excerpt') else '')
            lines.append(f"| {x['status']} | {x['code']} | {cell(where)} | {cell(msg)} |")
    lines+=['','## 来源访问清单','','| 类别 | 目标 HTTP | 代理 HTTP | URL |','|---|---|---|---|']
    for x in result['checks']['links']:
        if x.get('url'):
            lines.append(f"| {x['code']} | {x.get('http_status') or '—'} | {x.get('proxy_http_status') or '—'} | {cell(x['url'])} |")
    route_label={'http_tool':'自动抓取','api':'官方 API','browser':'浏览器阅读后保存','reprint':'官方转载'}
    src_rows=[(c.get('id'),s) for c in ((ledger or {}).get('claims') or []) if isinstance(c,dict)
              for s in (c.get('sources') or []) if isinstance(s,dict)]
    if src_rows:
        lines+=['','## 证据取得方式（自动核对 / 浏览器 / 未能打开 分开列示）','',
                '浏览器阅读与自动抓取同样只证明“作者看到了这段文字”；高风险 claim 无论哪种方式都须人工复核。','',
                '| Claim | 取得方式 | 访问状态 | 快照 | 摘录自动核对 | URL |','|---|---|---|---|---|---|']
        for cid,s in src_rows:
            state=(result.get('risk') or {}).get(cid,{}).get('quote_state','—')
            lines.append(f"| {cid} | {route_label.get(s.get('access_route'),'未记录')} | {s.get('access_status','?')} | "
                         f"{'有' if s.get('snapshot') else '无'} | {state} | {cell(s.get('url','缺失'))} |")
    lines+=['','## 优先人工签核项','',
            '审核者重新打开来源并读相关段落，不能仅依赖作者的 supported 标签。优先检查以下事项；约十分钟是目标，不是时长保证。', '']
    claims=(ledger or {}).get('claims',[])
    claims=claims if isinstance(claims,list) else []
    risk=result.get('risk') or {}
    byid={c.get('id'):c for c in claims if isinstance(c,dict)}
    high=[byid[cid] for cid,r in sorted(risk.items(),key=lambda kv:-kv[1]['score']) if r['tier']=='high' and cid in byid]
    for c in high:
        r=risk[c['id']]
        lines.append(f"- **{c['id']}** 风险分 {r['score']}（{', '.join(r['reasons'])}；摘录核对 {r['quote_state']}） {c.get('text','')}")
        for s in (c.get('sources') if isinstance(c.get('sources'),list) else []):
            if isinstance(s,dict):
                lines.append(f"  - 来源：{s.get('url','缺失')}；{s.get('source_role','?')} / {s.get('evidence_type','?')}；访问 {s.get('access_status','?')}；核查 {s.get('date_checked','?')}；定位 {s.get('anchor','缺失')}")
        lines.append(f"  - 不确定性：{c.get('uncertainty') or '作者未写明；审核者仍须挑战'}")
    if not high:
        lines.append('- 未能自动列出高风险 claim；人工核对全文和台账覆盖，不能据此认为没有高风险事实。')
    excl=result.get('excluded') or []
    if excl:
        lines+=['','## 未列入报告的候选事件（快速浏览是否遗漏重大事件）','']
        for c in excl:
            lines.append(f"- {c.get('date','?')} [{c.get('side','?')}] {c.get('event')} — {c.get('decision')}：{c.get('reason','未写理由')}")
    lines+=['','- [ ] 法律：原始文件、管辖范围、发布／生效／拟议状态、期限及例外是否匹配？',
            '- [ ] 名单／负面断言：准确名称与别名、具体名单版本、查询范围、查询日期和可复现的检索记录是否足够？',
            '- [ ] 统计：单位、期间、币种、分母、可比口径和计算是否一致？',
            '- [ ] 争议与企业回应：作者是否遗漏不同意见、回应日期或诉讼／审批的新状态？',
            '- [ ] 技术：实测、公司宣称和推断是否分开，关键进展是否因缺乏直接银行风险联系而漏选？',
            '- [ ] 全文：包括未加 claim ID 的事实；状态标签、解释、双边背景、重复表达及移动／打印布局是否妥当？',
            '- [ ] 逐项处置全部 FAIL 与 UNVERIFIED，确定批准／暂缓／退回。', '',
            '人工签核：姓名 ______ 日期 ______ 决定（批准／暂缓／退回）______',
            '来源复核与异议：______；未解决项和理由：______', '',
            '机器不会证明引用真实或足以支持法律结论。哈希只防止意外沿用旧记录，不验证签名人身份。',
            '记录数字签核时使用 references/evidence-ledger.md 中的 review 格式；修改 HTML 或台账后重新审核。','']
    return '\n'.join(lines)


def run_all(html_path,ledger_path=None,review_path=None,expected_date=None,glossary=None,network=False,timeout=10,opener=None,
        coverage_path=None,signoff_path=None,cases_path=None,resolver=None,transport=None,now=None):
    raw=Path(html_path).read_bytes().decode('utf-8')
    ledger=load_object(ledger_path) if ledger_path else None
    review=load_object(review_path) if review_path else None
    ledger_bytes=Path(ledger_path).read_bytes() if ledger_path else None
    coverage=load_object(coverage_path) if coverage_path else None
    report_sha=sha256(raw.encode('utf-8')); ledger_sha=sha256(ledger_bytes) if ledger_bytes else None
    extra=[]
    if signoff_path and not review:
        parsed=parse_signoff(Path(signoff_path).read_text(encoding='utf-8'),ledger)
        if not parsed['reviewer'] or not parsed['date_checked']:
            extra.append(finding('UNVERIFIED','SIGNOFF_INCOMPLETE','signoff.md has no reviewer name or date yet'))
        else:
            review=parsed
    ledger_dir=Path(ledger_path).resolve().parent if ledger_path else None
    quote_items,risk=validate_quotes(ledger,network,timeout,opener,ledger_dir=ledger_dir,resolver=resolver,transport=transport) if ledger else ([],{})
    cases=cases_path if cases_path is not None else SKILL/'references'/'active_cases.md'
    checks={'report':validate_report(raw,expected_date,glossary),
            'links':validate_links(raw,network,timeout,opener=opener,resolver=resolver,transport=transport),
            'quotes':quote_items,
            'evidence':validate_evidence(raw,ledger,review,ledger_bytes,now=now,risk=risk)+extra,
            'coverage':validate_coverage(coverage,ledger,cases)}
    result={'schema_version':1,'generated_at':datetime.now(timezone.utc).isoformat(),
            'report_sha256':report_sha,'ledger_sha256':ledger_sha,
            'validation_clock':parse_runtime(now).isoformat(),'clock_mode':'injected fixture/test clock' if now is not None else 'runtime',
            'network':network,'network_mode':'mock' if network and (opener is not None or transport is not None) else 'public-http' if network else 'offline','checks':checks,
            'risk':risk,'excluded':excluded_summary(coverage),
            'outcome':outcome([x for xs in checks.values() for x in xs])}
    allx=[x for xs in checks.values() for x in xs]
    result['readiness']=readiness(allx)[0]
    result['categories']=dict(Counter(category(x) for x in allx if x['status']!='PASS'))
    signoff_md=render_signoff(ledger,risk,report_sha,ledger_sha,excluded_summary(coverage)) if ledger else None
    return result,render_review(result,ledger),signoff_md


def run(*args,**kwargs):
    """Backwards-compatible: (result, review_markdown)."""
    result,md,_=run_all(*args,**kwargs)
    return result,md


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('html'); ap.add_argument('--ledger'); ap.add_argument('--review'); ap.add_argument('--date'); ap.add_argument('--glossary')
    ap.add_argument('--coverage'); ap.add_argument('--signoff'); ap.add_argument('--cases')
    ap.add_argument('--network',action='store_true')
    ap.add_argument('--strict-network',action='store_true',help='Refuse fetching through a proxy (no DNS pinning possible). Default: proxy allowed, literal private targets still blocked')
    ap.add_argument('--as-of',help='Fixture-only timezone-aware clock for reproducible examples'); ap.add_argument('--timeout',type=float,default=10)
    ap.add_argument('--output-dir',default='qa-output')
    args=ap.parse_args()
    try:
        if args.as_of and (not args.ledger or load_object(args.ledger).get('fixture') is not True):
            raise ValueError('Clock override is fixture-only')
        if args.strict_network:
            os.environ['BRIEFING_PROXY_POLICY']='refuse'
        result,markdown,signoff_md=run_all(args.html,args.ledger,args.review,args.date,args.glossary,args.network,args.timeout,
                                    coverage_path=args.coverage,signoff_path=args.signoff,cases_path=args.cases,now=args.as_of)
    except (OSError,ValueError) as e:
        print(f'FAIL INPUT_ERROR: {type(e).__name__}; input unreadable or invalid JSON')
        return 1
    out=Path(args.output_dir); out.mkdir(parents=True,exist_ok=True)
    (out/'review_report.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    (out/'review_report.md').write_text(markdown,encoding='utf-8')
    if signoff_md and not args.signoff:
        (out/'signoff.md').write_text(signoff_md,encoding='utf-8')
        print(f'Sign-off form for the reviewer: {out / "signoff.md"}')
    for name,items in result['checks'].items():
        print(f'{name}: {outcome(items)} ({dict(Counter(x["status"] for x in items))})')
    allx=[x for xs in result['checks'].values() for x in xs]
    print(f'Overall: {result["outcome"]}; review report: {out / "review_report.md"}')
    print_next_steps(allx)
    return exit_code(allx)


def print_next_steps(items, limit=12):
    """What a person or model reads first: the verdict and the next concrete fixes."""
    verdict,meaning=readiness(items)
    cats=Counter(category(x) for x in items if x['status']!='PASS')
    print(f'READINESS: {verdict} — {meaning}')
    print('  '+'; '.join(f'{CATEGORY_LABEL[k]} {cats[k]}' for k in CATEGORY_LABEL if cats.get(k)))
    rows=fix_lines(items)
    actionable=[r for r in rows if r[0] in ('rule_violation','author_fix','evidence_gap')]
    for i,(cat,_,code,where,excerpt,detail,fix) in enumerate(actionable[:limit],1):
        loc=f' [{where}]' if where else ''
        txt=f' “{excerpt}”' if excerpt else ''
        print(f'FIX {i}: {code}{loc}{txt} → {fix}' + (f' ({detail})' if detail else ''))
    if len(actionable)>limit:
        print(f'… {len(actionable)-limit} more in review_report.md')


if __name__=='__main__':
    raise SystemExit(main())
