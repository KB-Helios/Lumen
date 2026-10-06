"""Fixed local execution worker. Rust owns all planning, keys and approvals."""
from __future__ import annotations

import argparse
import asyncio
import concurrent.futures
import ctypes
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

if __name__ == '__main__':
    sys.modules['worker'] = sys.modules[__name__]

MAX_LINE = 16 * 1024 * 1024
MAX_COMMANDS = 4096
SEMANTIC = {'invoke', 'setValue', 'select', 'scroll'}
PIXEL = {'click', 'doubleClick', 'rightClick', 'move', 'drag'}
NATIVE_TOOLS = {'get_window_state', 'click', 'set_value', 'scroll', 'end_session'}
KEYS = {'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Space', 'ArrowUp',
        'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
        'Control', 'Shift', 'Alt', 'Meta', *[f'F{i}' for i in range(1, 13)],
        *list('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')}


class Refusal(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def validate_initial_url(value: str) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= 4096:
        raise ValueError('Invalid URL')
    if any(c.isspace() or ord(c) < 32 for c in value) or '\\' in value:
        raise ValueError('Invalid URL')
    parsed = urlsplit(value)
    if (parsed.scheme.lower() not in {'http', 'https'} or not parsed.hostname
            or parsed.username is not None or parsed.password is not None):
        raise ValueError('Invalid URL')
    _ = parsed.port
    return value


def strict_fields(value: dict, fields: set[str], required: set[str]) -> None:
    if not isinstance(value, dict) or set(value) - fields or not required <= set(value):
        raise ValueError('Invalid fields')


def positive_integer(value) -> bool:
    return type(value) is int and 0 < value <= 2**53 - 1


def validate_action(value: dict) -> dict:
    fields = {
        'invoke': {'element'}, 'setValue': {'element', 'text'}, 'select': {'element', 'text'},
        'scroll': {'element', 'direction', 'amount', 'x', 'y'}, 'navigate': {'url'},
        'keypress': {'element', 'keys'}, 'click': {'x', 'y'}, 'doubleClick': {'x', 'y'},
        'rightClick': {'x', 'y'}, 'move': {'x', 'y'}, 'drag': {'x', 'y', 'endX', 'endY'},
        'type': {'element', 'text'}, 'wait': {'amount'}}
    if not isinstance(value, dict) or value.get('kind') not in fields:
        raise ValueError('Invalid action')
    kind = value['kind']
    strict_fields(value, set().union(*fields.values()) | {'kind'}, {'kind'})
    result = {key: item for key, item in value.items() if item is not None}
    strict_fields(result, fields[kind] | {'kind'}, {'kind'})
    for key in ('element', 'text', 'url'):
        if key in result and (not isinstance(result[key], str) or len(result[key]) > 4000):
            raise ValueError('Invalid string')
    if kind in {'invoke', 'setValue', 'select'} and not result.get('element'):
        raise ValueError('Missing element')
    if kind in {'setValue', 'select', 'type'} and 'text' not in result:
        raise ValueError('Missing text')
    if kind == 'navigate':
        validate_initial_url(result.get('url'))
    if kind == 'keypress':
        keys = result.get('keys')
        if (not isinstance(keys, list) or not 1 <= len(keys) <= 5
                or any(key not in KEYS for key in keys) or len(set(keys)) != len(keys)):
            raise ValueError('Invalid keys')
    coordinate_keys = {'x', 'y', 'endX', 'endY'} & set(result)
    for key in coordinate_keys:
        if (type(result[key]) not in {int, float} or not math.isfinite(result[key])
                or not 0 <= result[key] <= 32768):
            raise ValueError('Invalid coordinates')
    if kind in PIXEL and not {'x', 'y'} <= set(result):
        raise ValueError('Missing coordinates')
    if kind == 'drag' and not {'endX', 'endY'} <= set(result):
        raise ValueError('Missing coordinates')
    if kind == 'scroll':
        if result.get('direction') not in {'up', 'down', 'left', 'right'}:
            raise ValueError('Invalid direction')
        if bool('x' in result) != bool('y' in result):
            raise ValueError('Incomplete coordinates')
    if kind in {'wait', 'scroll'}:
        amount = result.get('amount', 200 if kind == 'wait' else 600)
        limit = 5000 if kind == 'wait' else 3000
        if (type(amount) not in {int, float} or not math.isfinite(amount)
                or int(amount) != amount or not 0 <= amount <= limit
                or (kind == 'scroll' and not amount)):
            raise ValueError('Invalid amount')
        result['amount'] = int(amount)
    return result


def validate_manifest(value: dict, target: dict) -> None:
    strict_fields(value, {'version', 'expires_after', 'idle_timeout', 'allow', 'resources'},
                  {'version', 'expires_after', 'idle_timeout', 'allow', 'resources'})
    if value['version'] != 3 or value['expires_after'] != '10m' or value['idle_timeout'] != '2m':
        raise ValueError('Invalid scope lifetime')
    strict_fields(value['allow'], {'tools'}, {'tools'})
    tools = value['allow']['tools']
    if not isinstance(tools, list) or not tools or any(tool not in NATIVE_TOOLS for tool in tools):
        raise ValueError('Invalid tool scope')
    resources = value['resources']
    strict_fields(resources, {'apps', 'desktop'}, {'apps', 'desktop'})
    if resources['desktop'] != {'display': False} or len(resources['apps']) != 1:
        raise ValueError('Invalid desktop scope')
    app = resources['apps'][0]
    strict_fields(app, {'executable', 'launch', 'windows', 'terminate'},
                  {'executable', 'launch', 'windows', 'terminate'})
    if (not Path(app['executable']).is_absolute()
            or os.path.normcase(os.path.realpath(app['executable'])) != os.path.normcase(os.path.realpath(target['executable']))
            or app['launch'] is not False or app['windows'] != 'all'
            or app['terminate'] not in {'driver_launched', 'deny'}):
        raise ValueError('Invalid application scope')


def map_cua_result(payload: dict) -> dict:
    routes = {'accessibility': 'uia', 'synthetic_events': 'win32', 'system_api': 'win32'}
    route = routes.get(payload.get('route'), 'uia')
    effect = {'suspected_noop': 'suspectedNoop'}.get(payload.get('effect'), payload.get('effect'))
    # This mapper is entered only after SDK dispatch. A refusal or malformed
    # receipt cannot prove input was withheld, even if value readback matches.
    # Only the adapter's local pre-dispatch refusal is foreground-retryable.
    if (payload.get('escalation') or payload.get('error') or payload.get('refusal')
            or effect not in {'confirmed', 'partial', 'suspectedNoop', 'unverifiable'}
            or payload.get('route') not in routes
            or (payload.get('delivery') is not None and payload['delivery'].get('mode') != 'background')):
        return {'effect': 'unverifiable', 'route': route, 'verified': False,
                'detail': 'backgroundExecutionUncertain'}
    # Driver success is not our independent postcondition.
    return {'effect': effect if effect in {'partial', 'suspectedNoop', 'unverifiable'} else 'unverifiable',
            'route': route, 'verified': False}


class Executor:
    def __init__(self):
        self.session = None
        self.identity = None
        self.retired = set()
        self.cache = {}
        self.current = None
        self.scope = None

    def close(self):
        self.current = None
        if self.session is not None:
            session, self.session = self.session, None
            session.close()

    def dispatch(self, request: dict) -> dict:
        envelope = {key: request.get(key) for key in ('id', 'runId', 'generation')} if isinstance(request, dict) else {}
        self.possible_input = False
        try:
            if (not isinstance(request, dict) or not positive_integer(request.get('id'))
                    or not positive_integer(request.get('generation')) or not isinstance(request.get('runId'), str)):
                raise ValueError('Invalid envelope')
            uuid.UUID(request['runId'])
            identity = (request['runId'], request['generation'])
            kind = request.get('type')
            fields = {'begin': {'target', 'manifestPath'}, 'observe': {'screenshot'},
                      'act': {'snapshotId', 'action'}, 'end': set()}
            if kind not in fields:
                raise ValueError('Invalid command')
            strict_fields(request, fields[kind] | {'id', 'runId', 'generation', 'type'},
                          {'id', 'runId', 'generation', 'type'})
            fingerprint = hashlib.sha256(json.dumps(request, sort_keys=True, allow_nan=False).encode()).hexdigest()
            key = (*identity, request['id'])
            if identity in self.retired or (kind != 'begin' and identity != self.identity):
                raise Refusal('targetUnavailable')
            if key in self.cache:
                old_hash, response = self.cache[key]
                if old_hash != fingerprint:
                    raise Refusal('invalidAction')
                return json.loads(json.dumps(response))
            if len(self.cache) >= MAX_COMMANDS:
                raise Refusal('invalidAction')
            # Reserve before any possible input; a timeout/error cannot permit replay.
            self.cache[key] = (fingerprint, {**envelope, 'ok': False,
                                           'error': {'code': 'workerError', 'message': 'workerError'}})
            if kind == 'begin':
                response = self._begin(request, identity)
            elif self.session is None:
                raise Refusal('targetUnavailable')
            elif kind == 'end':
                self.close()
                response = {}
            elif kind == 'observe':
                if type(request.get('screenshot', False)) is not bool:
                    raise ValueError('Invalid screenshot request')
                self.current = None
                self.current = self.session.observe(request.get('screenshot', False))
                response = {'observation': self.current}
            else:
                response = self._act(request)
            response = {**envelope, 'ok': True, **response}
        except (ValueError, TypeError, KeyError, OverflowError):
            code = 'workerError' if self.possible_input else 'invalidAction'
            response = {**envelope, 'ok': False, 'error': {'code': code, 'message': code}}
        except Refusal as error:
            code = 'workerError' if self.possible_input and error.code in {'invalidAction', 'staleSnapshot'} else error.code
            response = {**envelope, 'ok': False, 'error': {'code': code, 'message': code}}
        except Exception:
            self.current = None
            response = {**envelope, 'ok': False, 'error': {'code': 'workerError', 'message': 'workerError'}}
        if isinstance(request, dict) and 'key' in locals() and key in self.cache and self.cache[key][0] == fingerprint:
            self.cache[key] = (fingerprint, response)
        return response

    def _begin(self, request, identity):
        target = request['target']
        if target.get('kind') == 'browser':
            strict_fields(target, {'kind', 'initialUrl', 'headless'}, {'kind', 'initialUrl', 'headless'})
            validate_initial_url(target['initialUrl'])
            if type(target['headless']) is not bool or request.get('manifestPath') is not None:
                raise ValueError('Invalid browser target')
            scope = ('browser',)
        elif target.get('kind') == 'window':
            strict_fields(target, {'kind', 'pid', 'windowId', 'executable'}, {'kind', 'pid', 'windowId', 'executable'})
            if not positive_integer(target['pid']) or not positive_integer(target['windowId']) or not Path(target['executable']).is_absolute():
                raise ValueError('Invalid window target')
            path = Path(request['manifestPath'])
            if not path.is_absolute() or path.stat().st_size > 65536:
                raise ValueError('Invalid manifest')
            raw = path.read_bytes()
            validate_manifest(json.loads(raw), target)
            scope = ('window', target['pid'], target['windowId'], os.path.normcase(os.path.realpath(target['executable'])),
                     os.path.normcase(str(path.resolve())), hashlib.sha256(raw).hexdigest())
        else:
            raise ValueError('Invalid target')
        if self.scope is not None and self.scope != scope:
            raise Refusal('targetUnavailable')
        self.close()
        if self.identity is not None and self.identity != identity:
            self.retired.add(self.identity)
        self.identity, self.scope = identity, scope
        if target['kind'] == 'browser':
            from browser_executor import BrowserSession
            self.session = BrowserSession(target)
        else:
            from window_executor import WindowSession
            self.session = WindowSession(target, str(path), scope[-1])
        return {}

    def _act(self, request):
        action = validate_action(request['action'])
        before = self.current
        if before is None or request.get('snapshotId') != before['snapshotId']:
            raise Refusal('staleSnapshot')
        if before.get('degraded') and action['kind'] != 'wait':
            raise Refusal('observationUnavailable')
        coordinates = action['kind'] in PIXEL or 'x' in action
        if coordinates and 'screenshot' not in before:
            raise Refusal('staleSnapshot')
        for x, y in [('x', 'y'), ('endX', 'endY')]:
            if x in action and (action[x] >= before['width'] or action[y] >= before['height']):
                raise Refusal('invalidAction')
        if 'element' in action and not any(element['ref'] == action['element'] for element in before['elements']):
            raise Refusal('staleSnapshot')
        self.current = None
        self.possible_input = True
        result = self.session.act(action, before)
        try:
            self.current = self.session.observe(False)
        except Exception:
            # Input may have happened. Return uncertainty and never repeat it.
            result = {**result, 'effect': 'partial', 'verified': False, 'detail': 'observationUnavailable'}
            return {'result': result}
        self.session.verify(action, before, self.current, result)
        return {'result': result, 'observation': self.current}


def edge_executable() -> Path | None:
    candidates = [Path(value) / 'Microsoft/Edge/Application/msedge.exe'
                  for name in ('PROGRAMFILES(X86)', 'PROGRAMFILES', 'LOCALAPPDATA')
                  if (value := os.environ.get(name))]
    if found := shutil.which('msedge'):
        candidates.append(Path(found))
    return next((path for path in candidates if path.is_file()), None)


def configured_driver(manifest_path: str):
    import cua_driver as cua
    options = cua.ConfiguredDriverOptions(
        claude_code_compatibility=False,
        authorization=cua.RuntimeAuthorizationOptions(
            allowed_modes=[cua.SessionPermissionMode.BOUNDED],
            compatibility_mode=cua.SessionPermissionMode.BOUNDED,
            compatibility_capability_manifest_path=manifest_path,
            compatibility_bounded_manifest_path=None,
            unrestricted_acknowledged=False,
            max_session_ttl_seconds=600,
            max_idle_ttl_seconds=120))
    # The supervised fixed binary owns its native helper directory and exposes no socket.
    return cua.CuaDriver.create_private_worker(cua.PrivateWorkerOptions(
        binary_path=str(cua.get_binary_path()), host_bundle_id='com.lumen.executor',
        startup_timeout_ms=2000, shutdown_timeout_ms=1000, configured_driver=options,
        environment=[], inherit_stderr=False))


def probe_desktop() -> bool:
    if sys.platform != 'win32':
        return False
    import cua_driver as cua
    root = Path(cua.__file__).parent
    if not all((root / name).is_file() for name in (
            'cua_driver_sdk.dll', 'bin/cua-driver.exe', 'bin/cua-driver-uia.exe')):
        return False
    user32 = ctypes.WinDLL('user32', use_last_error=True)
    user32.OpenInputDesktop.restype = ctypes.c_void_p
    user32.CloseDesktop.argtypes = [ctypes.c_void_p]
    desktop = user32.OpenInputDesktop(0, False, 0x100)
    if not desktop:
        return False
    user32.CloseDesktop(desktop)
    cache = (Path(os.environ.get('LOCALAPPDATA', str(Path(sys.executable).parent))) / 'Lumen/ComputerUseWorker/cache'
             if getattr(sys, 'frozen', False) else Path(__file__).parent / '.build/cache')
    cache.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='health-', dir=cache.resolve()) as directory:
        manifest = Path(directory) / 'capability.json'
        manifest.write_text(json.dumps({'version': 3, 'expires_after': '10m',
            'idle_timeout': '2m', 'allow': {'tools': ['get_window_state']},
            'resources': {'apps': [], 'desktop': {'display': False}}}), encoding='utf-8')
        driver = configured_driver(str(manifest))
        try:
            return bool(driver.is_available())
        finally:
            asyncio.run(asyncio.wait_for(driver.shutdown(), 1))


