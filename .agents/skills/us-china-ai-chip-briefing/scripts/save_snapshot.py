#!/usr/bin/env python3
"""Save a source snapshot and print the ledger `snapshot` entry for it.

Use it at the moment you read a source, so the quote can be checked later
offline or behind a proxy.

  # you read the page with a web tool and saved its text to page.txt:
  python3 scripts/save_snapshot.py --from-file page.txt --url URL --run-dir RUN --name C001-1

  # or let the script fetch it (safe_http: private targets blocked):
  python3 scripts/save_snapshot.py --fetch --url URL --run-dir RUN --name C001-1

Paste the printed JSON into that source's "snapshot" field in the ledger.
A snapshot shows what the writer saw. It is not independent proof: a person
reviewing a high-risk claim should still open the live source.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument('--from-file', help='Text or HTML you already retrieved')
    src.add_argument('--fetch', action='store_true', help='Fetch the URL now through safe_http')
    ap.add_argument('--url', required=True)
    ap.add_argument('--run-dir', required=True, help='Folder that holds the ledger; snapshots go in RUN/snapshots/')
    ap.add_argument('--name', required=True, help='File stem, e.g. C001-1')
    ap.add_argument('--timeout', type=float, default=20)
    args = ap.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9._-]{1,80}', args.name):
        print('Name may contain only letters, digits, dot, dash and underscore', file=sys.stderr)
        return 1
    if args.fetch:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from safe_http import safe_get
        r = safe_get(args.url, timeout=args.timeout, max_bytes=5_000_000)
        if not 200 <= r.status < 300:
            print(f'HTTP {r.status}; nothing saved', file=sys.stderr)
            return 2
        data, ext, method = r.body, '.html' if b'<' in r.body[:2000] else '.txt', 'fetched'
    else:
        data = Path(args.from_file).read_bytes()
        ext = Path(args.from_file).suffix.lower() if Path(args.from_file).suffix.lower() in ('.html', '.htm', '.txt') else '.txt'
        method = 'saved from reader'
    out_dir = Path(args.run_dir) / 'snapshots'
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / (args.name + ext)
    path.write_bytes(data)
    entry = {'path': str(path.relative_to(args.run_dir)), 'sha256': hashlib.sha256(data).hexdigest(),
             'retrieved_at': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'method': method}
    print(json.dumps(entry, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
