"""Incremental Snapcraft metrics archive. Credentials only enter snapcraft's environment."""
import argparse
import fcntl
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import time
from urllib.request import Request, urlopen

DIMENSIONS = ('architecture', 'channel', 'country', 'operating_system', 'version')
METRICS = ['daily_device_change', 'weekly_device_change'] + [
    prefix + 'installed_base_by_' + dimension
    for prefix in ('', 'weekly_') for dimension in DIMENSIONS]
NULL_COMPAT = False


def run_snapcraft(arguments):
    global NULL_COMPAT
    python = Path('/snap/snapcraft/current/bin/python')
    compat = [str(python), str(Path(__file__).with_name('snapcraft_metrics_compat.py'))]
    result = subprocess.run((compat if NULL_COMPAT else ['snapcraft']) + arguments,
                            capture_output=True, text=True, timeout=120, check=False)
    if (result.returncode and not NULL_COMPAT and python.exists()
            and 'MetricsResponse' in result.stderr and 'input_value=None' in result.stderr):
        NULL_COMPAT = True
        print('Applying Snapcraft null-observation compatibility fix.', flush=True)
        result = subprocess.run(compat + arguments, capture_output=True, text=True,
                                timeout=120, check=False)
    result.check_returncode()
    return result


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, separators=(',', ':')) + '\n')
    temp.replace(path)


def validate(data, metric):
    if data.get('status') not in ('OK', 'NO DATA') or data.get('metric_name') != metric:
        raise ValueError('Store did not return a successful matching metric')
    if data['status'] == 'NO DATA' and (data['buckets'] or data['series']):
        raise ValueError('Store returned observations with a NO DATA status')
    buckets = data['buckets']
    if len(set(buckets)) != len(buckets) or buckets != sorted(buckets):
        raise ValueError('Invalid date buckets')
    for day in buckets:
        date.fromisoformat(day)
    names = set()
    for series in data['series']:
        if not isinstance(series['name'], str) or series['name'] in names:
            raise ValueError('Invalid series name')
        names.add(series['name'])
        if len(series['values']) != len(buckets):
            raise ValueError('Mismatched series length')
        for value in series['values']:
            if value is not None and (type(value) not in (int, float) or value < 0 or not float(value) < float('inf')):
                raise ValueError('Invalid metric value')
    return data


def merge(old, new):
    """Replace returned dates, including removed series; never turn missing into zero."""
    days = sorted(set(old.get('buckets', [])) | set(new['buckets']))
    series = {}
    for payload in (old, new):
        for item in payload.get('series', []):
            series.setdefault(item['name'], {})
    for payload in (old, new):
        current = {s['name']: s['values'] for s in payload.get('series', [])}
        for name, values in series.items():
            for i, day in enumerate(payload.get('buckets', [])):
                values[day] = current[name][i] if name in current else None
    return {**new, 'buckets': days, 'series': [
        {'name': name, 'values': [values.get(day) for day in days]}
        for name, values in sorted(series.items())]}


def fetch_metric(snap, metric, start, end):
    for attempt in range(3):
        try:
            result = run_snapcraft([
                'metrics', snap, '--name', metric, '--format=json',
                '--start', str(start), '--end', str(end)])
            # Some versions return no output when no data exists.
            data = json.loads(result.stdout) if result.stdout.strip() else {
                'status': 'OK', 'metric_name': metric, 'buckets': [], 'series': []}
            validate(data, metric)
            if any(not str(start) <= day <= str(end) for day in data['buckets']):
                raise ValueError('Returned dates outside requested range')
            return data
        except (subprocess.SubprocessError, ValueError, KeyError):
            if attempt == 2:
                # Do not print CLI output: it could contain credential diagnostics.
                raise RuntimeError('Snapcraft query failed after three attempts') from None
            time.sleep(2 ** attempt)


def discover(config):
    request = Request('https://api.snapcraft.io/v2/snaps/find?publisher=' + config['publisher'],
                      headers={'Snap-Device-Series': '16', 'User-Agent': 'snap-charts/0.1'})
    for attempt in range(3):
        try:
            with urlopen(request, timeout=60) as response:
                results = json.load(response)['results']
            if not results:
                raise ValueError('Empty publisher inventory')
            break
        except Exception:
            if attempt == 2:
                raise RuntimeError('Publisher discovery failed; refusing an incomplete inventory') from None
            time.sleep(2 ** attempt)
    snaps = {s['name']: {'name': s['name'], 'title': s.get('snap', {}).get('title', s['name'])} for s in results}
    for snap in config['snaps']:
        snaps.setdefault(snap['name'], {'name': snap['name'], 'title': snap.get('title', snap['name'])})
    for name in config.get('exclude', []):
        snaps.pop(name, None)
    if any(not re.fullmatch(r'[a-z0-9][a-z0-9-]*', name) for name in snaps):
        raise ValueError('Unsafe snap name')
    return sorted(snaps.values(), key=lambda s: s['name'])


