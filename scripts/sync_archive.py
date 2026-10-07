"""Sync the durable archive, retrying incomplete transfers without deleting data."""
import argparse
import subprocess
import time


def sync_archive(direction):
    remote = 's3://snap-charts-history/state/'
    source, destination = (remote, '.state/') if direction == 'restore' else ('.state/', remote)
    command = ['aws', 's3', 'sync', source, destination,
               '--exclude', '*', '--include', '*/*.json', '--only-show-errors']
    for attempt in range(1, 4):
        result = subprocess.run(command, check=False)
        if result.returncode == 0:
            return
        if attempt == 3:
            raise subprocess.CalledProcessError(result.returncode, command)
        delay = 15 * attempt
        print(f'Archive {direction} incomplete; retrying in {delay}s ({attempt}/3).', flush=True)
        time.sleep(delay)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('direction', choices=['restore', 'save'])
    sync_archive(parser.parse_args().direction)
