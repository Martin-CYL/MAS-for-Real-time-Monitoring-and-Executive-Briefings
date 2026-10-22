"""Multi-agent support: English rendering, task-record merging, handoff and provenance checks, role files.

Synthetic .invalid / example sources and fictitious content only. Nothing here fetches a page.
"""
import io
import json
from contextlib import redirect_stdout
from pathlib import Path
import re
import sys
import tempfile
import unittest

SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL / 'scripts'))
import brief  # noqa: E402
import check_handoff  # noqa: E402
import check_provenance  # noqa: E402
import merge_runs  # noqa: E402
import evidence_tools as ev  # noqa: E402
from check_report import validate_report  # noqa: E402
from validate import run_all  # noqa: E402

WINDOW = ('--end', '2030-03-10', '--cutoff', '2030-03-10T18:00:00+08:00')
RULE = 'The Synthetic Agency today issued a proposed rule on synthetic accelerators. Comments are due by April 9, 2030.'
REPORT = 'Synthetic Daily reported that Synthetic Foundry halted shipments of synthetic wafers to a synthetic buyer on March 6, 2030.'
codes = lambda items: {x['code'] for x in items}


def call(*args):
    out, old = io.StringIO(), sys.argv
    sys.argv = ['brief.py', *map(str, args)]
    try:
        with redirect_stdout(out):
            code = brief.main()
    finally:
        sys.argv = old
    return code, out.getvalue()


def jload(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def jsave(path, obj):
    Path(path).write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding='utf-8')


class Runs:
    """A temporary multi-agent run root with helpers to build task runs the way agents would."""

    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'run'
        call('init', self.root, *WINDOW, '--lang', 'en', '--no-cases')

    def task(self, name):
        run = self.root / 'tasks' / name
        call('init', run, *WINDOW, '--lang', 'en', '--no-cases')
        cfg = jload(run / 'run_config.json')
        jsave(run / 'assignment.json', {'task_id': name, 'window': cfg['window'], 'cutoff': cfg['cutoff']})
        return run

    def page(self, text, name):
        p = Path(self.tmp.name) / name
        p.write_text(text, encoding='utf-8')
        return p

    def event(self, run, url, text, title, quote, claim, side='us', decision='include', proposed=False, date='2030-03-06'):
        call('fetch', run, url, '--file', self.page(text, f'{abs(hash((str(run), url)))}.txt'), '--route', 'http_tool')
        sid = jload(run / 'sources.json')['sources'][-1]['id']
        call('event', run, 'add', '--title', title, '--date', date, '--side', side, '--source', sid,
             '--materiality', 'high', '--why', 'Synthetic link to US-China chip competition')
        eid = jload(run / 'events.json')['events'][-1]['id']
        flags = ['--proposed'] if proposed else []
        call('event', run, 'decide', eid, decision, '--reason', 'Synthetic: material in the window', *flags,
             '--link', 'Synthetic export-control link', '--size', 'Changes synthetic rules', '--new', 'Issued in the window')
        code, out = call('add-claim', run, eid, sid, '--quote', quote, '--text', claim)
        assert code == 0, out
        return eid

    def rule(self, run, **kw):
        return self.event(run, 'https://www.example.gov/rule', RULE, 'Synthetic agency proposes accelerator rule',
                          'today issued a proposed rule on synthetic accelerators',
                          'The Synthetic Agency issued a proposed rule on synthetic accelerators.', proposed=True, **kw)

    def news(self, run, **kw):
        return self.event(run, 'https://www.reuters.com/synthetic', REPORT, 'Synthetic foundry halts wafer shipments',
                          'halted shipments of synthetic wafers', 'According to Reuters, Synthetic Foundry halted shipments of synthetic wafers.',
                          side='cn', **kw)

    def narrative(self, run, extra=''):
        ids = ' '.join(e['id'] for e in jload(run / 'events.json')['events'])
        (run / 'narrative.md').write_text(f'Synthetic analysis covering {ids}. ' + 'It explains why the developments matter. ' * 4 + extra,
                                          encoding='utf-8')

    def report_json(self, run, eid):
        rep = jload(run / 'report.json')
        rep.update(thesis={'lead': 'A synthetic rule is proposed', 'emphasis': 'chip supply terms may tighten'},
                   deck='Synthetic deck sentence.', management_view='Synthetic evidence that would change the view.',
                   questions=['Question one?', 'Question two?', 'Question three?'],
                   judgments=[{'title': f'Judgment {i}', 'text': f'Synthetic judgment text {i}.'} for i in range(1, 4)],
                   stories=[{'event': eid, 'chapter': 'Policy', 'title': 'Synthetic rule', 'impact': 'Synthetic impact on BIS licensing.',
                             'watch': 'April 9, 2030'}])
        jsave(run / 'report.json', rep)

    def close(self):
        self.tmp.cleanup()


