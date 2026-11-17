"""Server-rendered page shells; data is loaded from the REST API by the UI."""
from flask import Blueprint, redirect, render_template, url_for

views_bp = Blueprint("views", __name__)


@views_bp.get("/")
def dashboard():
    return render_template("dashboard.html", active="dashboard")


@views_bp.get("/login")
def login():
    return render_template("login.html")


@views_bp.get("/register")
def register():
    return render_template("register.html")


@views_bp.get("/documents/<doc_id>")
def document_details(doc_id):
    return render_template("document.html", doc_id=doc_id, active="dashboard")


@views_bp.get("/requests")
def requests_inbox():
    return render_template("requests.html", active="requests")


@views_bp.get("/search")
def search_page():
    return render_template("search.html", active="search")


@views_bp.get("/admin/settings")
def admin_settings():
    return render_template("admin.html", active="admin")


@views_bp.get("/logout")
def logout():
    return redirect(url_for("views.login"))
