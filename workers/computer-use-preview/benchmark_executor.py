"""Bounded local protocol benchmark for source and staged executors."""
from __future__ import annotations

import argparse
import importlib.metadata
import json
import math
import platform
import queue
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

from test_executor import EdgeTests

ROOT = Path(__file__).resolve().parent
PACKAGED = ROOT.parent.parent / 'src-tauri/binaries/lumen-computer-use-x86_64-pc-windows-msvc.exe'
FIELDS = ['Message', 'Field 2', 'Field 3', 'Field 4', 'Field 5']


def summary(samples):
    ordered = sorted(samples)
    return {'count': len(samples), 'medianMs': round(statistics.median(samples), 2),
            'p95Ms': round(ordered[math.ceil(len(samples) * .95) - 1], 2),
            'minimumMs': round(ordered[0], 2), 'maximumMs': round(ordered[-1], 2)}


class Client:
    def __init__(self, command):
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.responses = queue.Queue()
        self.identity = {'runId': str(uuid.uuid4()), 'generation': 1}
        self.next_id = 1
        self.metrics = []

        def read():
            for line in self.process.stdout:
                self.responses.put(line)
        threading.Thread(target=read, daemon=True).start()

    def call(self, kind, **kwargs):
        request = {'id': self.next_id, **self.identity, 'type': kind, **kwargs}
        self.next_id += 1
        started = time.perf_counter()
        line = json.dumps(request, separators=(',', ':'))
        self.process.stdin.write(line + '\n')
        self.process.stdin.flush()
        raw = self.responses.get(timeout=13)
        response = json.loads(raw)
        if any(response.get(key) != request[key] for key in ('id', 'runId', 'generation')):
            raise RuntimeError('Protocol envelope mismatch')
        self.metrics.append({'command': kind, 'latencyMs': round((time.perf_counter() - started) * 1000, 2),
            'requestBytes': len(line.encode()), 'responseBytes': len(raw.encode()),
            'screenshot': 'screenshot' in response.get('observation', {}), 'ok': response['ok'],
            'effect': response.get('result', {}).get('effect'), 'refusal': response.get('error', {}).get('code')})
        return response

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=4)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=2)
        self.process.stdout.close()


def run_browser(command, repetitions):
    client = Client(command)
    try:
        begin = client.call('begin', target={'kind': 'browser', 'initialUrl': EdgeTests.url, 'headless': True})
        if not begin['ok']:
            raise RuntimeError('Fixture browser unavailable')
        observation = client.call('observe')['observation']
        samples, warm_metrics = [], []
        # One five-field warm-up is excluded from the twenty measured repetitions.
        for repetition in range(-1, repetitions):
            started = time.perf_counter()
            for step, name in enumerate(FIELDS):
                element = next(e for e in observation['elements'] if e['name'] == name)
                nullable = dict.fromkeys(['element', 'text', 'url', 'keys', 'x', 'y',
                                          'endX', 'endY', 'direction', 'amount'])
                response = client.call('act', snapshotId=observation['snapshotId'],
                    action={**nullable, 'kind': 'setValue', 'element': element['ref'],
                            'text': f'local repetition {repetition} field {step}'})
                if (response.get('result', {}).get('effect') != 'confirmed'
                        or not response['result']['verified'] or 'screenshot' in response['observation']):
                    raise RuntimeError('Semantic read-back failed')
                observation = response['observation']
                if repetition >= 0:
                    warm_metrics.append(client.metrics[-1])
            if repetition >= 0:
                samples.append(round((time.perf_counter() - started) * 1000, 2))
        frame = client.call('observe', screenshot=True)
        if not frame['ok'] or 'screenshot' not in frame['observation']:
            raise RuntimeError('Requested fixture screenshot unavailable')
        client.call('end')
        return {'metrics': client.metrics, 'warmRepetitions': repetitions, 'fieldsPerRepetition': 5,
                'warmRepetitionLatencyMs': samples, 'warmRepetitionSummary': summary(samples),
                'warmActionSummary': summary([m['latencyMs'] for m in warm_metrics]),
                'warmProtocolBytes': sum(m['requestBytes'] + m['responseBytes'] for m in warm_metrics),
                'semanticActionCount': repetitions * 5, 'semanticScreenshotCount': 0,
                'confirmedReadbacks': repetitions * 5,
                'plannerCallPotential': {'fixedBatch': 1, 'originalSingleStepTurns': 5,
                    'measuredLiveProviderSavings': False}}
    finally:
        client.close()