class EnglishRenderTests(unittest.TestCase):
    def setUp(self):
        self.r = Runs()

    def tearDown(self):
        self.r.close()

    def build(self):
        run = self.r.root
        eid = self.r.rule(run)
        self.r.news(run, decision='track')
        for q in ('q1', 'q2', 'q3'):
            call('search', run, q)
        self.r.report_json(run, eid)
        led = jload(run / 'evidence_ledger.json'); led['generated_at'] = '2030-03-10T19:00:00+08:00'; jsave(run / 'evidence_ledger.json', led)
        code, out = call('build', run)
        return (run / 'report.html').read_text(encoding='utf-8'), out

    def test_english_report_passes_report_checks(self):
        html, out = self.build()
        self.assertIn('<html lang="en">', html)
        self.assertIn('Data as of March 10, 2030 18:00', html)
        self.assertIn('class="st pending">Proposed, pending approval or not yet in force', html)
        self.assertNotRegex(re.sub(r'<style>.*?</style>', '', html, flags=re.S), r'[一-鿿]')
        r = validate_report(html, '2030-03-10', SKILL / 'references' / 'glossary.md')
        self.assertFalse([x for x in r if x['status'] == 'FAIL'], r)
        self.assertNotIn('FIRST_USE', codes(r))
        result, _, _ = run_all(self.r.root / 'report.html', self.r.root / 'report_ledger.json', expected_date='2030-03-10',
                               coverage_path=self.r.root / 'coverage.json', cases_path='', now='2030-03-11T00:00:00+00:00')
        fails = [x for xs in result['checks'].values() for x in xs if x['status'] == 'FAIL']
        self.assertFalse(fails, fails)

    def test_english_labels_follow_the_template(self):
        template = (SKILL / 'assets' / 'template.html').read_text(encoding='utf-8')
        L = brief.LABELS['en']
        for key in ('brand', 'tags', 'readpath', 'questions', 'public_only', 'judgments', 'panel', 'panel_title', 'key',
                    'closing', 'closing_title', 'view', 'disclaimer', 'glossary', 'footer'):
            self.assertIn(L[key].replace('&amp;', '&'), template.replace('&amp;', '&'), key)
        for label in L['status'].values():
            self.assertIn(label, template)

    def test_english_titles_required_for_shown_events(self):
        run = self.r.root
        eid = self.r.rule(run)
        call('event', run, 'decide', eid, 'include', '--reason', 'x', '--title', '合成规则')
        self.assertIn('short English title', ''.join(p for _, p in brief.problems(run)))


class RecordToolTests(unittest.TestCase):
    def setUp(self):
        self.r = Runs()

    def tearDown(self):
        self.r.close()

    def test_assessment_is_recorded_and_withdraw_keeps_the_claim(self):
        run = self.r.task('scout')
        eid = self.r.rule(run)
        e = jload(run / 'events.json')['events'][0]
        self.assertEqual(set(e['assessment']), {'link', 'size', 'new'})
        code, out = call('withdraw', run, 'C001', '--reason', 'Synthetic: wrong legal state')
        self.assertEqual(code, 0, out)
        led = jload(run / 'evidence_ledger.json')
        self.assertEqual(led['claims'], [])
        self.assertEqual(led['withdrawn'][0]['claim']['id'], 'C001')
        self.assertEqual(jload(run / 'events.json')['events'][0]['claim_ids'], [])
        # A new claim never reuses a withdrawn ID.
        call('add-claim', run, eid, 'S001', '--quote', 'Comments are due by April 9, 2030', '--text', 'Comments on the synthetic rule are due by April 9, 2030.')
        self.assertEqual(jload(run / 'evidence_ledger.json')['claims'][0]['id'], 'C002')


