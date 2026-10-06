"""Exact-window bounded Cua SDK adapter; no desktop or foreground escalation."""
from __future__ import annotations

import asyncio
import base64
import ctypes
import hashlib
import json
import os
import struct
import time
import uuid
from ctypes import wintypes
from pathlib import Path

from worker import Refusal, configured_driver, map_cua_result


def sdk_result_payload(response):
    action = getattr(response, 'action', None)
    if action is None and hasattr(response, 'effect'):
        action = response
    if action is not None:
        from cua_driver import ActionDeliveryMode, ActionRoute
        delivery = {'mode': action.delivery.mode.name.lower()} if action.delivery else None
        # The pinned typed UIA receipt uses these valid sentinel modes for
        # set_value. They make no delivery claim; value confirmation still
        # requires an independent post-observation. Refusal/error/escalation
        # metadata is preserved and can never authorize foreground replay.
        if (action.route is ActionRoute.ACCESSIBILITY and action.delivery
                and action.delivery.mode in {ActionDeliveryMode.UNKNOWN, ActionDeliveryMode.NOT_APPLICABLE}):
            delivery = None
        payload = {'effect': action.effect.name.lower(), 'route': action.route.name.lower(),
            'escalation': bool(action.escalation), 'error': bool(action.error),
            'delivery': delivery}
    else:
        payload = json.loads(response.structured_json or response.raw_json)
    if getattr(response, 'is_error', False):
        payload['error'] = True
    return payload


def window_identity(target):
    user = ctypes.WinDLL('user32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD,
        wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE, *[ctypes.POINTER(wintypes.FILETIME)] * 4]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    pid = wintypes.DWORD()
    user.GetWindowThreadProcessId(target['windowId'], ctypes.byref(pid))
    if pid.value != target['pid']:
        raise Refusal('targetUnavailable')
    process = kernel.OpenProcess(0x1000, False, pid.value)
    if not process:
        raise Refusal('targetUnavailable')
    try:
        length = wintypes.DWORD(32768)
        buffer = ctypes.create_unicode_buffer(length.value)
        times = [wintypes.FILETIME() for _ in range(4)]
        if not kernel.QueryFullProcessImageNameW(process, 0, buffer, ctypes.byref(length)):
            raise Refusal('targetUnavailable')
        if os.path.normcase(os.path.realpath(buffer.value)) != os.path.normcase(os.path.realpath(target['executable'])):
            raise Refusal('targetUnavailable')
        if not kernel.GetProcessTimes(process, *[ctypes.byref(item) for item in times]):
            raise Refusal('targetUnavailable')
        return (pid.value, times[0].dwHighDateTime, times[0].dwLowDateTime)
    finally:
        kernel.CloseHandle(process)


