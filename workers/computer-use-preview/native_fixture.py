"""A disposable background Win32 fixture used only by local acceptance tests."""
import ctypes
import json
import os
import sys
import threading
from ctypes import wintypes

u = ctypes.WinDLL('user32', use_last_error=True)
u.CreateWindowExW.restype = wintypes.HWND
u.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR,
    wintypes.DWORD, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
    wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID]
u.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
u.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
u.DestroyWindow.argtypes = [wintypes.HWND]
u.GetForegroundWindow.restype = wintypes.HWND

class RawInputDevice(ctypes.Structure):
    _fields_ = [('usage_page', wintypes.USHORT), ('usage', wintypes.USHORT),
                ('flags', wintypes.DWORD), ('target', wintypes.HWND)]

class RawHeader(ctypes.Structure):
    _fields_ = [('kind', wintypes.DWORD), ('size', wintypes.DWORD),
                ('device', wintypes.HANDLE), ('parameter', wintypes.WPARAM)]

class RawMouse(ctypes.Structure):
    _fields_ = [('flags', wintypes.USHORT), ('buttons', wintypes.DWORD),
                ('raw_buttons', wintypes.DWORD), ('last_x', wintypes.LONG),
                ('last_y', wintypes.LONG), ('extra', wintypes.DWORD)]

u.RegisterRawInputDevices.argtypes = [ctypes.POINTER(RawInputDevice), wintypes.UINT, wintypes.UINT]
u.GetRawInputData.argtypes = [wintypes.HANDLE, wintypes.UINT, wintypes.LPVOID,
                            ctypes.POINTER(wintypes.UINT), wintypes.UINT]
u.GetRawInputData.restype = wintypes.UINT
u.PeekMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND,
                          wintypes.UINT, wintypes.UINT, wintypes.UINT]
raw_mouse_movements = 0

def record_mouse_input(message):
    global raw_mouse_movements
    size = wintypes.UINT()
    if u.GetRawInputData(message.lParam, 0x10000003, None, ctypes.byref(size), ctypes.sizeof(RawHeader)) != 0:
        return
    data = ctypes.create_string_buffer(size.value)
    if u.GetRawInputData(message.lParam, 0x10000003, data, ctypes.byref(size), ctypes.sizeof(RawHeader)) == 0xFFFFFFFF:
        return
    if size.value < ctypes.sizeof(RawHeader) + ctypes.sizeof(RawMouse):
        return
    header = RawHeader.from_buffer_copy(data)
    if header.kind == 0:
        mouse = RawMouse.from_buffer_copy(data, ctypes.sizeof(RawHeader))
        if mouse.last_x or mouse.last_y:
            raw_mouse_movements += 1

foreground = u.GetForegroundWindow()
hwnd = u.CreateWindowExW(0x08000000, 'STATIC', 'Lumen executor native fixture',
                        0x00CF0000, 100, 100, 420, 240, None, None, None, None)
u.CreateWindowExW(0, 'STATIC', 'Native message', 0x50000000,
                 15, 20, 120, 25, hwnd, None, None, None)
edit = u.CreateWindowExW(0, 'EDIT', 'native before', 0x50810080,
                         15, 50, 350, 30, hwnd, None, None, None)
u.CreateWindowExW(0, 'EDIT', 'native-protected-secret', 0x508100A0,
                 15, 90, 350, 30, hwnd, None, None, None)
u.CreateWindowExW(0, 'BUTTON', 'No effect', 0x50000000,
                 15, 135, 120, 30, hwnd, None, None, None)
u.ShowWindow(hwnd, 4)
input_window = u.CreateWindowExW(0x08000000, 'STATIC', 'Lumen owned input fixture',
    0x00CF0000, 550, 100, 320, 130, None, None, None, None)
input_edit = u.CreateWindowExW(0, 'EDIT', '', 0x50810080,
    15, 30, 270, 30, input_window, None, None, None)
u.ShowWindow(input_window, 4)
raw_device = RawInputDevice(1, 2, 0x100, hwnd)  # RIDEV_INPUTSINK observes mouse movement without activation.
if not u.RegisterRawInputDevices(ctypes.byref(raw_device), 1, ctypes.sizeof(raw_device)):
    raise ctypes.WinError(ctypes.get_last_error())
print(json.dumps({'pid': os.getpid(), 'windowId': hwnd, 'foreground': foreground,
                  'editId': edit, 'inputWindowId': input_window, 'inputEditId': input_edit,
                  'executable': sys._base_executable}), flush=True)

def stop():
    for command in sys.stdin:
        if command.strip() == 'mouse-state':
            u.PostMessageW(hwnd, 0x8002, 0, 0)
        else:
            u.PostMessageW(hwnd, 0x0012, 0, 0)
            return
    u.PostMessageW(hwnd, 0x0012, 0, 0)

threading.Thread(target=stop, daemon=True).start()
message = wintypes.MSG()
while u.GetMessageW(ctypes.byref(message), None, 0, 0) > 0:
    if message.message == 0x00FF:
        record_mouse_input(message)
    elif message.message == 0x8002:
        pending = wintypes.MSG()
        while u.PeekMessageW(ctypes.byref(pending), hwnd, 0x00FF, 0x00FF, 1):
            record_mouse_input(pending)
            u.DispatchMessageW(ctypes.byref(pending))
        print(json.dumps({'rawMouseMovements': raw_mouse_movements}), flush=True)
    u.TranslateMessage(ctypes.byref(message))
    u.DispatchMessageW(ctypes.byref(message))
u.DestroyWindow(hwnd)
u.DestroyWindow(input_window)
