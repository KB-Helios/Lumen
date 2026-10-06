"""Local-only executor acceptance tests; no provider calls."""
import http.server
import json
import math
import subprocess
import sys
import threading
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FIXTURE = b'''<!doctype html><title>Executor fixture</title>
<label for="entry">Message</label><input id="entry" value="before">
<label>Field 2<input value="before"></label><label>Field 3<input value="before"></label>
<label>Field 4<input value="before"></label><label>Field 5<input value="before"></label>
<label>Password<input type="password" value="protected-secret"></label>
<label>Choice<select><option value="a">Alpha</option><option value="b">Beta</option></select></label>
<button onclick="document.querySelector('output').textContent='Changed'">Change</button>
<button>No effect</button><output>Initial</output>
<iframe src="/frame"></iframe>
<div role="region" aria-label="Scroll fixture" style="height:80px;overflow:auto"><div style="height:2000px">Scrollable</div></div>
<div style="height:2000px"></div>'''
FRAME = b'<label>Frame message<input value="frame before"></label><button>Frame no effect</button>'


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(FRAME if self.path == '/frame' else FIXTURE)

    def log_message(self, *_args):
        pass


class HealthTests(unittest.TestCase):
    def test_health_needs_no_provider_dependencies_and_reports_both_routes(self):
        completed = subprocess.run([sys.executable, str(ROOT / 'worker.py'), '--health'],
                                   capture_output=True, timeout=10)
        self.assertTrue(completed.stdout.strip().startswith(b'{'), completed.stderr.decode())
        health = json.loads(completed.stdout)
        self.assertEqual(health['ready'], health['edgeAvailable'] or health['desktopAvailable'])
        self.assertEqual(completed.returncode, 0)