def collect_one(task, refresh=True):
    snap, metric, root, history_start, end, backfill = task
    path = root / snap / (metric + '.json')
    record = json.loads(path.read_text()) if path.exists() else {}
    old = record.get('data', {})
    refresh = refresh or 'historyFrom' not in record
    recent_start = max(history_start, end - timedelta(days=30))
    # Recover downtime gaps too, with requests no longer than 365 days.
    cursor = max(history_start, min(recent_start, date.fromisoformat(record.get('recentThrough', str(recent_start))) - timedelta(days=7)))
    try:
        while refresh and cursor <= end:
            stop = min(end, cursor + timedelta(days=364))
            old = merge(old, fetch_metric(snap, metric, cursor, stop))
            record.update(data=old, recentThrough=str(stop))
            record.setdefault('historyFrom', str(cursor))
            write_json(path, record)
            cursor = stop + timedelta(days=1)
        if refresh:
            record['updatedAt'] = datetime.now(timezone.utc).isoformat()
        record.pop('error', None)
        if backfill and date.fromisoformat(record['historyFrom']) > history_start:
            stop = date.fromisoformat(record['historyFrom']) - timedelta(days=1)
            start = max(history_start, stop - timedelta(days=364))
            record['data'] = merge(record['data'], fetch_metric(snap, metric, start, stop))
            record['historyFrom'] = str(start)
    except RuntimeError as error:
        record['error'] = str(error)
    write_json(path, record)
    return snap, metric, record


def publish(records, snaps, output, history_start, demo=False):
    # This directory is generated output only. Remove obsolete partitions so
    # excluded snaps or demo files cannot remain in a subsequent deployment.
    output.mkdir(parents=True, exist_ok=True)
    obsolete = set(output.rglob('*.json'))
    manifest = {'schemaVersion': 1, 'generatedAt': datetime.now(timezone.utc).isoformat(),
                'publisher': 'popey', 'demo': demo, 'historyStart': str(history_start), 'snaps': snaps, 'metrics': METRICS,
                'records': {}, 'partitions': {}}
    by_metric = {metric: {} for metric in METRICS}
    for snap, metric, record in records:
        by_metric[metric][snap] = record
    for metric, records_by_snap in by_metric.items():
        manifest['records'][metric] = {snap: {k: v for k, v in record.items() if k != 'data'}
                                       for snap, record in records_by_snap.items()}
        months = sorted({day[:7] for record in records_by_snap.values() for day in record.get('data', {}).get('buckets', [])})
        manifest['partitions'][metric] = months
        for month in months:
            shard = {}
            for snap, record in records_by_snap.items():
                data = record.get('data', {})
                indices = [i for i, day in enumerate(data.get('buckets', [])) if day.startswith(month)]
                if not indices:
                    continue
                shard[snap] = {'buckets': [data['buckets'][i] for i in indices], 'series': [
                    {'name': series['name'], 'values': [series['values'][i] for i in indices]}
                    for series in data['series'] if any(series['values'][i] is not None for i in indices)]}
            path = output / metric / (month + '.json')
            write_json(path, shard)
            obsolete.discard(path)
    write_json(output / 'manifest.json', manifest)
    obsolete.discard(output / 'manifest.json')
    for path in obsolete:
        path.unlink()


def select_backfill(boundaries, start, limit, oldest_first=False, overview_first=False):
    pending = [pair for pair, boundary in boundaries.items() if boundary > str(start)]
    if overview_first:
        # These two metrics feed every line on Compare apps and All app charts.
        # Advance them for every app before deepening the other breakdowns.
        overview = {'installed_base_by_architecture', 'weekly_installed_base_by_architecture'}
        totals = sorted((p for p in pending if p[1] in overview), key=boundaries.get, reverse=True)
        remaining = sorted((p for p in pending if p[1] not in overview), key=boundaries.get)
        return set((totals + remaining)[:limit])
    return set(sorted(pending, key=boundaries.get, reverse=not oldest_first)[:limit])


