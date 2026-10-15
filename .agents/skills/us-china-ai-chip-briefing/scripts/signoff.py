#!/usr/bin/env python3
"""Plain-Markdown human sign-off.

validate.py writes `signoff.md` listing only the high-risk claims, ranked, with each
claim's source, excerpt and the reasons it was flagged. The reviewer ticks one box per
claim and fills in name, date and decision. validate.py --signoff signoff.md reads it
back into the independent-review format. File fingerprints are written by the script,
never typed by a person; editing the report or ledger afterwards makes the form stale.
"""
import re

BOX = {'支持': 'supported', '不支持': 'unsupported', '未能确认': 'unverified'}
DECISIONS = {'approve': 'approve', 'hold': 'hold', 'reject': 'reject',
             '批准': 'approve', '暂缓': 'hold', '退回': 'reject'}


def first_quoted_source(c):
    for s in c.get('sources') or []:
        if isinstance(s, dict) and s.get('access_status') == 'opened' and (s.get('quote') or '').strip():
            return s
    return None


def render_signoff(ledger, risk, report_sha, ledger_sha, coverage_excluded=None, limit=None):
    claims = {c['id']: c for c in (ledger or {}).get('claims', []) if isinstance(c, dict) and isinstance(c.get('id'), str)}
    high = sorted((cid for cid, r in risk.items() if r['tier'] == 'high' and cid in claims),
                  key=lambda cid: -risk[cid]['score'])
    if limit:
        high = high[:limit]
    low = [cid for cid, r in risk.items() if r['tier'] == 'low']
    auto = [cid for cid in low if risk[cid]['quote_state'] == 'FOUND']
    out = ['# 人工签核单', '',
           '只需检查下面列出的高风险事项。对每项打开来源，确认摘录确实在原文中、并且足以支持报告中的说法，然后在一个方框里打 x。',
           '低风险事项若已自动找到原文摘录则不需人工确认。改动报告或台账后须重新生成本表。', '',
           f'report_sha256: {report_sha}', f'ledger_sha256: {ledger_sha}',
           'reviewer: ', 'date: ', 'decision: hold        # approve / hold / reject',
           'coverage_checked: no  # 浏览过未列入事件清单并扫过报告中未标 claim ID 的事实后改为 yes', '',
           f'自动通过的低风险事项：{len(auto)} 项；未能自动确认的低风险事项：{len(low) - len(auto)} 项（见 review_report.md）。', '',
           f'## 需人工确认的高风险事项（{len(high)} 项，按风险排序）', '']
    for cid in high:
        c, r = claims[cid], risk[cid]
        s = first_quoted_source(c)
        out += [f"### {cid} — {c.get('text', '')}",
                f"- 类型：{', '.join(c.get('kinds') or [])}；风险分 {r['score']}；原因：{', '.join(r['reasons']) or '—'}；摘录自动核对：{r['quote_state']}"]
        if s:
            out += [f"- 来源：{s.get('url')}（{s.get('source_role')} / {s.get('evidence_type')}）",
                    f"- 摘录：“{s.get('quote')}”（定位：{s.get('anchor')}）"]
        else:
            out.append('- 来源：无已打开的摘录，需人工查找')
        out += [f"- 作者注明的不确定性：{c.get('uncertainty') or '无'}",
                '- 结论：[ ] 支持  [ ] 不支持  [ ] 未能确认',
                '- 备注：', '']
    if coverage_excluded:
        out += ['## 未列入的候选事件（请快速浏览是否遗漏重大事件）', '']
        for c in coverage_excluded:
            out.append(f"- {c.get('date', '?')} [{c.get('side', '?')}] {c.get('event')} — {c.get('decision')}：{c.get('reason', '未写理由')}")
        out.append('')
    return '\n'.join(out)


def parse_signoff(text, ledger):
    """Return a review dict in the independent-review v1 format."""
    def header(key):
        m = re.search(rf'^{key}:[ \t]*([^\n#]*)', text, re.M)
        return m[1].strip() if m else ''
    claims = {c['id']: c for c in (ledger or {}).get('claims', []) if isinstance(c, dict) and isinstance(c.get('id'), str)}
    reviews = []
    for block in re.split(r'^### ', text, flags=re.M)[1:]:
        cid = block.split(' ', 1)[0].strip()
        m = re.search(r'结论：(.*)', block)
        # "[x] 支持" cannot match "[x] 不支持" because 不 sits between the box and the word
        ticked = [BOX[w] for w in BOX if m and re.search(r'\[[xX✓]\]\s*' + re.escape(w) + r'(?=\s|$)', m[1])]
        note = re.search(r'备注：(.*)', block)
        note = note[1].strip() if note else ''
        if len(ticked) != 1:
            disposition = 'unverified'
            note = note or '未勾选或勾选多项'
        else:
            disposition = ticked[0]
        s = first_quoted_source(claims.get(cid, {})) or {}
        reviews.append({'claim_id': cid, 'disposition': disposition,
                        'source_url': s.get('url', ''), 'support_quote': s.get('quote', ''),
                        'anchor': s.get('anchor', ''),
                        'rationale': note or ('人工打开来源确认摘录支持该陈述' if disposition == 'supported' else '人工未能确认')})
    reviewer = header('reviewer')
    day = header('date')
    decision = DECISIONS.get(header('decision').lower(), 'hold')
    return {'schema_version': 1, 'reviewer': reviewer, 'actor': 'human', 'date_checked': day,
            'report_sha256': header('report_sha256'), 'ledger_sha256': header('ledger_sha256'),
            'coverage': {'complete': header('coverage_checked').lower() in ('yes', 'y', '是'),
                         'notes': 'signoff.md coverage check'},
            'claims': reviews,
            'signoff': {'reviewer': reviewer, 'date': day, 'decision': decision}}
