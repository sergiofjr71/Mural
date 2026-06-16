#!/usr/bin/env python3
"""Servidor local com headers anti-cache para desenvolvimento."""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get('PORT', '8080'))


class NoCacheHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, format, *args):
        print(f"[dev-server] {self.address_string()} - {format % args}")


if __name__ == '__main__':
    os.chdir(ROOT)
    server = ThreadingHTTPServer(('0.0.0.0', PORT), NoCacheHandler)
    print(f'Mural dev server em http://localhost:{PORT} (sem cache)')
    server.serve_forever()