class MergeTests(unittest.TestCase):
    def setUp(self):
        self.r = Runs()
        self.lead = self.r.task('us-lead')
        self.a, self.b = self.r.task('scout-a'), self.r.task('scout-b')

    def tearDown(self):
        self.r.close()

    def test_merge_keeps_text_quotes_snapshots_and_provenance(self):
        self.r.rule(self.a)
        self.r.news(self.b)
        merge_runs.merge(self.lead, 'scout-a', self.a)
        merge_runs.merge(self.lead, 'scout-b', self.b)
        led = jload(self.lead / 'evidence_ledger.json')
        self.assertEqual([c['id'] for c in led['claims']], ['C001', 'C002'])
        src_claim = jload(self.b / 'evidence_ledger.json')['claims'][0]
        merged = led['claims'][1]
        self.assertEqual(merged['text'], src_claim['text'])
        self.assertEqual(merged['sources'][0]['quote'], src_claim['sources'][0]['quote'])
        self.assertEqual(merged['sources'][0]['snapshot']['path'], 'sources/S002.txt')
        self.assertEqual(merged['provenance'], [{'task': 'scout-b', 'id': 'C001'}])
        self.assertEqual(ev.hand_edited(led), [])
        _, _, _, risk, _ = brief.snapshot_state(self.lead)
        self.assertEqual({r['quote_state'] for r in risk.values()}, {'FOUND'})  # snapshots still match after the copy

    def test_duplicate_events_join_and_cautious_values_win(self):
        self.r.rule(self.a)
        self.r.rule(self.b)
        evs = jload(self.b / 'events.json'); evs['events'][0]['proposed'] = False; evs['events'][0]['materiality'] = 'medium'
        evs['events'][0]['decision'] = 'track'; jsave(self.b / 'events.json', evs)
        merge_runs.merge(self.lead, 'scout-a', self.a)
        out = merge_runs.merge(self.lead, 'scout-b', self.b)
        events = jload(self.lead / 'events.json')['events']
        self.assertEqual(len(events), 1)
        e = events[0]
        self.assertTrue(e['proposed'])
        self.assertEqual(e['materiality'], 'high')
        self.assertEqual(e['decision'], 'include')
        self.assertEqual([c['field'] for c in e['merge_conflicts']], ['decision'])
        self.assertEqual(len(e['provenance']), 2)
        self.assertEqual(len(jload(self.lead / 'evidence_ledger.json')['claims']), 1)  # same text: one claim, joined
        self.assertEqual(out['joined_events'], [{'event': 'E001', 'from': 'E001'}])
        handoff = check_handoff.check(self.lead, 'lead')
        self.assertIn('MERGE_CONFLICT', codes(handoff))
        call('event', self.lead, 'decide', 'E001', 'include', '--reason', 'Lead: proposed rule is material')
        self.assertNotIn('MERGE_CONFLICT', codes(check_handoff.check(self.lead, 'lead')))
        self.assertTrue(jload(self.lead / 'events.json')['events'][0]['resolved_conflicts'])

    def test_merge_is_idempotent_and_incremental(self):
        self.r.rule(self.a)
        merge_runs.merge(self.lead, 'scout-a', self.a)
        merge_runs.merge(self.lead, 'scout-a', self.a)
        self.assertEqual(len(jload(self.lead / 'events.json')['events']), 1)
        self.r.news(self.a)
        call('withdraw', self.a, 'C001', '--reason', 'Synthetic correction')
        merge_runs.merge(self.lead, 'scout-a', self.a)
        led = jload(self.lead / 'evidence_ledger.json')
        self.assertEqual([c['provenance'][0]['id'] for c in led['claims']], ['C002'])
        self.assertEqual(led['withdrawn'][0]['claim']['provenance'][0], {'task': 'scout-a', 'id': 'C001'})
        self.assertIn('withdrawn in scout-a', led['withdrawn'][0]['reason'])

    def test_task_change_propagates_but_local_override_is_a_conflict(self):
        self.r.rule(self.a)
        merge_runs.merge(self.lead, 'scout-a', self.a)
        call('event', self.a, 'decide', 'E001', 'track', '--reason', 'Scout: original not obtained')
        merge_runs.merge(self.lead, 'scout-a', self.a)
        self.assertEqual(jload(self.lead / 'events.json')['events'][0]['decision'], 'track')
        call('event', self.lead, 'decide', 'E001', 'include', '--reason', 'Lead keeps it')
        call('event', self.a, 'decide', 'E001', 'exclude', '--reason', 'Scout: irrelevant')
        merge_runs.merge(self.lead, 'scout-a', self.a)
        e = jload(self.lead / 'events.json')['events'][0]
        self.assertEqual(e['decision'], 'include')
        self.assertIn('decision', [c['field'] for c in e['merge_conflicts']])

    def test_hand_edit_before_merge_stays_detectable(self):
        self.r.rule(self.a)
        led = jload(self.a / 'evidence_ledger.json'); led['claims'][0]['text'] = 'The Synthetic Agency enacted a rule.'
        jsave(self.a / 'evidence_ledger.json', led)
        out = merge_runs.merge(self.lead, 'scout-a', self.a)
        self.assertEqual(out['hand_edited'], ['C001'])
        self.assertEqual(ev.hand_edited(jload(self.lead / 'evidence_ledger.json')), ['C001'])
        self.assertIn('CLAIM_EDITED_BY_HAND', codes(check_handoff.check(self.a, 'scout')))

    def test_other_window_and_concurrent_merge_are_refused(self):
        other = self.r.root / 'tasks' / 'other'
        call('init', other, '--end', '2030-03-11', '--cutoff', '2030-03-11T18:00:00+08:00', '--lang', 'en', '--no-cases')
        with self.assertRaises(merge_runs.MergeError):
            merge_runs.merge(self.lead, 'other', other)
        with merge_runs.Lock(self.lead):
            with self.assertRaises(merge_runs.MergeError):
                with merge_runs.Lock(self.lead):
                    pass

    def test_possible_duplicate_is_listed_not_joined(self):
        self.r.rule(self.a)
        self.r.event(self.b, 'https://www.example.gov/other', RULE, 'Synthetic agency proposes an accelerator rule change',
                     'today issued a proposed rule', 'The Synthetic Agency issued a proposed rule.', date='2030-03-01')
        merge_runs.merge(self.lead, 'scout-a', self.a)
        merge_runs.merge(self.lead, 'scout-b', self.b)
        evs = jload(self.lead / 'events.json')
        self.assertEqual(len(evs['events']), 2)
        self.assertEqual(evs['possible_duplicates'][0]['events'], ['E001', 'E002'])
        self.r.narrative(self.lead)
        self.assertIn('POSSIBLE_DUPLICATE', codes(check_handoff.check(self.lead, 'lead')))
        call('event', self.lead, 'decide', 'E002', 'exclude', '--reason', 'duplicate of E001')
        self.assertNotIn('POSSIBLE_DUPLICATE', codes(check_handoff.check(self.lead, 'lead')))