class ValidationTests(unittest.TestCase):
    def test_urls_reject_local_schemes_credentials_and_invalid_authority(self):
        from worker import validate_initial_url
        for value in ['file:///C:/private', 'javascript:alert(1)', 'example.com',
                      'https://user:secret@example.com', 'https://example.com\\@evil.test',
                      'https://example.com:bad', 'https://example.com/with space']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_initial_url(value)
        self.assertEqual(validate_initial_url('http://127.0.0.1:8080/test'),
                         'http://127.0.0.1:8080/test')

    def test_action_fields_are_strict_and_waits_coordinates_keys_are_bounded(self):
        from worker import validate_action
        for action in [{'kind': 'invoke', 'element': 'r', 'text': 'unrelated'},
                       {'kind': 'runScript', 'text': 'evil'},
                       {'kind': 'click', 'x': math.nan, 'y': 1},
                       {'kind': 'wait', 'amount': 5001},
                       {'kind': 'keypress', 'keys': ['NotAKey']},
                       {'kind': 'setValue', 'element': 'r', 'text': 'x' * 4001}]:
            with self.subTest(action=action), self.assertRaises(ValueError):
                validate_action(action)
        self.assertEqual(validate_action({'kind': 'wait', 'amount': 1}),
                         {'kind': 'wait', 'amount': 1})

    def test_exact_rust_flat_actions_normalize_nulls_and_integral_amounts(self):
        from worker import validate_action
        nullable = dict.fromkeys(['element', 'text', 'url', 'keys', 'x', 'y',
                                  'endX', 'endY', 'direction', 'amount'])
        for action in [{'kind': 'invoke', 'element': 'r'},
                       {'kind': 'select', 'element': 'r', 'text': 'b'},
                       {'kind': 'wait', 'amount': 1000.0},
                       {'kind': 'scroll', 'direction': 'down', 'amount': 600.0}]:
            with self.subTest(action=action):
                self.assertEqual(validate_action({**nullable, **action}), action)
        self.assertIs(type(validate_action({**nullable, 'kind': 'wait', 'amount': 1000.0})['amount']), int)
        for action in [{**nullable, 'kind': 'invoke', 'element': 'r', 'surprise': None},
                       {**nullable, 'kind': 'invoke', 'element': 'r', 'text': 'unrelated'},
                       {**nullable, 'kind': 'scroll', 'direction': 'down', 'amount': 3001.0},
                       {**nullable, 'kind': 'wait', 'amount': 0.5},
                       {**nullable, 'kind': 'wait', 'amount': True},
                       {**nullable, 'kind': 'wait', 'amount': math.inf}]:
            with self.subTest(action=action), self.assertRaises(ValueError):
                validate_action(action)

    def test_manifest_rejects_full_desktop_extra_apps_and_mutable_launch(self):
        from worker import validate_manifest
        target = {'kind': 'window', 'pid': 1, 'windowId': 2,
                  'executable': str(ROOT / 'fixture.exe')}
        base = {'version': 3, 'expires_after': '10m', 'idle_timeout': '2m',
                'allow': {'tools': ['get_window_state', 'click']}, 'resources': {
                    'apps': [{'executable': target['executable'], 'launch': False,
                              'windows': 'all', 'terminate': 'driver_launched'}],
                    'desktop': {'display': False}}}
        validate_manifest(base, target)
        for change in ['desktop', 'launch', 'extraApp', 'extraTool']:
            candidate = json.loads(json.dumps(base))
            resources = candidate['resources']
            if change == 'desktop':
                resources['desktop']['display'] = True
            elif change == 'launch':
                resources['apps'][0]['launch'] = True
            elif change == 'extraApp':
                resources['apps'].append(resources['apps'][0].copy())
            else:
                candidate['allow']['tools'].append('get_desktop_state')
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_manifest(candidate, target)

    def test_background_escalation_never_becomes_confirmation(self):
        from worker import map_cua_result
        for payload in [{'effect': 'confirmed', 'route': 'win32',
                         'escalation': {'reason': 'needsForeground'}},
                        {'effect': 'confirmed', 'route': 'foreground'},
                        {'effect': 'partial', 'route': 'accessibility', 'error': True}]:
            result = map_cua_result(payload)
            self.assertEqual(result['effect'], 'unverifiable')
            self.assertFalse(result['verified'])
        refused = map_cua_result({'effect': 'refused', 'route': 'accessibility'})
        self.assertEqual(refused['effect'], 'unverifiable')
        self.assertEqual(refused['detail'], 'backgroundExecutionUncertain')

    def test_dispatched_window_receipts_stay_uncertain_despite_matching_readback(self):
        import asyncio
        from types import SimpleNamespace as Object
        from unittest.mock import patch
        from window_executor import WindowSession
        from worker import Executor

        class Driver:
            def __init__(self, receipt):
                self.receipt = receipt
                self.inputs = 0
                self.value = 'before'

            async def call_tool(self, name, raw):
                arguments = json.loads(raw)
                if name == 'set_value':
                    if arguments != {'pid': 1, 'window_id': 2, 'delivery_mode': 'background',
                                     'element_token': 'token', 'value': 'delivered'}:
                        raise AssertionError('Unexpected input arguments')
                    self.inputs += 1
                    self.value = 'delivered'
                    return Object(action=None, is_error=False,
                                  structured_json=json.dumps(self.receipt), raw_json='')
                if name != 'get_window_state':
                    raise AssertionError('Unexpected SDK operation')
                return Object(is_error=False, degraded=False, structured_json=json.dumps({
                    'pid': 1, 'window_id': 2, 'window_title': 'Fixture',
                    'window_bounds': {'width': 800, 'height': 600}, 'elements': [{
                        'role': 'Edit', 'label': 'Owned', 'element_index': 1,
                        'element_token': 'token', 'enabled': True,
                        'actions': ['set_value'], 'value': self.value}]}), raw_json='')

        receipts = [
            {'effect': 'refused', 'route': 'accessibility'},
            {'effect': 'confirmed', 'route': 'accessibility', 'refusal': 'policy'},
            {'effect': 'confirmed', 'route': 'accessibility', 'escalation': {'reason': 'foreground'}},
            {'effect': 'confirmed', 'route': 'accessibility', 'delivery': {'mode': 'foreground'}},
            {'effect': 'confirmed', 'route': 'accessibility', 'delivery': {'mode': 'unknown'}},
            {},
            {'effect': 'unknown', 'route': 'accessibility'},
            {'effect': 'confirmed', 'route': 'unknown'},
        ]
        for receipt in receipts:
            with self.subTest(receipt=receipt):
                session = WindowSession.__new__(WindowSession)
                session.target = {'pid': 1, 'windowId': 2}
                session.loop = asyncio.new_event_loop()
                session.driver = Driver(receipt)
                session.refs = {}
                executor = Executor()
                executor.identity = (str(uuid.uuid4()), 1)
                executor.session = session
                try:
                    with patch.object(session, 'check_target'):
                        before = executor.current = session.observe()
                        request = {'id': 1, 'runId': executor.identity[0], 'generation': 1,
                                   'type': 'act', 'snapshotId': before['snapshotId'],
                                   'action': {'kind': 'setValue',
                                              'element': before['elements'][0]['ref'], 'text': 'delivered'}}
                        response = executor.dispatch(request)
                        self.assertTrue(response['ok'], response)
                        self.assertEqual(response['observation']['elements'][0]['value'], 'delivered')
                        self.assertEqual(response['result']['effect'], 'unverifiable')
                        self.assertEqual(response['result']['detail'], 'backgroundExecutionUncertain')
                        self.assertFalse(response['result']['verified'])
                        self.assertEqual(executor.dispatch(request), response)
                        self.assertEqual(session.driver.inputs, 1)
                finally:
                    session.loop.close()

    def test_native_receipt_escalation_survives_transport_envelope(self):
        from types import SimpleNamespace as Object
        from window_executor import sdk_result_payload
        from worker import map_cua_result
        response = Object(structured_json='{}', raw_json='{}', is_error=False,
            action=Object(effect=Object(name='CONFIRMED'), route=Object(name='SYSTEM_API'),
                          escalation=Object(reason='requiresForeground'), error=None, delivery=None))
        result = map_cua_result(sdk_result_payload(response))
        self.assertEqual(result['effect'], 'unverifiable')
        self.assertEqual(result['route'], 'win32')
        self.assertFalse(result['verified'])

    def test_typed_native_uia_delivery_sentinels_require_independent_readback(self):
        from types import SimpleNamespace as Object
        from cua_driver import ActionDeliveryMode, ActionEffect, ActionRoute
        from window_executor import sdk_result_payload
        from worker import map_cua_result
        for mode in [ActionDeliveryMode.UNKNOWN, ActionDeliveryMode.NOT_APPLICABLE]:
            with self.subTest(mode=mode):
                response = Object(is_error=False, action=Object(
                    effect=ActionEffect.UNVERIFIABLE, route=ActionRoute.ACCESSIBILITY,
                    escalation=None, error=None, delivery=Object(mode=mode)))
                result = map_cua_result(sdk_result_payload(response))
                self.assertEqual(result['effect'], 'unverifiable')
                self.assertFalse(result['verified'])
                self.assertNotIn('detail', result)
                response.action.effect = ActionEffect.REFUSED
                refused = map_cua_result(sdk_result_payload(response))
                self.assertEqual(refused['detail'], 'backgroundExecutionUncertain')
                self.assertEqual(refused['effect'], 'unverifiable')

    def test_unproven_native_keyboard_routes_refuse_before_sdk_dispatch(self):
        from unittest.mock import Mock
        from window_executor import WindowSession
        for action in [{'kind': 'keypress', 'keys': ['Control', 'w']},
                       {'kind': 'keypress', 'element': 'r', 'keys': ['Enter']},
                       {'kind': 'type', 'element': 'r', 'text': 'owned'},
                       {'kind': 'scroll', 'x': 30, 'y': 40, 'direction': 'down', 'amount': 120},
                       {'kind': 'invoke', 'element': 'r'},
                       {'kind': 'click', 'x': 30, 'y': 40}]:
            with self.subTest(action=action):
                session = WindowSession.__new__(WindowSession)
                session.check_target = Mock()
                session.refs = {'r': {'token': 'token', 'descriptor': ('Edit', 'Owned', 1), 'actions': ['setValue']}}
                session.target = {'pid': 1, 'windowId': 2}
                session.driver = Mock()
                session.call = Mock(side_effect=AssertionError('Unsafe route entered SDK'))
                result = session.act(action, {})
                self.assertEqual(result['effect'], 'refused')
                self.assertEqual(result['detail'], 'backgroundUnavailable')
                session.call.assert_not_called()
                session.driver.call_tool.assert_not_called()


class EdgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}/'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        from worker import Executor
        self.executor = Executor()
        self.identity = {'runId': str(uuid.uuid4()), 'generation': 1}
        self.next_id = 1
        response = self.command('begin', target={'kind': 'browser', 'initialUrl': self.url,
                                                'headless': True})
        self.assertTrue(response['ok'], response)

    def tearDown(self):
        self.executor.close()

    def command(self, kind, **kwargs):
        request = {'id': self.next_id, **self.identity, 'type': kind, **kwargs}
        self.next_id += 1
        return self.executor.dispatch(request)

    def element(self, observation, name):
        return next(item for item in observation['elements'] if item['name'] == name)

    def test_semantic_set_value_reads_back_without_screenshot(self):
        before = self.command('observe')['observation']
        after = self.command('act', snapshotId=before['snapshotId'],
                             action={**dict.fromkeys(['element', 'text', 'url', 'keys', 'x', 'y',
                                                     'endX', 'endY', 'direction', 'amount']),
                                     'kind': 'setValue', 'element': self.element(before, 'Message')['ref'], 'text': 'after'})
        self.assertTrue(after['ok'], after)
        self.assertEqual(after['result']['effect'], 'confirmed')
        self.assertTrue(after['result']['verified'])
        self.assertEqual(self.element(after['observation'], 'Message')['value'], 'after')
        self.assertNotIn('screenshot', before)
        self.assertNotIn('screenshot', after['observation'])
        self.assertNotIn('protected-secret', json.dumps(before))

    def test_frame_refs_keep_their_own_frame_identity(self):
        before = self.command('observe')['observation']
        after = self.command('act', snapshotId=before['snapshotId'],
                             action={'kind': 'setValue', 'element': self.element(before, 'Frame message')['ref'], 'text': 'frame after'})
        self.assertEqual(after['result']['effect'], 'confirmed', after)
        self.assertEqual(self.element(after['observation'], 'Frame message')['value'], 'frame after')
        self.assertEqual(self.element(after['observation'], 'Message')['value'], 'before')

    def test_verified_set_value_observes_oninput_history_url_change(self):
        self.executor.session.page.locator('#entry').evaluate(
            "(e)=>e.addEventListener('input',()=>history.pushState({},'', '/submitted'))")
        before = self.command('observe')['observation']
        after = self.command('act', snapshotId=before['snapshotId'],
            action={'kind': 'setValue', 'element': self.element(before, 'Message')['ref'], 'text': 'submitted'})
        self.assertTrue(after['ok'], after)
        self.assertTrue(after['result']['verified'], after)
        self.assertEqual(after['result']['effect'], 'confirmed')
        self.assertEqual(before['url'], self.url)
        self.assertEqual(after['observation']['url'], self.url + 'submitted')
        self.assertEqual(self.element(after['observation'], 'Message')['value'], 'submitted')

    def test_select_reads_selected_value(self):
        before = self.command('observe')['observation']
        after = self.command('act', snapshotId=before['snapshotId'],
                             action={'kind': 'select', 'element': self.element(before, 'Choice')['ref'], 'text': 'b'})
        self.assertTrue(after['result']['verified'], after)
        self.assertEqual(self.element(after['observation'], 'Choice')['value'], 'b')

    def test_visual_type_uses_current_snapshot_focus_and_exact_selection_readback(self):
        field = self.executor.session.page.locator('#entry')
        field.evaluate('(e)=>{e.focus();e.setSelectionRange(1,4)}')
        before = self.command('observe')['observation']
        typed = self.command('act', snapshotId=before['snapshotId'], action={'kind': 'type', 'text': 'owned'})
        self.assertTrue(typed['ok'], typed)
        self.assertTrue(typed['result']['verified'], typed)
        self.assertEqual(self.element(typed['observation'], 'Message')['value'], 'bownedre')
        self.assertNotIn('screenshot', typed['observation'])

    def test_visual_type_keeps_focused_frame_identity_and_refuses_protected_or_new_controls(self):
        page = self.executor.session.page
        framed = page.frame_locator('iframe').get_by_label('Frame message')
        framed.evaluate('(e)=>{e.focus();e.setSelectionRange(0,5)}')
        before = self.command('observe')['observation']
        typed = self.command('act', snapshotId=before['snapshotId'], action={'kind': 'type', 'text': 'owned'})
        self.assertTrue(typed['ok'], typed)
        self.assertTrue(typed['result']['verified'], typed)
        self.assertEqual(self.element(typed['observation'], 'Frame message')['value'], 'owned before')
        self.assertEqual(self.element(typed['observation'], 'Message')['value'], 'before')
        page.get_by_label('Password').focus()
        protected = self.command('observe')['observation']
        refused = self.command('act', snapshotId=protected['snapshotId'], action={'kind': 'type', 'text': 'unsafe'})
        self.assertFalse(refused.get('result', {}).get('verified', False), refused)
        self.assertEqual(page.get_by_label('Password').input_value(), 'protected-secret')
        prior = self.command('observe')['observation']
        page.evaluate("()=>{const e=document.createElement('input');e.id='unobserved';e.value='untouched';document.body.append(e);e.focus()}")
        refused = self.command('act', snapshotId=prior['snapshotId'], action={'kind': 'type', 'text': 'unsafe'})
        self.assertFalse(refused.get('result', {}).get('verified', False), refused)
        self.assertEqual(page.locator('#unobserved').input_value(), 'untouched')

    def test_select_accepts_unique_option_label_and_confirms_observed_value(self):
        before = self.command('observe')['observation']
        after = self.command('act', snapshotId=before['snapshotId'],
            action={'kind': 'select', 'element': self.element(before, 'Choice')['ref'], 'text': 'Beta'})
        self.assertTrue(after['result']['verified'], after)
        self.assertEqual(self.element(after['observation'], 'Choice')['value'], 'b')

    def test_semantic_scroll_uses_bounded_pixels_without_screenshot(self):
        before = self.command('observe')['observation']
        response = self.command('act', snapshotId=before['snapshotId'],
            action={'kind': 'scroll', 'element': self.element(before, 'Scroll fixture')['ref'],
                    'direction': 'down', 'amount': 600.0})
        self.assertTrue(response['ok'], response)
        self.assertEqual(self.executor.session.page.locator('[aria-label="Scroll fixture"]').evaluate('(e)=>e.scrollTop'), 600)
        self.assertNotIn('screenshot', response['observation'])
        self.assertFalse(response['result']['verified'])

    def test_noop_invoke_is_not_confirmed(self):
        before = self.command('observe')['observation']
        response = self.command('act', snapshotId=before['snapshotId'],
                                action={'kind': 'invoke', 'element': self.element(before, 'No effect')['ref']})
        self.assertIn(response['result']['effect'], ['suspectedNoop', 'unverifiable'])
        self.assertFalse(response['result']['verified'])

    def test_old_snapshot_ref_and_identity_never_repeat_input(self):
        old = self.command('observe')['observation']
        current = self.command('observe')['observation']
        stale = self.command('act', snapshotId=old['snapshotId'],
                             action={'kind': 'setValue', 'element': self.element(old, 'Message')['ref'], 'text': 'bad'})
        self.assertEqual(stale['error']['code'], 'staleSnapshot')
        stale_ref = self.command('act', snapshotId=current['snapshotId'],
                                 action={'kind': 'setValue', 'element': self.element(old, 'Message')['ref'], 'text': 'bad'})
        self.assertEqual(stale_ref['error']['code'], 'staleSnapshot')
        wrong = self.executor.dispatch({'id': 99, 'runId': str(uuid.uuid4()), 'generation': 1,
                                        'type': 'observe'})
        self.assertFalse(wrong['ok'])
        self.assertEqual(self.element(self.command('observe')['observation'], 'Message')['value'], 'before')

    def test_duplicate_command_id_returns_cached_outcome(self):
        before = self.command('observe')['observation']
        request = {'id': self.next_id, **self.identity, 'type': 'act', 'snapshotId': before['snapshotId'],
                   'action': {'kind': 'setValue', 'element': self.element(before, 'Message')['ref'], 'text': 'once'}}
        response = self.executor.dispatch(request)
        self.assertTrue(response['ok'], response)
        self.assertEqual(self.executor.dispatch(request), response)
        changed = {**request, 'action': {**request['action'], 'text': 'twice'}}
        self.assertFalse(self.executor.dispatch(changed)['ok'])
        self.next_id += 1
        self.assertEqual(self.element(self.command('observe')['observation'], 'Message')['value'], 'once')

    def test_malformed_post_input_receipt_is_uncertain_and_cannot_replay(self):
        from unittest.mock import patch
        before = self.command('observe')['observation']
        request = {'id': self.next_id, **self.identity, 'type': 'act', 'snapshotId': before['snapshotId'],
                   'action': {'kind': 'setValue', 'element': self.element(before, 'Message')['ref'], 'text': 'delivered'}}
        with patch.object(self.executor.session, 'verify', side_effect=ValueError('malformed post-input metadata')):
            response = self.executor.dispatch(request)
        self.assertEqual(response['error']['code'], 'workerError')
        field = self.executor.session.page.get_by_label('Message', exact=True)
        self.assertEqual(field.input_value(), 'delivered')
        field.fill('user edit after uncertain input')
        self.assertEqual(self.executor.dispatch(request), response)
        self.assertEqual(field.input_value(), 'user edit after uncertain input')
        self.next_id += 1

    def test_coordinate_input_requires_current_image_and_never_auto_confirms(self):
        before = self.command('observe')['observation']
        action = {'kind': 'click', 'x': 1, 'y': 1}
        response = self.command('act', snapshotId=before['snapshotId'], action=action)
        self.assertEqual(response['error']['code'], 'staleSnapshot')
        image = self.command('observe', screenshot=True)['observation']
        self.assertEqual(image['screenshot']['mimeType'], 'image/png')
        self.assertGreater(image['width'], 0)
        response = self.command('act', snapshotId=image['snapshotId'], action=action)
        self.assertFalse(response['result']['verified'])

    def test_unknown_command_fields_and_ended_session_are_refused(self):
        bad = self.command('observe', surprise='no')
        self.assertFalse(bad['ok'])
        self.assertTrue(self.command('end')['ok'])
        self.assertFalse(self.command('observe')['ok'])

    def test_new_run_rejects_cached_observation_from_retired_identity(self):
        request = {'id': self.next_id, **self.identity, 'type': 'observe'}
        self.assertTrue(self.executor.dispatch(request)['ok'])
        self.next_id += 1
        self.identity = {'runId': str(uuid.uuid4()), 'generation': 2}
        self.assertTrue(self.command('begin', target={'kind': 'browser', 'initialUrl': self.url, 'headless': True})['ok'])
        retired = self.executor.dispatch(request)
        self.assertFalse(retired['ok'])
        self.assertEqual(retired['error']['code'], 'targetUnavailable')


if __name__ == '__main__':
    unittest.main()
