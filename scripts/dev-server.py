#!/usr/bin/env python3
"""Servidor local — sempre serve a RAIZ do projeto (fonte de verdade)."""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get('PORT', '8080'))
BUILD_STAMP = os.environ.get('MURAL_BUILD', 'dev-root')


class DevHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        self.send_header('X-Mural-Source', 'project-root')
        self.send_header('X-Mural-Build', BUILD_STAMP)
        super().end_headers()

    def log_message(self, format, *args):
        print(f"[mural-dev] {format % args}")


if __name__ == '__main__':
    os.chdir(ROOT)
    if os.path.basename(os.getcwd()) == 'www':
        raise SystemExit('ERRO: não execute o servidor dentro de www/. Use: npm run dev')
    server = ThreadingHTTPServer(('0.0.0.0', PORT), DevHandler)
    print(f'Mural DEV → http://localhost:{PORT}')
    print(f'Fonte: {ROOT}')
    print('A pasta www/ é só para Capacitor (npm run cap:sync). O navegador usa a raiz.')
    server.serve_forever()
