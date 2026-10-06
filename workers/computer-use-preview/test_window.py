import ctypes
import json
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent


@unittest.skipUnless(sys.platform == 'win32', 'Windows fixture')
class WindowTests(unittest.TestCase):
    def setUp(self):
        from worker import Executor
        self.fixture = subprocess.Popen([sys.executable, str(ROOT / 'native_fixture.py')],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, creationflags=subprocess.CREATE_NO_WINDOW)
        self.addCleanup(lambda: self.fixture.communicate('\n', timeout=5))
        target = json.loads(self.fixture.stdout.readline())
        self.fixture_handles = target
        self.target = {'kind': 'window', 'pid': target['pid'], 'windowId': target['windowId'],
                       'executable': str(Path(target['executable']).resolve())}
        (ROOT / '.build').mkdir(exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(prefix='lumen-executor-test-', dir=ROOT / '.build')
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'capability.json'
        self.path.write_text(json.dumps({'version': 3, 'expires_after': '10m', 'idle_timeout': '2m',
            'allow': {'tools': ['get_window_state', 'click', 'set_value', 'scroll', 'end_session']},
            'resources': {'apps': [{'executable': self.target['executable'], 'launch': False,
                'windows': 'all', 'terminate': 'driver_launched'}], 'desktop': {'display': False}}}))
        self.identity = {'runId': str(uuid.uuid4()), 'generation': 1}
        self.next_id = 1
        self.executor = Executor()
        self.addCleanup(self.executor.close)
        response = self.command('begin', target=self.target, manifestPath=str(self.path))
        self.assertTrue(response['ok'], response)

    def command(self, kind, **kwargs):
        request = {'id': self.next_id, **self.identity, 'type': kind, **kwargs}
        self.next_id += 1
        return self.executor.dispatch(request)

    def observe(self, screenshot=False):
        # Only observations may retry a cold native timeout, in a fresh runtime.
        # Input is never retried, even when its outcome is uncertain.
        for attempt in range(3):
            response = self.command('observe', screenshot=screenshot)
            if response['ok']:
                return response['observation']
            self.assertEqual(response['error']['code'], 'observationUnavailable', response)
            if attempt < 2:
                self.identity['generation'] += 1
                self.assertTrue(self.command('begin', target=self.target, manifestPath=str(self.path))['ok'])
        self.fail(f'Native observation failed its bounded cold-start attempts: {response}')

    def test_native_value_readback_keeps_window_backgrounded_and_hides_password(self):
        u = ctypes.WinDLL('user32')
        u.GetForegroundWindow.restype = ctypes.c_void_p
        u.GetWindow.argtypes = [ctypes.c_void_p, ctypes.c_uint]
        u.GetWindow.restype = ctypes.c_void_p
        u.IsWindowVisible.argtypes = [ctypes.c_void_p]
        u.IsWindowVisible.restype = ctypes.c_bool
        enum_callback = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_ssize_t)
        u.EnumWindows.argtypes = [enum_callback, ctypes.c_ssize_t]
        u.SendMessageTimeoutW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_size_t,
                                         ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint,
                                         ctypes.POINTER(ctypes.c_size_t)]
        u.SendMessageTimeoutW.restype = ctypes.c_void_p

        class Point(ctypes.Structure):
            _fields_ = [('x', ctypes.c_long), ('y', ctypes.c_long)]

        def desktop_state():
            point = Point()
            self.assertTrue(u.GetCursorPos(ctypes.byref(point)))
            visible_order = []
            def collect(hwnd, _):
                if u.IsWindowVisible(hwnd):
                    visible_order.append(hwnd)
                return True
            self.assertTrue(u.EnumWindows(enum_callback(collect), 0))
            return {'foreground': u.GetForegroundWindow(), 'cursor': [point.x, point.y],
                    'visibleOrder': visible_order}

        def mouse_movement_count():
            self.fixture.stdin.write('mouse-state\n')
            self.fixture.stdin.flush()
            return json.loads(self.fixture.stdout.readline())['rawMouseMovements']

        input_edit = self.fixture_handles['inputEditId']
        own_input = 'owned-concurrent-input'
        messages_sent = []

        def send_owned_input():
            for char in own_input:
                receipt = ctypes.c_size_t()
                sent = u.SendMessageTimeoutW(input_edit, 0x0102, ord(char), None, 2, 1000, ctypes.byref(receipt))
                messages_sent.append(bool(sent))
                time.sleep(.02)
        before = self.observe()
        self.assertNotIn('native-protected-secret', json.dumps(before))
        element = next(e for e in before['elements'] if e.get('value') == 'native before')
        prior_mouse_movements = mouse_movement_count()
        prior_state = desktop_state()
        sender = threading.Thread(target=send_owned_input)
        sender.start()
        after = self.command('act', snapshotId=before['snapshotId'],
            action={'kind': 'setValue', 'element': element['ref'], 'text': 'native after'})
        self.assertTrue(after['ok'], after)
        button = next(e for e in after['observation']['elements'] if e['name'] == 'No effect')
        invoked = self.command('act', snapshotId=after['observation']['snapshotId'],
            action={'kind': 'invoke', 'element': button['ref']})
        sender.join(timeout=3)
        self.assertFalse(sender.is_alive())
        final_state = desktop_state()
        final_mouse_movements = mouse_movement_count()
        stable_windows = set(prior_state['visibleOrder']).intersection(final_state['visibleOrder'])
        before_order = [hwnd for hwnd in prior_state['visibleOrder'] if hwnd in stable_windows]
        after_order = [hwnd for hwnd in final_state['visibleOrder'] if hwnd in stable_windows]
        target = self.target['windowId']
        before_above = set(before_order[:before_order.index(target)])
        after_above = set(after_order[:after_order.index(target)])
        buffer = ctypes.create_unicode_buffer(128)
        receipt = ctypes.c_size_t()
        self.assertTrue(u.SendMessageTimeoutW(input_edit, 0x000D, len(buffer), ctypes.cast(buffer, ctypes.c_void_p),
                                             2, 1000, ctypes.byref(receipt)))
        evidence = {'before': prior_state, 'after': final_state,
                    'nativeActions': ['setValue', 'invoke'],
                    'noEffectInvokeConfirmed': invoked.get('result', {}).get('verified', False),
                    'rawMouseMovements': final_mouse_movements - prior_mouse_movements,
                    'cursorSampleHasConcurrentMouseMovement': final_mouse_movements != prior_mouse_movements,
                    'cursorMethod': 'Exact cursor equality remains required; raw movement is diagnostic only',
                    'foregroundUnchanged': prior_state['foreground'] == final_state['foreground'],
                    'cursorUnchanged': prior_state['cursor'] == final_state['cursor'],
                    'targetVisibleZOrderUnchanged': before_above == after_above,
                    'zOrderMethod': 'Target relative order among surviving visible windows; excludes hidden/new helper windows',
                    'ownedInputReadback': buffer.value == own_input and all(messages_sent),
                    'actualForegroundKeyboardTested': False,
                    'inputEvidence': 'Concurrent WM_CHAR sent only to a second owned background fixture control'}
        (ROOT / '.build/window-invariants.json').write_text(json.dumps(evidence, indent=2), encoding='utf-8')
        self.assertTrue(after['ok'], after)
        self.assertEqual(after['result']['effect'], 'confirmed', after)
        self.assertTrue(after['result']['verified'])
        self.assertTrue(any(e.get('value') == 'native after' for e in after['observation']['elements']))
        self.assertNotIn('screenshot', after['observation'])
        self.assertTrue(invoked['ok'], invoked)
        self.assertFalse(invoked['result']['verified'], invoked)
        self.assertNotIn('screenshot', invoked['observation'])
        self.assertTrue(evidence['foregroundUnchanged'], evidence)
        self.assertTrue(evidence['cursorUnchanged'], evidence)
        self.assertTrue(evidence['targetVisibleZOrderUnchanged'], evidence)
        self.assertTrue(evidence['ownedInputReadback'], evidence)

    def test_native_gesture_refusal_has_post_observation_and_no_foreground_fallback(self):
        before = self.observe(screenshot=True)
        after = self.command('act', snapshotId=before['snapshotId'],
            action={'kind': 'drag', 'x': 20, 'y': 30, 'endX': 30, 'endY': 40})
        self.assertTrue(after['ok'], after)
        self.assertEqual(after['result']['effect'], 'refused')
        self.assertFalse(after['result']['verified'])
        self.assertNotIn('screenshot', after['observation'])

    def test_manifest_mutation_and_changed_window_are_refused(self):
        replacement = self.path.with_name('same-scope-another-path.json')
        replacement.write_bytes(self.path.read_bytes())
        alternate = self.command('begin', target=self.target, manifestPath=str(replacement))
        self.assertFalse(alternate['ok'])
        self.assertEqual(alternate['error']['code'], 'targetUnavailable')
        changed = self.command('begin', target={**self.target, 'windowId': self.target['windowId'] + 1},
                               manifestPath=str(self.path))
        self.assertFalse(changed['ok'])
        self.assertEqual(changed['error']['code'], 'targetUnavailable')
        self.path.write_text('{}')
        after = self.command('observe')
        self.assertFalse(after['ok'])
        self.assertEqual(after['error']['code'], 'targetUnavailable')


if __name__ == '__main__':
    unittest.main()
