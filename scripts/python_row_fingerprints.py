import csv
import hashlib
import json
import sys
from pathlib import Path


def normalize_amount(value: str) -> int:
    raw = (value or '').strip()
    if raw in ('', '-', 'ー'):
        return 0
    compact = raw.replace(',', '').replace('，', '')
    return int(float(compact))


def build_row_fingerprint(
    *,
    date_text: str,
    content: str,
    merchant: str,
    out_amount: int,
    in_amount: int,
    method: str,
    payment_type: str,
    user: str,
) -> str:
    raw = json.dumps(
        [
            date_text,
            content,
            merchant,
            str(out_amount),
            str(in_amount),
            method,
            payment_type,
            user,
        ],
        ensure_ascii=False,
        sort_keys=True,
        separators=(',', ':'),
    )
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()


def main() -> int:
    if len(sys.argv) < 3:
        print('usage: python_row_fingerprints.py <csv_path> <python_repo_path>', file=sys.stderr)
        return 2

    csv_path = Path(sys.argv[1]).resolve()
    python_repo_path = Path(sys.argv[2]).resolve()

    if not csv_path.exists():
        print(f'csv not found: {csv_path}', file=sys.stderr)
        return 2

    if not python_repo_path.exists():
        print(f'python repo not found: {python_repo_path}', file=sys.stderr)
        return 2

    sys.path.insert(0, str((python_repo_path / 'src').resolve()))

    fingerprints = set()

    with csv_path.open('r', encoding='utf-8-sig', newline='') as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            date_text = (row.get('取引日') or '').strip()
            merchant = (row.get('取引先') or '').strip()
            content = (row.get('取引内容') or '').strip()
            method = (row.get('取引方法') or '').strip()
            payment_type = (row.get('支払い区分') or '').strip()
            user = (row.get('利用者') or '').strip()

            if not date_text or not merchant:
                continue

            try:
                out_amount = normalize_amount(row.get('出金金額（円）') or '')
                in_amount = normalize_amount(row.get('入金金額（円）') or '')
            except Exception:
                continue

            if out_amount > 0 and in_amount > 0:
                continue
            if out_amount == 0 and in_amount == 0:
                continue

            fingerprints.add(
                build_row_fingerprint(
                    date_text=date_text,
                    content=content,
                    merchant=merchant,
                    out_amount=out_amount,
                    in_amount=in_amount,
                    method=method,
                    payment_type=payment_type,
                    user=user,
                )
            )

    for value in sorted(fingerprints):
        print(value)

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
