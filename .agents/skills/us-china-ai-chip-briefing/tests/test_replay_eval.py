"""Replay evaluation: controls on a synthetic brief.py report, replay of a finished run, baseline comparison."""
import copy
import io
import json
from contextlib import redirect_stdout
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
import unittest.mock

SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL / 'scripts'))
import replay_eval as rv  # noqa: E402
from check_report import validate_report  # noqa: E402


def quiet(fn, *args, **kwargs):
    with redirect_stdout(io.StringIO()):
        return fn(*args, **kwargs)


class ControlTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cases = rv.load_cases(rv.CASES)
        cls.results = rv.run_controls(cls.cases)

    def test_committed_cases_hold(self):
        summary = rv.controls_summary(self.cases, self.results)
        self.assertTrue(summary['ok'], self.results)
        self.assertEqual(self.results['clean']['verdict'], 'CLEAN')
        self.assertEqual(self.results['verified-wording']['verdict'], 'DETECTED')
        self.assertEqual(self.results['scope-overbroad']['verdict'], 'REVIEWER_ONLY')

    def test_clean_report_rows_match_their_evidence(self):
        rows = self.results['clean']['rows']
        self.assertGreater(rows['rows'], 1)
        self.assertEqual((rows['unparsed'], rows['mismatched']), (0, []))

    def test_wrong_dot_is_seen_by_the_row_audit(self):
        # The QA misses it today (known gap); the replay's own audit does not.
        self.assertEqual(self.results['unsupported-row-amber']['verdict'], 'KNOWN_GAP')
        self.assertEqual([(m['dot'], m['expected']) for m in self.results['unsupported-row-amber']['rows']['mismatched']], [('a', 'u')])

    def test_known_gap_that_is_now_caught_fails_until_the_case_is_updated(self):
        cases = copy.deepcopy(self.cases)
        case = next(c for c in cases if c['id'] == 'verified-wording')
        case['known_gap'] = 'pretend the rule did not exist'
        results = rv.run_controls(cases)
        self.assertEqual(results['verified-wording']['verdict'], 'NOW_DETECTED')
        self.assertFalse(rv.controls_summary(cases, results)['ok'])

    def test_negative_control_without_known_gap_must_be_caught(self):
        cases = copy.deepcopy(self.cases)
        case = next(c for c in cases if c['id'] == 'confirmed-row-slate')
        del case['known_gap']
        results = rv.run_controls(cases)
        self.assertEqual(results['confirmed-row-slate']['verdict'], 'MISSED')
        self.assertFalse(rv.controls_summary(cases, results)['ok'])

    def test_cli_exit_code_and_output_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(quiet(rv.main, ['controls', '--output-dir', tmp]), 0)
            card = json.loads((Path(tmp) / 'replay-controls.json').read_text())
            self.assertTrue(card['summary']['ok'])
            self.assertIn('Known gaps', (Path(tmp) / 'replay-controls.md').read_text())


