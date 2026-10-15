"""Shared QA results; HTTP reachability never proves factual support."""
import json
from pathlib import Path


def finding(status, code, message, **details):
    return dict(status=status, code=code, message=message, **details)


def outcome(items):
    if any(x['status'] == 'FAIL' for x in items):
        return 'FAIL'
    if any(x['status'] == 'UNVERIFIED' for x in items):
        return 'UNVERIFIED'
    return 'PASS'


def exit_code(items):
    return {'PASS': 0, 'FAIL': 1, 'UNVERIFIED': 2}[outcome(items)]


# Every non-PASS finding falls into one of these groups, so a reader (or a model fixing
# the run) can tell a broken report from a sound one that is waiting for a person.
# FAIL is always a rule violation. Unknown UNVERIFIED codes default to human review.
CATEGORIES = {
    'author_fix': ('作者可立即修正', 'FIRST_USE DATE_MISSING REPETITION CAVEATS LEGEND_MISSING FIGURE_MULTIPLE_LABELS '
                   'KIND_UNDERSTATED SOURCE_TYPE_MISMATCH CLAIM_UNREFERENCED COVERAGE_UNLINKED EXCLUSION_REASON '
                   'COVERAGE_OUT_OF_WINDOW DATE_ORDER_AMBIGUOUS CUTOFF_ELIGIBILITY_AMBIGUOUS'),
    'evidence_gap': ('证据缺失或不足', 'SOURCE_MISSING SUPPORT_MISSING PRIMARY_LEGAL_SOURCE DATE_UNKNOWN COVERAGE_THIN '
                     'ONE_SIDED_SWEEP CASE_NOT_FOLLOWED QUOTE_UNCHECKED QUOTE_CHECK_SKIPPED PUBLICATION_AFTER_CUTOFF '
                     'SYNTHETIC_FIXTURE REVIEW_SUPPORT_MISSING COVERAGE_SWEEP_MISSING'),
    'source_access': ('来源无法自动访问（不代表来源错误）', 'UNCHECKED BLOCKED NETWORK_ERROR BROKEN QUOTE_UNCHECKABLE'),
    'human_review': ('需人工判断', 'CLAIM_REVIEW_PENDING NUMBER_NOT_IN_QUOTE UNMARKED_RISK_CLAIM SNAPSHOT_LIVE_DIFFER '
                     'CLAIM_DATE_REVIEW_PENDING CHECK_AFTER_GENERATION'),
    'signoff': ('等待最终人工签核', 'HUMAN_SIGNOFF INDEPENDENT_REVIEW_MISSING COVERAGE_REVIEW SIGNOFF_INCOMPLETE'),
}
_CODE_CATEGORY = {code: cat for cat, (_, codes) in CATEGORIES.items() for code in codes.split()}
CATEGORY_LABEL = {'rule_violation': '规则违反（必须修正）', **{k: v[0] for k, v in CATEGORIES.items()}}

