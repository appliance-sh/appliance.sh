import os
from datetime import datetime, timezone

from flask import Flask, jsonify, request

app = Flask(__name__)


@app.route("/", defaults={"_path": ""})
@app.route("/<path:_path>")
def index(_path):
    return jsonify(
        {
            "message": "Hello from demo-python-container!",
            "path": request.path,
            "method": request.method,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
