#!/usr/bin/env python3
"""Generate deliberately failing, mocked QA artifacts; never public-source evidence."""
import argparse
import json
from pathlib import Path
from test_qa import FIX, fixture_opener, run


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--output-dir',default='fixture-evaluation')
    args=ap.parse_args()
    out=Path(args.output_dir); out.mkdir(parents=True,exist_ok=True)
    result,md=run(FIX/'flawed_report.html',FIX/'flawed_ledger.json',FIX/'flawed_review.json',network=True,opener=fixture_opener)
    (out/'review_report.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    (out/'review_report.md').write_text(md)
    print('Synthetic/mock evaluation outcome:',result['outcome'])
    print('Expected rejection: C002 unsupported; 404 broken; 403 blocked; dates and figure numbering fail.')
    # This is an evaluation runner: success means expected failures were detected.
    found={x['code'] for xs in result['checks'].values() for x in xs}
    expected={'CLAIM_UNSUPPORTED','BROKEN','BLOCKED','DATE_CONFLICT','FIGURE_DUPLICATE','FIGURE_SEQUENCE','FIRST_USE'}
    return 0 if result['outcome']=='FAIL' and expected<=found else 1


if __name__=='__main__':
    raise SystemExit(main())
