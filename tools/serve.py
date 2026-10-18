"""Live-reload dev server: serves the app and refreshes the page whenever a file is saved.

    python tools/serve.py [port]      (default port 5500)

Open http://127.0.0.1:5500 (in VS Code: Ctrl+Shift+P > "Simple Browser: Show").
It uses 127.0.0.1, not localhost, so app.js skips the service worker and nothing is served stale.
"""
import http.server
import os
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5500
WATCH = ('.html', '.css', '.js', '.webmanifest', '.png', '.gif', '.jpg', '.svg', '.mp3', '.wav', '.woff2')
SNIPPET = b"""<script>new EventSource('/__reload').onmessage = () => location.reload();</script>"""

changed = threading.Condition()
version = 0


def snapshot():
    stamps = {}
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if not d.startswith('.')]
        for name in filenames:
            if name.endswith(WATCH):
                path = os.path.join(dirpath, name)
                try:
                    stamps[path] = os.stat(path).st_mtime
                except OSError:
                    pass
    return stamps


def watch():
    global version
    last = snapshot()
    while True:
        time.sleep(0.4)
        now = snapshot()
        if now != last:
            last = now
            with changed:
                version += 1
                changed.notify_all()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/__reload':
            return self.stream_reloads()
        if path in ('/', '/index.html'):
            with open(os.path.join(ROOT, 'index.html'), 'rb') as f:
                body = f.read().replace(b'</body>', SNIPPET + b'</body>', 1)
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def stream_reloads(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        seen = version
        try:
            while True:
                with changed:
                    changed.wait(timeout=15)
                    current = version
                if current != seen:
                    seen = current
                    self.wfile.write(b'data: reload\n\n')
                else:
                    self.wfile.write(b': ping\n\n')
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    threading.Thread(target=watch, daemon=True).start()
    server = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    server.daemon_threads = True
    print(f'Live preview at http://127.0.0.1:{PORT}  (Ctrl+C to stop)')
    server.serve_forever()