def collect_batch(config, root, output, snaps, start, end, historical_only, continuous):
    pairs = [(s['name'], m) for s in snaps for m in METRICS]
    boundaries = {}
    for pair in pairs:
        path = root / pair[0] / (pair[1] + '.json')
        boundaries[pair] = json.loads(path.read_text()).get('historyFrom', str(end)) if path.exists() else str(end)
    selected = select_backfill(boundaries, start, config['backfillRequests'], oldest_first=continuous,
                               overview_first=continuous)
    if continuous and not selected:
        return 0
    tasks = [(s, m, root, start, end, (s, m) in selected) for s, m in pairs
             if not historical_only or (s, m) in selected]
    print(f'Collecting {len(tasks)} metrics for {len(snaps)} snaps, with up to {len(selected)} backfill requests.', flush=True)
    records = []
    with ThreadPoolExecutor(max_workers=config['workers']) as pool:
        futures = [pool.submit(collect_one, task, refresh=not historical_only) for task in tasks]
        for future in as_completed(futures):
            records.append(future.result())
            if len(records) % 25 == 0 or len(records) == len(tasks):
                print(f'Completed {len(records)}/{len(tasks)} metrics ({sum("error" in r for _, _, r in records)} errors).', flush=True)
    errors = sum('error' in record for _, _, record in records)
    print(f'{len(snaps)} snaps, {len(records)} metrics processed, {errors} failed queries; checkpoints saved.', flush=True)
    if errors:
        for snap, metric, record in records:
            if 'error' in record:
                print(f'Failed: {snap} / {metric}', flush=True)
    if errors > len(records) * 0.1:
        raise RuntimeError('Over 10% failed; preserving the published snapshot. Check credentials and Store availability.')
    if historical_only:
        records = [(s, m, json.loads(path.read_text()) if path.exists() else {})
                   for s, m in pairs for path in [root / s / (m + '.json')]]
    publish(records, snaps, output, start)
    complete = sum(r.get('historyFrom', str(end)) <= str(start) for _, _, r in records)
    earliest = min(r.get('historyFrom', str(end)) for _, _, r in records)
    print(f'Snapshot updated: earliest checked date {earliest}; {complete}/{len(pairs)} metrics checked back to {start}.', flush=True)
    return len(tasks)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', default='config/snaps.json')
    parser.add_argument('--state', default='.state')
    parser.add_argument('--output', default='public/data')
    parser.add_argument('--credentials', type=Path,
                        help='Read exported Snapcraft credentials from a file without logging them')
    parser.add_argument('--backfill-only', action='store_true',
                        help='Fetch a historical batch without re-querying recent observations')
    parser.add_argument('--backfill-until-complete', action='store_true',
                        help='Continue historical-only batches until every metric reaches historyStart')
    args = parser.parse_args()
    if args.credentials:
        os.environ['SNAPCRAFT_STORE_CREDENTIALS'] = args.credentials.read_text().strip()
    config = json.loads(Path(args.config).read_text())
    root = Path(args.state)
    root.mkdir(parents=True, exist_ok=True)
    with (root / '.collector.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit('Another collector is already using this archive.') from None
        start = date.fromisoformat(config['historyStart'])
        end = datetime.now(timezone.utc).date() - timedelta(days=1)
        snaps = discover(config)
        historical_only = args.backfill_only or args.backfill_until_complete
        if config['backfillRequests'] <= 0 and historical_only:
            raise SystemExit('backfillRequests must be positive for historical collection')
        progress_path = root / 'backfill-progress.json'
        batches = 0
        try:
            while True:
                if args.backfill_until_complete:
                    write_json(progress_path, {'status':'running', 'target':str(start), 'completedBatches':batches,
                                              'updatedAt':datetime.now(timezone.utc).isoformat()})
                processed = collect_batch(config, root, Path(args.output), snaps, start, end,
                                          historical_only, args.backfill_until_complete)
                if not processed or not args.backfill_until_complete:
                    break
                batches += 1
            if args.backfill_until_complete:
                write_json(progress_path, {'status':'complete', 'target':str(start), 'completedBatches':batches,
                                          'updatedAt':datetime.now(timezone.utc).isoformat()})
                print(f'Historical collection complete back to {start}.', flush=True)
        except (Exception, KeyboardInterrupt) as error:
            if args.backfill_until_complete:
                write_json(progress_path, {'status':'failed', 'target':str(start), 'completedBatches':batches,
                                          'updatedAt':datetime.now(timezone.utc).isoformat()})
            raise SystemExit(str(error)) from None

if __name__ == '__main__':
    main()