class HandoffTests(unittest.TestCase):
    def setUp(self):
        self.r = Runs()
        self.run = self.r.task('scout')

    def tearDown(self):
        self.r.close()

    def test_complete_scout_handoff_passes(self):
        self.r.rule(self.run)
        self.r.narrative(self.run)
        items = check_handoff.check(self.run, 'scout')
        self.assertFalse([x for x in items if x['status'] == 'FAIL'], items)

    def test_missing_pieces_fail(self):
        call('fetch', self.run, 'https://www.example.gov/x', '--file', self.r.page(RULE, 'x.txt'))
        call('event', self.run, 'add', '--title', 'Synthetic rule', '--date', '2030-03-06', '--side', 'us', '--source', 'S001')
        call('event', self.run, 'add', '--title', 'Later synthetic event', '--date', '2030-03-12', '--side', 'us')
        call('event', self.run, 'decide', 'E002', 'include', '--reason', 'x')
        found = codes(check_handoff.check(self.run, 'scout'))
        for code in ('EVENT_UNDECIDED', 'NARRATIVE_MISSING', 'ASSESSMENT_MISSING', 'MATERIALITY_MISSING',
                     'INCLUDED_WITHOUT_EVIDENCE', 'EVENT_AFTER_CUTOFF', 'NARRATIVE_EVENT_MISSING'):
            self.assertIn(code, found)

    def test_wrong_window_or_language_fails(self):
        a = jload(self.run / 'assignment.json'); a['window'] = {'start': '2030-01-01', 'end': '2030-01-07'}
        jsave(self.run / 'assignment.json', a)
        cfg = jload(self.run / 'run_config.json'); cfg.pop('language'); jsave(self.run / 'run_config.json', cfg)
        found = codes(check_handoff.check(self.run, 'scout'))
        self.assertTrue({'WINDOW_MISMATCH', 'LANGUAGE'} <= found, found)

    def test_invalid_claim_kind_is_refused_early(self):
        eid = self.r.rule(self.run)
        code, out = call('add-claim', self.run, eid, 'S001', '--quote', 'Comments are due by April 9, 2030', '--text', 'Comments are due by April 9, 2030.',
                         '--kind', 'statement')
        self.assertEqual(code, 1); self.assertIn('unknown --kind statement', out)
        led = jload(self.run / 'evidence_ledger.json')
        led['claims'][0]['kinds'] = ['allegation']  # written before the check existed, or by hand
        led['claims'][0]['recorded_sha'] = ev.fingerprint(led['claims'][0])
        jsave(self.run / 'evidence_ledger.json', led)
        self.r.narrative(self.run)
        self.assertIn('CLAIM_KINDS', codes(check_handoff.check(self.run, 'scout')))

    def test_proposed_measure_described_as_enacted_fails(self):
        # The controlled example: the source says "proposed rule", the claim says "enacted".
        eid = self.r.event(self.run, 'https://www.example.gov/rule', RULE, 'Synthetic agency rule', 'today issued a proposed rule on synthetic accelerators',
                           'The Synthetic Agency enacted a rule on synthetic accelerators.')
        self.r.narrative(self.run)
        wording = [x for x in check_handoff.check(self.run, 'scout') if x['code'] == 'STATUS_WORDING']
        self.assertEqual(len(wording), 1)
        self.assertIn('only shows a proposal', wording[0]['message'])
        # Marking the event proposed makes the conflict explicit too.
        call('event', self.run, 'decide', eid, 'include', '--reason', 'r', '--proposed')
        self.assertIn('marked proposed', [x for x in check_handoff.check(self.run, 'scout') if x['code'] == 'STATUS_WORDING'][0]['message'])
        # The fix the protocol prescribes: withdraw and record what the source says.
        call('withdraw', self.run, 'C001', '--reason', 'Proposal, not enacted')
        call('add-claim', self.run, eid, 'S001', '--quote', 'today issued a proposed rule on synthetic accelerators',
             '--text', 'The Synthetic Agency issued a proposed rule on synthetic accelerators.')
        self.assertNotIn('STATUS_WORDING', codes(check_handoff.check(self.run, 'scout')))

    def test_negated_or_future_enactment_is_not_flagged(self):
        self.r.event(self.run, 'https://www.example.gov/rule', RULE, 'Synthetic agency rule', 'today issued a proposed rule on synthetic accelerators',
                     'The Synthetic Agency proposed a rule on synthetic accelerators; it is not yet in force.', proposed=True)
        self.r.narrative(self.run)
        self.assertNotIn('STATUS_WORDING', codes(check_handoff.check(self.run, 'scout')))

    def test_record_ids_in_shown_text_are_flagged(self):
        self.r.rule(self.run, decision='track')
        call('event', self.run, 'decide', 'E001', 'track', '--reason', 'Covered by E013 instead')
        self.r.narrative(self.run)
        scout = [x for x in check_handoff.check(self.run, 'scout') if x['code'] == 'INTERNAL_ID_SHOWN']
        self.assertEqual([x['status'] for x in scout], ['UNVERIFIED'])
        chief = [x for x in check_handoff.check(self.run, 'chief') if x['code'] == 'INTERNAL_ID_SHOWN']
        self.assertEqual([x['status'] for x in chief], ['FAIL'])
        call('event', self.run, 'decide', 'E001', 'track', '--reason', 'The final rule has not been published')
        self.assertNotIn('INTERNAL_ID_SHOWN', codes(check_handoff.check(self.run, 'chief')))

    def test_hand_edited_run_dates_fail(self):
        # Found live: an agent moved the report date to clear a generation-date check.
        self.r.rule(self.run)
        self.r.narrative(self.run)
        cfg = jload(self.run / 'run_config.json')
        a = jload(self.run / 'assignment.json'); a['report_date'] = cfg['report_date']; jsave(self.run / 'assignment.json', a)
        self.assertFalse({'REPORT_DATE_MISMATCH', 'LEDGER_HEADER_MISMATCH'} & codes(check_handoff.check(self.run, 'scout')))
        led = jload(self.run / 'evidence_ledger.json'); led['report_date'] = '2030-03-11'; jsave(self.run / 'evidence_ledger.json', led)
        self.assertIn('LEDGER_HEADER_MISMATCH', codes(check_handoff.check(self.run, 'scout')))
        cfg['report_date'] = '2030-03-11'; jsave(self.run / 'run_config.json', cfg)
        self.assertIn('REPORT_DATE_MISMATCH', codes(check_handoff.check(self.run, 'scout')))

    def test_blocked_source_is_unverified_not_fail(self):
        self.r.rule(self.run)
        call('fetch', self.run, 'https://www.example.gov/blocked', '--file', self.r.page('Access denied', 'b.txt'))
        call('event', self.run, 'add', '--title', 'Hard to source synthetic event', '--date', '2030-03-07', '--side', 'us', '--source', 'S002')
        call('event', self.run, 'decide', 'E002', 'track', '--reason', 'Original could not be opened', '--materiality', 'high',
             '--link', 'l', '--size', 's', '--new', 'n')
        self.r.narrative(self.run)
        items = check_handoff.check(self.run, 'scout')
        self.assertFalse([x for x in items if x['status'] == 'FAIL'], items)
        self.assertIn('SOURCE_NOT_OPENED', codes(items))


