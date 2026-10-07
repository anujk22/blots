import json, os, subprocess, tempfile, selectors, time
from collections import deque
import mimetypes
from pathlib import Path
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk
from desktop import appearance, APPS
from pointer import move
from screen import start_screen, browser_command
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, body, code=200, kind='application/json'):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        screen = q.get('screen', ['1'])[0]
        if screen not in ['1', '2', '3', '4']:
            return self.reply({'error': 'Invalid screen'}, 400)
        if u.path == '/':
            with open('/opt/blots/home.html', 'rb') as f:
                return self.reply(f.read(), kind='text/html; charset=utf-8')
        if u.path == '/appearance':
            return self.reply(dict(**appearance(), apps=[dict(id=key, name=value['name']) for key, value in APPS.items() if key != 'terminal']))
        if u.path == '/avatar.png':
            avatar = appearance()['avatar']
            if avatar in ('blot', 'scout', 'quill'):
                return self.reply(Path(f'/opt/blots/avatars/{avatar}.png').read_bytes(), kind='image/png')
            return self.reply({'error': 'No portrait'}, 404)
        if u.path.startswith('/icons/'):
            key = u.path.removeprefix('/icons/').removesuffix('.png')
            if key in APPS:
                file = Path(APPS[key]['icon'])
                if not file.is_absolute():
                    theme = Gtk.IconTheme.new()
                    theme.set_custom_theme('Adwaita')
                    icon = theme.lookup_icon(APPS[key]['icon'], 48, 0)
                    file = Path(icon.get_filename()) if icon else None
                if file:
                    return self.reply(file.read_bytes(), kind=mimetypes.guess_type(file)[0] or 'image/png')
            return self.reply({'error': 'Icon not found'}, 404)
        if u.path == '/health':
            return self.reply({'ready': True, 'name': appearance()['name']})
        if u.path == '/screenshot':
            fd, filename = tempfile.mkstemp(suffix='.png'); os.close(fd)
            try:
                subprocess.run(['scrot', '--pointer', '-o', filename], env=dict(os.environ, DISPLAY=':'+screen), timeout=10, check=True, capture_output=True)
                with open(filename, 'rb') as f:
                    return self.reply(f.read(), kind='image/png')
            finally:
                os.unlink(filename)
        self.reply({'error': 'Not found'}, 404)

    def do_POST(self):
        try:
            origin = self.headers.get('Origin')
            if origin and origin not in ('http://127.0.0.1:8766', 'http://localhost:8766'):
                return self.reply({'error': 'Requests must come from Blots'}, 403)
            if int(self.headers.get('Content-Length', '0')) > 100000:
                return self.reply({'error': 'Request too large'}, 413)
            data = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
            screen = str(data.get('screen', 1))
            if screen not in ['1', '2', '3', '4']:
                raise ValueError('Invalid screen')
            env = dict(os.environ, DISPLAY=':'+screen)
            if self.path == '/screen':
                start_screen(int(screen))
                return self.reply({'ready': True})
            if self.path == '/launch':
                app = APPS.get(data.get('app'))
                if not app:
                    raise ValueError('Unknown application')
                command = app['command']
                if data['app'] == 'browser':
                    windows = subprocess.run(['xdotool', 'search', '--class', 'chromium'], env=env, capture_output=True, text=True).stdout.splitlines()
                    if windows:
                        subprocess.run(['xdotool', 'windowactivate', windows[-1]], env=env, check=True, capture_output=True)
                        return self.reply({'launched': 'browser'})
                    command = browser_command(int(screen))
                subprocess.Popen(command, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return self.reply({'launched': data['app']})
            if self.path == '/exec':
                command = data.get('command')
                if not isinstance(command, str) or len(command) > 20000:
                    raise ValueError('Invalid command')
                proc = subprocess.Popen(['/bin/bash', '-lc', command], env=env, cwd='/workspace', stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
                chunks = deque(maxlen=3)
                deadline, timed_out = time.monotonic()+30, False
                with selectors.DefaultSelector() as stream:
                    stream.register(proc.stdout, selectors.EVENT_READ)
                    try:
                        while stream.get_map():
                            remaining = deadline-time.monotonic()
                            if remaining <= 0:
                                raise subprocess.TimeoutExpired(command, 30)
                            for key, _ in stream.select(remaining):
                                chunk = os.read(key.fd, 32768)
                                if chunk:
                                    chunks.append(chunk)
                                else:
                                    stream.unregister(key.fileobj)
                        proc.wait(timeout=max(.001, deadline-time.monotonic()))
                    except subprocess.TimeoutExpired:
                        import signal
                        os.killpg(proc.pid, signal.SIGKILL)
                        proc.wait(); timed_out = True
                    finally:
                        proc.stdout.close()
                output = b''.join(chunks).decode(errors='replace')[-20000:]
                return self.reply({'output': output, 'exitCode': -1 if timed_out else proc.returncode, **({'error': 'Command exceeded 30 seconds'} if timed_out else {})})
            if self.path == '/input':
                kind = data.get('kind')
                if kind in ['click', 'move']:
                    x, y = int(data['x']), int(data['y'])
                    if not (0 <= x < 1280 and 0 <= y < 960):
                        raise ValueError('Click outside the screen')
                    move(':'+screen, x, y)
                    if kind == 'move':
                        return self.reply({'ok': True, 'x': x, 'y': y})
                    cmd = ['xdotool', 'click', '1']
                elif kind == 'type':
                    text = data.get('text', '')
                    if not isinstance(text, str) or len(text) > 20000:
                        raise ValueError('Invalid text')
                    cmd = ['xdotool', 'type', '--clearmodifiers', '--delay', '1', '--', text]
                elif kind == 'key':
                    key = data.get('key')
                    if key not in ['Return', 'Tab', 'Escape', 'BackSpace', 'ctrl+l', 'ctrl+a', 'ctrl+c', 'ctrl+v', 'ctrl+s', 'ctrl+shift+s', 'alt+F4', 'Up', 'Down', 'Left', 'Right']:
                        raise ValueError('Unsupported key')
                    cmd = ['xdotool', 'key', '--clearmodifiers', key]
                elif kind == 'scroll':
                    if data.get('direction') not in ['up', 'down']:
                        raise ValueError('Scroll direction must be up or down')
                    cmd = ['xdotool', 'click', '--repeat', '4', '4' if data.get('direction') == 'up' else '5']
                else:
                    raise ValueError('Unsupported input')
                subprocess.run(cmd, env=env, check=True, timeout=30 if kind == 'type' else 15, capture_output=True)
                return self.reply({'ok': True})
            self.reply({'error': 'Not found'}, 404)
        except Exception as e:
            self.reply({'error': str(e)}, 400)

server = ThreadingHTTPServer(('0.0.0.0', 8766), Handler)
import threading
threading.Thread(target=start_screen, args=(1,), daemon=True).start()
server.serve_forever()