# One line per code: what the writer should do next. Shown with the finding's location.
FIXES = {
    'LEDGER_MISSING': 'Create evidence_ledger.json and record every [[Cxxx]] claim with its source and verbatim quote.',
    'COVERAGE_SWEEP_MISSING': 'Create coverage.json and record every candidate event and every active case with a decision.',
    'SECTION_MISSING': 'Add the missing section, copied from assets/template.html.',
    'STATUS_LABELS_MISSING': 'Mark each story with one template status label (class "st confirmed|reported|pending").',
    'VERIFIED_WORDING': 'Remove "已验证/已核实/verified". Use the legend labels: 官方或公司正式公告 / 媒体报道或未经独立验证 / 拟议、待审批或待生效.',
    'FIRST_USE': 'Explain this term at its first visible use, e.g. "美国商务部工业与安全局（BIS）".',
    'DATE_MISSING': 'Put the full report date in the masthead, issue line and footer.',
    'SOURCE_TYPE_MISMATCH': 'Fix evidence_type: government sites = official_document; company newsroom/IR = company_statement; news sites = news.',
    'NUMBER_NOT_IN_QUOTE': 'Extend the quote so it contains each number in the claim (or fix the number). A person will otherwise check it.',
    'KIND_UNDERSTATED': 'Add "legal", "list" or "negative" to the claim kinds; the wording makes a legal/list/negative statement.',
    'SUPPORT_MISSING': 'Open the source and copy a verbatim quote, or keep the claim as 据报 with access_status "blocked" and say so in the report.',
    'SOURCE_MISSING': 'Add at least one source you actually opened, or remove the claim.',
    'PRIMARY_LEGAL_SOURCE': 'Add the official instrument or list record (Federal Register, court filing, ministry notice) as a primary source. If it cannot be obtained, keep the claim worded as 据报, say in the report that the original was not obtained, and leave this for the reviewer.',
    'CASE_NOT_FOLLOWED': 'Add a coverage.json entry with this case_id and a decision (included/background/excluded + reason), even when nothing changed.',
    'COVERAGE_THIN': 'Record more candidate events you considered, including ones you excluded, from at least three kinds of sources.',
    'ONE_SIDED_SWEEP': 'Search the missing side (US or China) and record what you found or why nothing qualified.',
    'EXCLUSION_REASON': 'Give a one-line reason for every candidate that is not included.',
    'COVERAGE_UNLINKED': 'List the ledger claim_ids that support this included event.',
    'CLAIM_UNREFERENCED': 'Use this claim in the report as [[Cxxx]] or delete it from the ledger.',
    'QUOTE_UNCHECKED': 'Save a snapshot for each opened source (scripts/save_snapshot.py) so quotes can be checked offline.',
    'QUOTE_NOT_FOUND': 'Copy the quote verbatim from the saved page text; never retype or translate it.',
    'CLAIM_TEXT_MISMATCH': 'Make the HTML claim text identical to the ledger text.',
    'SOURCE_NOT_LINKED': 'Every ledger source URL must appear as a link in the report.',
    'UNMARKED_RISK_CLAIM': 'If this sentence states a fact, give it a ledger claim; if it is analysis, phrase it as analysis.',
    'UNCHECKED': 'Not a defect: links were not fetched (offline). A person opens them during review.',
    'BLOCKED': 'Not proof the source is wrong: the site refused automated access. Use a browser copy or an alternative source.',
}


def category(x):
    if x['status'] == 'FAIL':
        return 'rule_violation'
    return _CODE_CATEGORY.get(x['code'], 'human_review')


def readiness(items):
    """One verdict that separates broken, incomplete, reviewable and signed-off runs."""
    cats = {category(x) for x in items if x['status'] != 'PASS'}
    if 'rule_violation' in cats:
        return 'BLOCKED', '存在规则违反，修正后重新运行'
    if cats & {'author_fix', 'evidence_gap'}:
        return 'INCOMPLETE', '无规则违反，但仍有作者可修正项或证据缺口'
    if cats & {'source_access', 'human_review'}:
        return 'READY_FOR_HUMAN_REVIEW', '可交人工复核：只剩来源访问受限项和需人工判断的事项'
    if cats:
        return 'AWAITING_SIGNOFF', '只等待最终人工签核'
    return 'PASS', '所执行的检查全部通过（不等于事实已核验）'


def fix_lines(items, limit=None):
    """Ordered, de-duplicated 'what to do next' lines for non-PASS findings."""
    order = ['rule_violation', 'author_fix', 'evidence_gap', 'source_access', 'human_review', 'signoff']
    first = ['LEDGER_MISSING', 'COVERAGE_SWEEP_MISSING', 'SECTION_MISSING', 'CASE_NOT_FOLLOWED']  # missing whole steps first
    rank = lambda x: (order.index(category(x)), first.index(x['code']) if x['code'] in first else len(first))
    rows, seen = [], set()
    for x in sorted((x for x in items if x['status'] != 'PASS'), key=rank):
        where = x.get('claim_id') or x.get('term') or x.get('url') or x.get('field') or ''
        excerpt = ' '.join(str(x['excerpt']).split()) if x.get('excerpt') else None
        key = (x['code'], where, excerpt)
        if key in seen:
            continue
        seen.add(key)
        fix = FIXES.get(x['code'], x['message'])
        detail = x['message'] if fix != x['message'] else ''
        rows.append((category(x), x['status'], x['code'], where, excerpt, detail, fix))
    return rows[:limit] if limit else rows


def emit(items, json_path=None):
    for x in items:
        location=(x['json_path']+'.'+x['field'] if x.get('json_path') else x.get('field')) or x.get('claim_id') or x.get('url') or ('line '+str(x['line']) if 'line' in x else '')
        suffix=f" [{location}]" if location else ''
        print(f"{x['status']:10} {x['code']}{suffix}: {x['message']}")
    print(f"Outcome: {outcome(items)} (PASS is scoped to the checks performed)")
    if json_path:
        Path(json_path).write_text(json.dumps(items, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
