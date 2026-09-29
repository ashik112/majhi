"""majhi's Laya service. Started and stopped by the majhi host helper; not for direct use.

  layad.py serve      HTTP on 127.0.0.1 (random port), bearer token in MAJHI_LAYA_TOKEN.
                      Prints one JSON line {"ready": true, "port": N} when it listens.
  layad.py download   Fetches the model once and prints JSON progress lines.

Only the Python standard library is used besides laya_mlx and huggingface_hub, which the
helper installs into a private venv.
"""

import gc
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = os.environ.get("MAJHI_LAYA_MODEL", "aac6fef/laya-mlx")
IDLE_SECONDS = float(os.environ.get("MAJHI_LAYA_IDLE_SECONDS", "600"))
MAX_BODY = 256 * 1024
PATTERNS = [
    "model.safetensors",
    "rl_agent_config.json",
    "encoder/config.json",
    "tokenizer/*",
    "mlx_config.json",
]


def emit(**fields):
    sys.stdout.write(json.dumps(fields) + "\n")
    sys.stdout.flush()


def download():
    from huggingface_hub import snapshot_download
    from tqdm.auto import tqdm

    last = [0.0]

    class Bar(tqdm):
        def update(self, n=1):
            result = super().update(n)
            # Only the big weights file matters for progress. Report each whole percent.
            if self.unit == "B" and self.total and self.total >= 10_000_000:
                fraction = min(1.0, self.n / self.total)
                if fraction - last[0] >= 0.01:
                    last[0] = fraction
                    emit(progress=round(fraction, 2))
            return result

    emit(progress=0.0)
    snapshot_download(MODEL, allow_patterns=PATTERNS, tqdm_class=Bar)
    emit(done=True)


class Service:
    def __init__(self):
        self.agent = None
        self.lock = threading.Lock()
        self.last_used = time.time()

    def loaded(self):
        return self.agent is not None

    def predict(self, state, questions):
        with self.lock:
            self.last_used = time.time()
            load_ms = 0
            if self.agent is None:
                started = time.time()
                import laya_mlx as laya

                self.agent = laya.load(MODEL)
                load_ms = int((time.time() - started) * 1000)
            started = time.time()
            result = self.agent.predict(state, questions)
            predict_ms = (time.time() - started) * 1000
            self.last_used = time.time()
            return {"answers": result["answers"], "loadMs": load_ms, "predictMs": round(predict_ms, 1)}

    def unload_if_idle(self):
        with self.lock:
            if self.agent is None or time.time() - self.last_used < IDLE_SECONDS:
                return
            self.agent = None
            gc.collect()
            try:
                import mlx.core as mx

                mx.clear_cache()
            except Exception:
                pass


def serve():
    token = os.environ.get("MAJHI_LAYA_TOKEN", "")
    if not token:
        sys.stderr.write("MAJHI_LAYA_TOKEN is not set\n")
        sys.exit(2)
    service = Service()
    parent = os.getppid()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def authorized(self):
            return self.headers.get("authorization", "") == "Bearer " + token

        def do_GET(self):
            if not self.authorized():
                return self.send(401, {"error": "unauthorized"})
            if self.path == "/health":
                return self.send(200, {"loaded": service.loaded()})
            self.send(404, {"error": "not found"})

        def do_POST(self):
            if not self.authorized():
                return self.send(401, {"error": "unauthorized"})
            if self.path != "/predict":
                return self.send(404, {"error": "not found"})
            try:
                length = int(self.headers.get("content-length", "0"))
                if length <= 0 or length > MAX_BODY:
                    return self.send(413, {"error": "body too large"})
                body = json.loads(self.rfile.read(length))
                state, questions = body["state"], body["questions"]
                self.send(200, service.predict(state, questions))
            except Exception as err:  # reported to the caller as a plain message
                self.send(500, {"error": "%s: %s" % (type(err).__name__, err)})

    def watch():
        while True:
            time.sleep(5)
            if os.getppid() != parent:
                os._exit(0)
            service.unload_if_idle()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=watch, daemon=True).start()
    emit(ready=True, port=server.server_address[1])
    server.serve_forever()


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "serve":
        serve()
    elif mode == "download":
        download()
    else:
        sys.stderr.write(__doc__)
        sys.exit(2)
