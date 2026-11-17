"""Seed demo users. Safe to re-run; existing accounts are left untouched."""
from werkzeug.security import generate_password_hash

from . import create_app
from .db import get_db
from .models import USERS, ensure_defaults
from .utils import utcnow

DEMO_USERS = [
    ("Admin", "admin@triad.ai", "admin123", "Division A", "admin"),
    ("Alice (Division A)", "alice@triad.ai", "alice123", "Division A", "user"),
    ("Bob (Division B)", "bob@triad.ai", "bob123", "Division B", "user"),
]


def main():
    app = create_app()
    with app.app_context():
        db = get_db()
        ensure_defaults(db)
        for name, email, password, division, role in DEMO_USERS:
            if db[USERS].find_one({"email": email}):
                print(f"= {email} already exists")
                continue
            db[USERS].insert_one(
                {
                    "name": name,
                    "email": email,
                    "password_hash": generate_password_hash(password),
                    "division": division,
                    "role": role,
                    "created_at": utcnow(),
                }
            )
            print(f"+ created {email} / {password} ({division}, {role})")
        print("Seed complete.")


if __name__ == "__main__":
    main()