def probe_edge() -> bool:
    if edge_executable() is None:
        return False
    from playwright.sync_api import sync_playwright
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel='msedge', headless=True, timeout=3500)
        browser.close()
    return True


def health() -> dict:
    command = [sys.executable] if getattr(sys, 'frozen', False) else [sys.executable, str(Path(__file__).resolve())]

    def probe(flag: str) -> bool:
        try:
            result = subprocess.run([*command, flag], stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, timeout=5, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            return result.returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            return False

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        edge, desktop = list(pool.map(probe, ['--probe-edge', '--probe-desktop']))
    return {'ready': edge or desktop, 'edgeAvailable': edge, 'desktopAvailable': desktop}


def run() -> int:
    parser = argparse.ArgumentParser(description='Lumen fixed execution worker')
    parser.add_argument('--health', action='store_true')
    parser.add_argument('--executor', action='store_true')
    parser.add_argument('--probe-edge', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--probe-desktop', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.health:
        print(json.dumps(health()))
        return 0
    if args.probe_edge or args.probe_desktop:
        try:
            return 0 if (probe_edge() if args.probe_edge else probe_desktop()) else 1
        except Exception:
            return 1
    executor = Executor()
    try:
        while raw := sys.stdin.buffer.readline(MAX_LINE + 1):
            if len(raw) > MAX_LINE:
                # The oversized command cannot be safely resumed at an arbitrary boundary.
                return 1
            try:
                request = json.loads(raw, parse_constant=lambda _value: (_ for _ in ()).throw(ValueError()))
                response = executor.dispatch(request)
            except (ValueError, UnicodeDecodeError):
                response = {'ok': False, 'error': {'code': 'invalidAction', 'message': 'invalidAction'}}
            encoded = json.dumps(response, ensure_ascii=True, allow_nan=False, separators=(',', ':'))
            if len(encoded) > MAX_LINE:
                response = {key: response.get(key) for key in ('id', 'runId', 'generation')}
                response.update(ok=False, error={'code': 'observationUnavailable', 'message': 'observationUnavailable'})
                encoded = json.dumps(response)
            sys.stdout.write(encoded + '\n')
            sys.stdout.flush()
    finally:
        executor.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(run())
