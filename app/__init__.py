import logging

from flask import Flask, jsonify, render_template, request
from werkzeug.exceptions import HTTPException

from .config import Config


def create_app(config_object=Config, **overrides) -> Flask:
    app = Flask(__name__)
    app.config.from_object(config_object)
    app.config.update(overrides)

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )

    from .db import init_db

    init_db(app)

    from .models import ensure_defaults

    if app.config.get("SEED_DEFAULTS", True):
        with app.app_context():
            ensure_defaults()

    from .auth import auth_bp
    from .routes import api_bp
    from .views import views_bp

    app.register_blueprint(auth_bp)
    app.register_blueprint(api_bp)
    app.register_blueprint(views_bp)

    @app.errorhandler(HTTPException)
    def handle_http_error(exc: HTTPException):
        if request.path.startswith("/api"):
            return (
                jsonify(
                    {
                        "success": False,
                        "error": exc.description,
                        "status": exc.code,
                    }
                ),
                exc.code,
            )
        return render_template("error.html", code=exc.code, message=exc.description), exc.code

    @app.errorhandler(Exception)
    def handle_unexpected(exc: Exception):
        app.logger.exception("unhandled error")
        if request.path.startswith("/api"):
            return jsonify({"success": False, "error": "internal server error"}), 500
        return render_template("error.html", code=500, message="Internal server error"), 500

    return app
