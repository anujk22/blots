import json, os, subprocess, tempfile, time
import mimetypes
from pathlib import Path
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk
from desktop import appearance, APPS
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
                    command = ['chromium', '--no-sandbox', '--test-type', '--no-first-run', '--password-store=basic', '--user-data-dir=/home/blots/profiles/s'+screen, '--new-window', 'http://127.0.0.1:8766/?screen='+screen]
                subprocess.Popen(command, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return self.reply({'launched': data['app']})
            if self.path == '/exec':
                command = data.get('command')
                if not isinstance(command, str) or len(command) > 20000:
                    raise ValueError('Invalid command')
                proc = subprocess.Popen(['/bin/bash', '-lc', command], env=env, cwd='/workspace', stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
                try:
                    output, _ = proc.communicate(timeout=30)
                except subprocess.TimeoutExpired:
                    import signal
                    os.killpg(proc.pid, signal.SIGKILL)
                    output, _ = proc.communicate()
                    return self.reply({'output': output.decode(errors='replace')[-20000:], 'exitCode': -1, 'error': 'Command exceeded 30 seconds'})
                return self.reply({'output': output.decode(errors='replace')[-20000:], 'exitCode': proc.returncode})
            if self.path == '/input':
                kind = data.get('kind')
                if kind in ['click', 'move']:
                    x, y = int(data['x']), int(data['y'])
                    if not (0 <= x < 1280 and 0 <= y < 960):
                        raise ValueError('Click outside the screen')
                    position = subprocess.run(['xdotool', 'getmouselocation', '--shell'], env=env, check=True, capture_output=True, text=True).stdout
                    start = dict(line.split('=', 1) for line in position.splitlines())
                    for step in range(1, 17):
                        t = step / 16
                        t = t*t*(3-2*t)
                        px, py = round(int(start['X'])+(x-int(start['X']))*t), round(int(start['Y'])+(y-int(start['Y']))*t)
                        subprocess.run(['xdotool', 'mousemove', str(px), str(py)], env=env, check=True, capture_output=True)
                        time.sleep(0.02)
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
                    if key not in ['Return', 'Tab', 'Escape', 'BackSpace', 'ctrl+l', 'ctrl+a', 'ctrl+c', 'ctrl+v', 'alt+F4', 'Up', 'Down', 'Left', 'Right']:
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

ThreadingHTTPServer(('0.0.0.0', 8766), Handler).serve_forever()
