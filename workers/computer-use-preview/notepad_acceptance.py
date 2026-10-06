"""Optional owned-document acceptance; preserves every Notepad tab/process."""
from __future__ import annotations

import ctypes
import json
import os
import subprocess
import tempfile
import time
import uuid
from ctypes import wintypes
from pathlib import Path

from worker import Executor
from window_executor import window_identity

ROOT = Path(__file__).resolve().parent


def processes():
    command = 'Get-Process -Name notepad -ErrorAction SilentlyContinue | Select-Object Id,Path | ConvertTo-Json -Compress'
    result = subprocess.run(['powershell', '-NoProfile', '-Command', command],
        capture_output=True, text=True, timeout=5, creationflags=subprocess.CREATE_NO_WINDOW)
    data = json.loads(result.stdout) if result.stdout.strip() else []
    return data if isinstance(data, list) else [data]


def fixture_window(pid, basename):
    user = ctypes.WinDLL('user32')
    user.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def visit(hwnd, _data):
        owner = wintypes.DWORD()
        user.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        title = ctypes.create_unicode_buffer(1024)
        user.GetWindowTextW(hwnd, title, 1024)
        if owner.value == pid and basename.lower() in title.value.lower():
            found.append(int(hwnd))
        return True

    user.EnumWindows(visit, 0)
    return found


def main():
    output = {'preExistingNotepad': bool(processes()), 'ownedFixture': False,
              'readback': False, 'effect': 'refused', 'detail': 'targetUnavailable',
              'foregroundPreservedDuringAction': None, 'ownedProcessClosed': False}
    if output['preExistingNotepad']:
        output['detail'] = 'existingNotepadPreserved'
        print(json.dumps(output))
        return
    (ROOT / '.build').mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='owned-notepad-', dir=ROOT / '.build') as directory:
        marker = 'Lumen owned local Notepad fixture'
        fixture = Path(directory) / 'lumen-owned-fixture.txt'
        fixture.write_text(marker, encoding='utf-8')
        if processes():  # Recheck immediately before launch.
            output['preExistingNotepad'] = True
            output['detail'] = 'existingNotepadPreserved'
            print(json.dumps(output))
            return
        launched_at = int((time.time() + 11644473600) * 10_000_000)
        subprocess.Popen([str(Path(os.environ['WINDIR']) / 'System32/notepad.exe'), str(fixture)])
        target = None
        for _attempt in range(30):
            matches = [(candidate, windows) for candidate in processes()
                       if candidate.get('Path')
                       and (windows := fixture_window(candidate['Id'], fixture.stem))]
            if len(matches) == 1 and len(matches[0][1]) == 1:
                candidate, windows = matches[0]
                target = {'kind': 'window', 'pid': candidate['Id'], 'windowId': windows[0],
                          'executable': candidate['Path']}
                break
            time.sleep(.2)
        if target is None:
            output['detail'] = 'ownedWindowCouldNotBeIdentified'
            print(json.dumps(output))
            return
        original_identity = window_identity(target)
        creation = (original_identity[1] << 32) | original_identity[2]
        if creation < launched_at - 10_000_000:
            output['detail'] = 'ownedProcessIdentityCouldNotBeProven'
            print(json.dumps(output))
            return
        output['ownedFixture'] = True
        manifest = Path(directory) / 'capability.json'
        manifest.write_text(json.dumps({'version': 3, 'expires_after': '10m', 'idle_timeout': '2m',
            'allow': {'tools': ['get_window_state', 'set_value', 'end_session']},
            'resources': {'apps': [{'executable': target['executable'], 'launch': False,
                'windows': 'all', 'terminate': 'driver_launched'}], 'desktop': {'display': False}}}))
        executor = Executor()
        identity = {'runId': str(uuid.uuid4()), 'generation': 1}
        command_id = 0

        def command(kind, **fields):
            nonlocal command_id
            command_id += 1
            return executor.dispatch({'id': command_id, **identity, 'type': kind, **fields})

        try:
            begin = command('begin', target=target, manifestPath=str(manifest))
            observed = command('observe') if begin['ok'] else begin
            if not observed['ok']:
                output['detail'] = observed['error']['code']
            else:
                observation = observed['observation']
                entries = [e for e in observation['elements'] if e.get('value') == marker]
                output['readback'] = len(entries) == 1
                output['observedElements'] = len(observation['elements'])
                output['degraded'] = observation.get('degraded', False)
                output['detail'] = 'backgroundUnavailable'
                if not observation.get('degraded') and len(entries) == 1 and 'setValue' in entries[0]['actions']:
                    user = ctypes.WinDLL('user32')
                    user.GetForegroundWindow.restype = ctypes.c_void_p
                    foreground = user.GetForegroundWindow()
                    response = command('act', snapshotId=observation['snapshotId'],
                        action={'kind': 'setValue', 'element': entries[0]['ref'], 'text': marker + ' verified'})
                    output['effect'] = response.get('result', {}).get('effect', 'refused')
                    output['detail'] = response.get('result', {}).get('detail', response.get('error', {}).get('code'))
                    output['foregroundPreservedDuringAction'] = user.GetForegroundWindow() == foreground
            command('end')
        finally:
            executor.close()
            # Window trees cannot prove absence of restored or newly opened tabs.
            # Keep the owned fixture document open rather than close a shared process.
            output['ownedDocumentLeftOpen'] = True
        path = ROOT / '.build/notepad-acceptance.json'
        path.write_text(json.dumps(output, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(output, indent=2))


if __name__ == '__main__':
    main()
