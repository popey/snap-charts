"""Write deterministic, explicitly labelled demonstration data, never real Store metrics."""
from datetime import date, timedelta
import argparse
import math
from pathlib import Path
from collect import METRICS, publish

end = date.today() - timedelta(days=1)
days = [str(end - timedelta(days=i)) for i in reversed(range(400))]
snaps = [{'name': name, 'title': title} for name, title in [
    ('calibre', 'Calibre'), ('dosbox-staging', 'DOSBox Staging'), ('ncspot', 'ncspot'),
    ('halloy', 'Halloy'), ('mame', 'MAME'), ('shattered-pixel-dungeon', 'Shattered Pixel Dungeon')]]
categories = {'architecture': ['amd64', 'arm64', 'armhf'], 'channel': ['stable', 'candidate', 'beta', 'edge'],
              'country': ['GB', 'US', 'DE', 'FR', 'IN'], 'operating_system': ['Ubuntu/24.04', 'Ubuntu/22.04', 'Debian/12', 'Fedora/42'],
              'version': ['3.0', '2.9', '2.8'], 'change': ['new', 'continued', 'lost']}
records = []
for si, snap in enumerate(snaps):
    for metric in METRICS:
        dimension = metric.split('_by_')[-1] if '_by_' in metric else 'change'
        series = []
        for j, name in enumerate(categories[dimension]):
            values = [max(0, round((6000/(si+1) + i*4/(si+1) + math.sin(i/18+si)*220) / (j+1)**3)) for i in range(len(days))]
            if dimension == 'change' and name != 'continued':
                values = [round(v * .025) for v in values]
            series.append({'name': name, 'values': values})
        records.append((snap['name'], metric, {'data': {'buckets': days, 'series': series},
            'updatedAt': str(end) + 'T23:59:00+00:00', 'historyFrom': days[0]}))
parser = argparse.ArgumentParser()
parser.add_argument('--output', default='public/data')
args = parser.parse_args()
publish(records, snaps, Path(args.output), days[0], demo=True)
print(f'Synthetic demonstration data written to {args.output}; do not deploy as real metrics.')