def run_legacy_baseline(repetitions):
    from playwright.sync_api import sync_playwright
    samples, action_samples, screenshot_bytes = [], [], 0
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel='msedge', headless=True, timeout=5000)
        try:
            context = browser.new_context(viewport={'width': 1440, 'height': 900})
            page = context.new_page()
            page.goto(EdgeTests.url, wait_until='load', timeout=2000)
            for repetition in range(-1, repetitions):
                started = time.perf_counter()
                for step, name in enumerate(FIELDS):
                    action_started = time.perf_counter()
                    box = page.get_by_label(name, exact=True).bounding_box(timeout=2000)
                    page.mouse.click(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
                    page.keyboard.press('Control+A')
                    page.keyboard.press('Backspace')
                    value = f'local repetition {repetition} field {step}'
                    page.keyboard.type(value)
                    page.wait_for_load_state('load', timeout=2000)
                    page.wait_for_load_state('load', timeout=2000)
                    time.sleep(.5)
                    image = page.screenshot(type='png', full_page=False, timeout=2000)
                    if page.get_by_label(name, exact=True).input_value(timeout=2000) != value:
                        raise RuntimeError('Legacy fixture read-back failed')
                    if repetition >= 0:
                        action_samples.append(round((time.perf_counter() - action_started) * 1000, 2))
                        screenshot_bytes += len(image)
                if repetition >= 0:
                    samples.append(round((time.perf_counter() - started) * 1000, 2))
        finally:
            browser.close()
    return {'kind': 'reproducedConservativeScreenshotLoop', 'warmRepetitions': repetitions,
        'sequence': 'coordinate click, Ctrl+A, Backspace, keyboard.type, load wait, duplicate load wait, 500 ms sleep, PNG screenshot, value read-back',
        'provenance': 'upstream/computers/playwright/playwright.py:type_text_at/current_state',
        'limitation': 'Excludes upstream extra screenshots inside key_combination and all provider latency; comparison is a conservative local execution floor.',
        'warmRepetitionLatencyMs': samples, 'warmRepetitionSummary': summary(samples),
        'warmActionSummary': summary(action_samples), 'semanticScreenshotCount': repetitions * 5,
        'screenshotPngBytes': screenshot_bytes, 'confirmedReadbacks': repetitions * 5}


def run_window(command):
    fixture = subprocess.Popen([sys.executable, str(ROOT / 'native_fixture.py')],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        target = json.loads(fixture.stdout.readline())
        target = {'kind': 'window', 'pid': target['pid'], 'windowId': target['windowId'],
                  'executable': target['executable']}
        with tempfile.TemporaryDirectory(prefix='benchmark-window-', dir=ROOT / '.build') as directory:
            path = Path(directory) / 'capability.json'
            path.write_text(json.dumps({'version': 3, 'expires_after': '10m', 'idle_timeout': '2m',
                'allow': {'tools': ['get_window_state', 'click', 'set_value', 'scroll', 'end_session']},
                'resources': {'apps': [{'executable': target['executable'], 'launch': False,
                    'windows': 'all', 'terminate': 'driver_launched'}], 'desktop': {'display': False}}}))
            client = Client(command)
            try:
                begin = client.call('begin', target=target, manifestPath=str(path))
                if not begin['ok']:
                    return {'metrics': client.metrics, 'limitation': 'targetUnavailable'}
                observed = client.call('observe')
                if not observed['ok']:
                    return {'metrics': client.metrics, 'limitation': observed['error']['code']}
                observation = observed['observation']
                element = next(e for e in observation['elements'] if e.get('value') == 'native before')
                response = client.call('act', snapshotId=observation['snapshotId'],
                    action={'kind': 'setValue', 'element': element['ref'], 'text': 'native benchmark'})
                confirmed = response.get('result', {}).get('effect') == 'confirmed'
                client.call('end')
                return {'metrics': client.metrics, 'confirmedReadbacks': int(confirmed),
                        'semanticScreenshotCount': 0}
            finally:
                client.close()
    finally:
        fixture.communicate('\n', timeout=5)


def main():
    parser = argparse.ArgumentParser(description='Local fixed executor benchmark')
    parser.add_argument('--packaged', action='store_true')
    parser.add_argument('--native', action='store_true')
    parser.add_argument('--baseline', action='store_true')
    parser.add_argument('--warm-repetitions', type=int, default=20, choices=range(1, 101))
    args = parser.parse_args()
    command = [str(PACKAGED), '--executor'] if args.packaged else [sys.executable, str(ROOT / 'worker.py'), '--executor']
    (ROOT / '.build').mkdir(exist_ok=True)
    EdgeTests.setUpClass()
    try:
        output = {'schemaVersion': 1, 'mode': 'packaged' if args.packaged else 'source',
            'python': platform.python_version(), 'windows': platform.version(),
            'playwright': importlib.metadata.version('playwright'),
            'cuaDriver': importlib.metadata.version('cua-driver'),
            'browser': run_browser(command, args.warm_repetitions)}
        if args.baseline:
            output['legacyBaseline'] = run_legacy_baseline(args.warm_repetitions)
            (ROOT / '.build/benchmark-legacy-baseline.json').write_text(
                json.dumps(output['legacyBaseline'], indent=2) + '\n', encoding='utf-8')
        if args.native:
            output['window'] = run_window(command)
        path = ROOT / '.build' / f'benchmark-{output["mode"]}.json'
        path.write_text(json.dumps(output, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(output, indent=2))
    finally:
        EdgeTests.tearDownClass()


if __name__ == '__main__':
    main()