class MutationTests(unittest.TestCase):
    PAGE = ('<table><tbody><tr><td>A</td><td data-label="x"><i class="dot g"></i>Official or company source opened</td></tr>'
            '<tr><td>B</td><td data-label="x"><i class="dot u"></i>Original not obtained or not yet checked; reason</td></tr>'
            '</tbody></table><p>Text once.</p>')

    def test_replace_must_match_exactly_once(self):
        self.assertIn('Text twice', rv.mutate(self.PAGE, {'op': 'replace', 'find': 'Text once', 'replace': 'Text twice'}))
        with self.assertRaises(rv.CaseError):
            rv.mutate(self.PAGE, {'op': 'replace', 'find': 'absent', 'replace': 'x'})

    def test_status_dot_changes_one_row(self):
        page = rv.mutate(self.PAGE, {'op': 'status_dot', 'row': 1, 'to': 'a'})
        self.assertEqual([d for d, _ in rv.status_rows(page)], ['g', 'a'])
        for bad in ({'op': 'status_dot', 'row': 5, 'to': 'a'}, {'op': 'status_dot', 'row': 0, 'to': 'g'}, {'op': 'drop'}):
            with self.assertRaises(rv.CaseError):
                rv.mutate(self.PAGE, bad)

    def test_expected_dot_follows_brief_labels_in_both_languages(self):
        self.assertEqual(rv.expected_dot('Official or company source opened'), 'g')
        self.assertEqual(rv.expected_dot('Media reports only; Reuters said'), 'a')
        self.assertEqual(rv.expected_dot('Core claim not supported by a source'), 'u')
        self.assertEqual(rv.expected_dot('Proposed: Media reports only'), 's')
        self.assertEqual(rv.expected_dot('Official or company source opened; an independent check found no source for a key claim'), 'u')
        self.assertEqual(rv.expected_dot('仅有媒体报道'), 'a')
        self.assertEqual(rv.expected_dot('拟议：官方或公司原文已打开'), 's')
        self.assertIsNone(rv.expected_dot('Something a model wrote'))

    def test_case_file_needs_one_positive_control(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'cases.json'
            p.write_text(json.dumps({'cases': [{'id': 'a', 'control': 'negative'}]}))
            with self.assertRaises(rv.CaseError):
                rv.load_cases(p)


class RunReplayTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        built = quiet(rv.build_base, self.tmp.name)
        self.run = Path(self.tmp.name) / 'finished-run'
        shutil.copytree(built, self.run)
        page = (self.run / 'report.html').read_text(encoding='utf-8')
        (self.run / 'report.html').write_text(rv.mutate(page, {'op': 'status_dot', 'row': 1, 'to': 'a'}), encoding='utf-8')

    def tearDown(self):
        self.tmp.cleanup()

    def test_replay_scores_recorded_and_rebuilt_without_writing_the_run(self):
        before = {p: p.read_bytes() for p in self.run.rglob('*') if p.is_file()}
        entry = quiet(rv.replay_run, self.run)
        self.assertEqual(len(entry['recorded']['rows']['mismatched']), 1)
        self.assertEqual(entry['rebuilt']['rows']['mismatched'], [])  # the current renderer repairs it
        self.assertEqual({p: p.read_bytes() for p in self.run.rglob('*') if p.is_file()}, before)

    def test_baseline_comparison_flags_a_worse_run(self):
        out = Path(self.tmp.name) / 'card'
        self.assertEqual(quiet(rv.main, ['runs', str(self.run), '--output-dir', str(out)]), 0)
        baseline = out / 'replay-runs.json'
        self.assertEqual(quiet(rv.main, ['runs', str(self.run), '--baseline', str(baseline)]), 0)
        page = (self.run / 'report.html').read_text(encoding='utf-8')
        (self.run / 'report.html').write_text(page.replace('Synthetic judgment note 2.', 'Synthetic judgment note 2, verified.'), encoding='utf-8')
        with tempfile.TemporaryDirectory() as tmp2:
            self.assertEqual(quiet(rv.main, ['runs', str(self.run), '--no-rebuild', '--baseline', str(baseline), '--output-dir', tmp2]), 1)
            change = json.loads((Path(tmp2) / 'replay-runs.json').read_text())['changes'][0]
        self.assertEqual((change['stage'], change['new_fail'], change['regression']), ('recorded', ['VERIFIED_WORDING'], True))

    def test_missing_report_is_bad_input(self):
        (self.run / 'report.html').unlink()
        with redirect_stdout(io.StringIO()), unittest.mock.patch('sys.stderr', io.StringIO()):
            self.assertEqual(rv.main(['runs', str(self.run)]), 2)


class VerifiedWordingTests(unittest.TestCase):
    """Found by the replay controls: a word merely starting with 'not' or 'un' excused a verification claim."""

    def test_words_starting_like_a_negation_do_not_excuse_it(self):
        for text in ('Synthetic judgment note 2, fully verified.', 'The notice was verified.', 'The United States verified the list.',
                     'Figures under review were verified.'):
            r = validate_report(f'<p>{text}</p>', '2030-01-02')
            self.assertIn('VERIFIED_WORDING', {x['code'] for x in r}, text)

    def test_real_negations_still_do(self):
        for text in ('It was not verified.', 'It has never been verified.', 'An un-verified figure.', 'It is yet to be verified.'):
            r = validate_report(f'<p>{text}</p>', '2030-01-02')
            self.assertNotIn('VERIFIED_WORDING', {x['code'] for x in r}, text)


if __name__ == '__main__':
    unittest.main()
