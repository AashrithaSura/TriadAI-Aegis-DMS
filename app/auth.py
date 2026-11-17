"""JWT authentication: register, login and shared request helpers."""
import re
from datetime import timedelta

import jwt
from bson import ObjectId
from bson.errors import InvalidId
from flask import Blueprint, current_app, g, jsonify, request
from pymongo.errors import DuplicateKeyError
from werkzeug.security import check_password_hash, generate_password_hash

from .db import get_db
from .models import DIVISIONS, USERS
from .utils import error, iso, json_body, login_required, serialize_user, utcnow

auth_bp = Blueprint("auth", __name__, url_prefix="/api/auth")

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MIN_PASSWORD_LENGTH = 6


def create_token(user) -> str:
    expires = utcnow() + timedelta(hours=current_app.config["JWT_EXPIRES_HOURS"])
    payload = {
        "sub": str(user["_id"]),
        "email": user["email"],
        "division": user.get("division"),
        "role": user.get("role", "user"),
        "iat": utcnow(),
        "exp": expires,
    }
    return jwt.encode(
        payload, current_app.config["JWT_SECRET"], algorithm=current_app.config["JWT_ALGORITHM"]
    )


def user_from_request():
    header = request.headers.get("Authorization", "")
    if not header.lower().startswith("bearer "):
        return None
    token = header.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(
            token,
            current_app.config["JWT_SECRET"],
            algorithms=[current_app.config["JWT_ALGORITHM"]],
        )
        user_id = payload.get("sub")
        return get_db()[USERS].find_one({"_id": ObjectId(user_id)})
    except (jwt.PyJWTError, InvalidId, TypeError):
        return None


@auth_bp.post("/register")
def register():
    data, err = json_body()
    if err:
        return err

    name = str(data.get("name", "")).strip()[:120]
    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))
    division = str(data.get("division", "")).strip()

    if not name:
        return error("name is required", 400)
    if not EMAIL_RE.match(email):
        return error("a valid email is required", 400)
    if len(password) < MIN_PASSWORD_LENGTH:
        return error(f"password must be at least {MIN_PASSWORD_LENGTH} characters", 400)
    if not division:
        return error("division is required", 400)

    db = get_db()
    if not db[DIVISIONS].find_one({"name": division}):
        return error("unknown division", 400, division=division)

    role = "admin" if email in current_app.config["ADMIN_EMAILS"] else "user"
    user = {
        "name": name,
        "email": email,
        "password_hash": generate_password_hash(password),
        "division": division,
        "role": role,
        "created_at": utcnow(),
    }
    try:
        result = db[USERS].insert_one(user)
    except DuplicateKeyError:
        return error("an account with this email already exists", 409)
    user["_id"] = result.inserted_id
    token = create_token(user)
    return (
        jsonify({"success": True, "token": token, "access_token": token, "user": serialize_user(user)}),
        201,
    )


@auth_bp.post("/login")
def login():
    data, err = json_body()
    if err:
        return err

    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))
    if not email or not password:
        return error("email and password are required", 400)

    user = get_db()[USERS].find_one({"email": email})
    if not user or not check_password_hash(user["password_hash"], password):
        return error("invalid email or password", 401)

    token = create_token(user)
    return jsonify(
        {"success": True, "token": token, "access_token": token, "user": serialize_user(user)}
    )


@auth_bp.get("/me")
@login_required
def me():
    return jsonify({"success": True, "user": serialize_user(g.user)})
