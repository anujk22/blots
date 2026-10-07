import ctypes, math, time

X = ctypes.CDLL('libX11.so.6')
X.XInitThreads()
X.XOpenDisplay.argtypes = [ctypes.c_char_p]
X.XOpenDisplay.restype = ctypes.c_void_p
X.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
X.XDefaultRootWindow.restype = ctypes.c_ulong
X.XQueryPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_uint)]
X.XWarpPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint, ctypes.c_int, ctypes.c_int]
X.XFlush.argtypes = X.XCloseDisplay.argtypes = [ctypes.c_void_p]

def move(display_name, x, y):
    display = X.XOpenDisplay(display_name.encode())
    if not display:
        raise ValueError('The Linux display is unavailable')
    try:
        root = X.XDefaultRootWindow(display)
        returned, child = ctypes.c_ulong(), ctypes.c_ulong()
        sx, sy, wx, wy, mask = ctypes.c_int(), ctypes.c_int(), ctypes.c_int(), ctypes.c_int(), ctypes.c_uint()
        if not X.XQueryPointer(display, root, ctypes.byref(returned), ctypes.byref(child), ctypes.byref(sx), ctypes.byref(sy), ctypes.byref(wx), ctypes.byref(wy), ctypes.byref(mask)):
            raise ValueError('Could not read the Linux pointer')
        distance = math.hypot(x-sx.value, y-sy.value)
        if not distance:
            return
        duration = min(.95, max(.24, distance/1000))
        frames, start = math.ceil(duration*60), time.monotonic()
        for frame in range(1, frames+1):
            time.sleep(max(0, start+duration*frame/frames-time.monotonic()))
            t = frame/frames; t = t*t*(3-2*t)
            X.XWarpPointer(display, 0, root, 0, 0, 0, 0, round(sx.value+(x-sx.value)*t), round(sy.value+(y-sy.value)*t))
            X.XFlush(display)
    finally:
        X.XCloseDisplay(display)