class WindowSession:
    def __init__(self, target, manifest_path, manifest_hash):
        self.target = target.copy()
        self.path, self.manifest_hash = Path(manifest_path), manifest_hash
        self.identity = window_identity(target)
        self.loop = asyncio.new_event_loop()
        self.driver = configured_driver(manifest_path)
        self.refs = {}
        self.native_snapshot = None
        self.last_descriptor = None
        self.poisoned = False

    def check_target(self):
        try:
            valid = (not self.poisoned and window_identity(self.target) == self.identity
                     and hashlib.sha256(self.path.read_bytes()).hexdigest() == self.manifest_hash)
        except OSError:
            valid = False
        if not valid:
            raise Refusal('targetUnavailable')

    def call(self, operation):
        try:
            return self.loop.run_until_complete(asyncio.wait_for(operation, timeout=5))
        except (asyncio.TimeoutError, TimeoutError):
            self.poisoned = True
            raise Refusal('observationUnavailable') from None

    def close(self):
        try:
            self.loop.run_until_complete(asyncio.wait_for(self.driver.shutdown(), 1))
        except Exception:
            pass
        finally:
            self.loop.close()
            self.refs.clear()

    def observe(self, screenshot=False):
        self.check_target()
        self.refs.clear()
        # The typed 0.34 WindowStateOutput drops capture_id. Keep the fixed
        # native tool's structured metadata so pixels bind to the actual frame,
        # rather than incorrectly substituting an accessibility snapshot id.
        response = self.call(self.driver.call_tool('get_window_state', json.dumps({
            'pid': self.target['pid'], 'window_id': self.target['windowId'],
            'include_accessibility_tree': True, 'include_screenshot': screenshot,
            'max_elements': 300, 'max_depth': 25, 'max_image_dimension': 0, 'timeout_ms': 1500})))
        if response.is_error:
            raise Refusal('observationUnavailable')
        state = json.loads(response.structured_json or response.raw_json)
        if state.get('pid') != self.target['pid'] or state.get('window_id') != self.target['windowId']:
            raise Refusal('targetUnavailable')
        self.native_snapshot = state.get('capture_id')
        snapshot = uuid.uuid4().hex
        bounds = state.get('window_bounds') or {}
        observation = {'snapshotId': snapshot, 'title': (state.get('window_title') or '')[:1000],
            'elements': [], 'width': int(bounds.get('width', 0)),
            'height': int(bounds.get('height', 0))}
        for element in (state.get('elements') or [])[:300]:
            role = element['role']
            actions = {str(action).lower().replace('_', '') for action in (element.get('actions') or [])}
            supported = []
            if any('invoke' in action or 'toggle' in action for action in actions):
                supported.append('invoke')
            if any('value' in action for action in actions):
                supported.append('setValue')
            # SelectionItem delivery is unavailable in the pinned Windows backend.
            # Windows scroll ignores element_token in this SDK; do not advertise semantic scroll.
            ref = snapshot + ':' + uuid.uuid4().hex
            item = {'ref': ref, 'role': role, 'name': (element.get('label') or '')[:1000],
                'enabled': element.get('enabled') is True, 'actions': supported}
            # The native SDK omits UIA password/protected values; unrecognized roles are also hidden.
            if element.get('value') is not None and 'password' not in role.lower() and 'protected' not in role.lower():
                item['value'] = element['value'][:4000]
            if element.get('frame'):
                frame = element['frame']
                item['bounds'] = {'x': frame['x'] - (0 if screenshot else bounds.get('x', 0)),
                    'y': frame['y'] - (0 if screenshot else bounds.get('y', 0)),
                    'width': frame['w'], 'height': frame['h']}
            self.refs[ref] = {'token': element.get('element_token'), 'descriptor': (role, item['name'], element['element_index']),
                              'actions': supported}
            observation['elements'].append(item)
        # In 0.34.0 Windows always sets elements_complete=false because it cannot
        # prove negative existence (impl_.rs:1514-1517). Fresh positive element
        # tokens remain valid; actual degradation/truncation is separate.
        if response.degraded or state.get('degraded') or state.get('truncated'):
            observation['degraded'] = True
        if screenshot:
            if (state.get('screenshot_frame_valid') is False or not response.images
                    or response.images[0].mime_type != 'image/png' or not self.native_snapshot):
                raise Refusal('observationUnavailable')
            data = response.images[0].data_base64
            image = base64.b64decode(data, validate=True)
            if image[:8] != b'\x89PNG\r\n\x1a\n':
                raise Refusal('observationUnavailable')
            width, height = struct.unpack('>II', image[16:24])
            observation.update(width=width, height=height,
                               screenshot={'mimeType': 'image/png', 'data': data})
        return observation

    def act(self, action, before):
        self.check_target()
        kind = action['kind']
        entry = self.refs.get(action.get('element'))
        self.last_descriptor = entry['descriptor'] if entry else None
        if kind == 'wait':
            time.sleep(action['amount'] / 1000)
            return {'effect': 'unverifiable', 'route': 'uia', 'verified': False}
        if kind in {'invoke', 'click', 'move', 'drag', 'navigate', 'select', 'doubleClick', 'rightClick', 'keypress', 'type', 'scroll'}:
            # The pinned SDK's background click/invoke changes z-order in the
            # native acceptance fixture. Rust may offer scoped foreground input.
            route = 'uia' if kind in {'invoke', 'select'} else 'win32' if kind in {'keypress', 'type'} else 'backgroundPixels'
            return {'effect': 'refused', 'route': route, 'verified': False,
                    'detail': 'backgroundUnavailable'}
        if kind == 'setValue':
            if not entry or not entry['token'] or kind not in entry['actions']:
                raise Refusal('invalidAction')
        arguments = {'pid': self.target['pid'], 'window_id': self.target['windowId'],
                     'delivery_mode': 'background'}
        if entry and entry['token']:
            arguments['element_token'] = entry['token']
        if kind != 'setValue':
            raise Refusal('invalidAction')
        # This constant SDK operation never comes from the provider or wire.
        arguments['value'] = action['text']
        response = self.call(self.driver.call_tool('set_value', json.dumps(arguments)))
        payload = sdk_result_payload(response)
        self.check_target()
        return map_cua_result(payload)

    def verify(self, action, before, after, result):
        if (result['effect'] in {'refused', 'partial'} or result.get('detail') == 'backgroundExecutionUncertain' or after.get('degraded')
                or action['kind'] not in {'setValue', 'select'} or self.last_descriptor is None):
            return
        role, name, _index = self.last_descriptor
        candidates = [e for e in after['elements'] if e['role'] == role and e['name'] == name]
        if len(candidates) == 1 and candidates[0].get('value') == action['text']:
            result.update(effect='confirmed', verified=True)