class ProvenanceTests(unittest.TestCase):
    """scout → lead → chief, with workflow.json as the controller writes it."""

    def setUp(self):
        self.r = Runs()
        self.lead, self.scout = self.r.task('us-lead'), self.r.task('us-s01')
        self.r.rule(self.scout)
        self.r.narrative(self.scout)
        merge_runs.merge(self.lead, 'us-s01', self.scout)
        merge_runs.merge(self.r.root, 'us-lead', self.lead)
        tasks = [{'id': 'chief', 'dir': '.', 'accepted': None},
                 {'id': 'us-lead', 'dir': 'tasks/us-lead', 'merge_into': 'chief', 'accepted': {'hashes': self.hashes(self.lead)}},
                 {'id': 'us-s01', 'dir': 'tasks/us-s01', 'merge_into': 'us-lead', 'accepted': {'hashes': self.hashes(self.scout)}}]
        jsave(self.r.root / 'workflow.json', {'tasks': tasks})

    def tearDown(self):
        self.r.close()

    def hashes(self, run):
        return {n: check_provenance.sha(run / n) for n in ('events.json', 'evidence_ledger.json', 'sources.json')}

    def test_clean_chain_passes(self):
        items = check_provenance.check(self.r.root)
        self.assertEqual([x['status'] for x in items], ['PASS'], items)

    def test_proposed_status_dropped_upstream_fails(self):
        evs = jload(self.r.root / 'events.json'); evs['events'][0]['proposed'] = False; jsave(self.r.root / 'events.json', evs)
        self.assertIn('STATUS_UPGRADED', codes(check_provenance.check(self.r.root)))

    def test_altered_or_lost_claim_fails(self):
        led = jload(self.r.root / 'evidence_ledger.json')
        led['claims'][0]['text'] = 'The Synthetic Agency enacted a rule on synthetic accelerators.'
        jsave(self.r.root / 'evidence_ledger.json', led)
        self.assertIn('CLAIM_ALTERED', codes(check_provenance.check(self.r.root)))
        led['claims'] = []
        jsave(self.r.root / 'evidence_ledger.json', led)
        self.assertIn('CLAIM_LOST', codes(check_provenance.check(self.r.root)))

    def test_lost_event_and_unmerged_task_fail(self):
        evs = jload(self.r.root / 'events.json'); evs['events'] = []; jsave(self.r.root / 'events.json', evs)
        self.assertIn('EVENT_LOST', codes(check_provenance.check(self.r.root)))
        (self.lead / 'merge_log.json').unlink()
        self.assertIn('NOT_MERGED', codes(check_provenance.check(self.r.root)))

    def test_change_after_acceptance_fails(self):
        call('search', self.scout, 'a late search')
        self.assertIn('TASK_RECORD_CHANGED', codes(check_provenance.check(self.r.root)))


