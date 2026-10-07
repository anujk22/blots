import os, subprocess, threading, time

_lock = threading.Lock()
_screens = set()

def browser_command(screen):
    return ['chromium', '--no-sandbox', '--test-type', '--disable-dev-shm-usage', '--no-first-run',
            '--hide-crash-restore-bubble', '--password-store=basic', '--disable-background-networking',
            '--disable-component-update', '--disk-cache-size=67108864',
            f'--remote-debugging-port={9220+screen}', f'--user-data-dir=/home/blots/profiles/s{screen}',
            '--window-size=1120,792', '--window-position=80,80', f'http://127.0.0.1:8766/?screen={screen}']

def start_screen(screen):
    with _lock:
        if screen in _screens:
            return
        env = dict(os.environ, DISPLAY=f':{screen}')
        processes = []
        def launch(command, label):
            with open(f'/tmp/{label}-{screen}.log', 'w') as log:
                processes.append(subprocess.Popen(command, env=env, stdout=log, stderr=log))
        try:
            launch(['Xvfb', f':{screen}', '-screen', '0', '1280x960x24', '-nolisten', 'tcp'], 'xvfb')
            for _ in range(50):
                if subprocess.run(['xdotool', 'getdisplaygeometry'], env=env, capture_output=True).returncode == 0:
                    break
                time.sleep(.05)
            else:
                raise ValueError('The Linux display did not start')
            launch(['xfwm4', '--compositor=off'], 'wm')
            launch(['x11vnc', '-display', f':{screen}', '-forever', '-shared', '-nopw', '-nocursorshape', '-nocursorpos', '-rfbport', str(5900+screen), '-quiet'], 'vnc')
            launch(['python3', '/opt/blots/desktop.py', str(screen)], 'dock')
            launch(browser_command(screen), 'chrome')
            launch(['socat', f'TCP-LISTEN:{9230+screen},fork,reuseaddr', f'TCP:127.0.0.1:{9220+screen}'], 'cdp')
            _screens.add(screen)
        except Exception:
            for process in processes:
                process.terminate()
            for process in processes:
                process.wait()
            raise
