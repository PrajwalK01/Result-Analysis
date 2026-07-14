import os
from flask import Flask, render_template
from routes.login import login_bp
from routes.user  import user_bp
from routes.admin import admin_bp

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, "templates"),
    static_folder=os.path.join(BASE_DIR, "static"),
)

# SECRET_KEY must be set via env var in production.
# A dev fallback is only allowed when debug mode is on.
_secret = os.environ.get("SECRET_KEY", "")
if not _secret:
    if os.environ.get("FLASK_ENV") == "production":
        raise RuntimeError("SECRET_KEY environment variable must be set in production.")
    _secret = "dev-only-insecure-key-change-me"

app.secret_key = _secret

app.register_blueprint(login_bp)
app.register_blueprint(user_bp)
app.register_blueprint(admin_bp)


@app.route("/")
def home():
    return render_template("login.html")


@app.route("/login-page")
def login_page():
    return render_template("login.html")


if __name__ == "__main__":
    app.run(debug=True)