class RoleFileTests(unittest.TestCase):
    """Role files point at sections of the shared instructions instead of copying them; every pointer must resolve."""

    def sections(self, rel, heading):
        text = (SKILL / rel).read_text(encoding='utf-8')
        return re.search(r'^#+\s+' + re.escape(heading) + r'\s*$', text, re.M)

    def test_includes_resolve(self):
        roles = sorted((SKILL / 'references' / 'roles').glob('*.md'))
        self.assertEqual({p.stem for p in roles}, {'protocol', 'topic-scout', 'country-lead', 'chief-editor', 'reviewer'})
        for p in roles:
            if p.stem == 'protocol':
                continue
            head = re.match(r'---\n(.*?)\n---', p.read_text(encoding='utf-8'), re.S)[1]
            fields = dict(line.split(':', 1) for line in head.splitlines())
            for ref in [x.strip() for x in fields['includes'].split('|')] + [x.strip() for x in fields.get('reads', '').split('|') if x.strip()]:
                rel, _, heading = ref.partition('#')
                self.assertTrue((SKILL / rel).exists(), f'{p.name}: {rel}')
                if heading:
                    self.assertTrue(self.sections(rel, heading), f'{p.name}: {ref}')

    def test_scouts_do_not_receive_the_report_workflow(self):
        head = (SKILL / 'references' / 'roles' / 'topic-scout.md').read_text(encoding='utf-8').split('---')[1]
        for heavy in ('template.html', 'Step 5', 'Step 6', 'report-content'):
            self.assertNotIn(heavy, head)

    def test_workflow_budgets_stay_inside_nex_limits(self):
        cfg = json.loads((SKILL / 'references' / 'roles' / 'workflow.json').read_text(encoding='utf-8'))
        # Chief + two leads are live while scouts run; Nex allows 8 live sub-chats per conversation.
        self.assertLessEqual(cfg['max_concurrent_scouts'] + 3, 8)
        ids = {c['id'] for c in json.loads((SKILL / 'references' / 'roles' / 'categories.json').read_text())['categories']}
        self.assertEqual(len(ids), 6)


if __name__ == '__main__':
    unittest.main()
