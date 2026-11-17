"""Shared helpers: serialization, RBAC queries and request validation."""
import base64
import re
from datetime import datetime, timezone
from functools import wraps

from bson import ObjectId
from bson.errors import InvalidId
from flask import jsonify, request

from .models import ACCESS_REQUESTS, DOCUMENTS

RESERVED_QUERY_KEYS = {
    "page", "per_page", "limit", "skip", "sort", "order", "division", "q",
    "archived", "include_archived",
}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(value):
    if not isinstance(value, datetime):
        return value
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat().replace("+00:00", "Z")


def oid(value):
    """Return an ObjectId or None for invalid input."""
    try:
        return ObjectId(str(value))
    except (InvalidId, TypeError):
        return None


def error(message, status=400, **extra):
    payload = {"success": False, "error": message}
    payload.update(extra)
    return jsonify(payload), status


def json_body(*, required=True):
    data = request.get_json(silent=True)
    if data is None and request.form:
        data = request.form.to_dict(flat=True)
    if data is None:
        if required:
            return None, error("request body must be JSON", 400)
        return {}, None
    if not isinstance(data, dict):
        return None, error("request body must be a JSON object", 400)
    return data, None


def clean_text(value) -> str:
    return re.sub(r"\s+", " ", str(value)).strip()


def normalize_metadata(raw) -> dict:
    if not isinstance(raw, dict):
        return {}
    normalized = {}
    for key, value in raw.items():
        key = clean_text(key)[:80]
        if not key:
            continue
        if isinstance(value, (list, tuple)):
            value = ", ".join(clean_text(v) for v in value)
        elif isinstance(value, bool):
            value = "true" if value else "false"
        elif value is not None:
            value = clean_text(value)
        else:
            value = ""
        normalized[key] = value[:2000]
    return normalized


def metadata_filters(args):
    """Every non-reserved query param is treated as a dynamic metadata filter."""
    filters = {}
    for key, value in args.items():
        if key in RESERVED_QUERY_KEYS or not value:
            continue
        filters[f"metadata.{key}"] = {
            "$regex": f"^{re.escape(value.strip())}$",
            "$options": "i",
        }
    return filters


def pagination(args):
    try:
        page = max(1, int(args.get("page", 1)))
    except (TypeError, ValueError):
        page = 1
    try:
        per_page = min(100, max(1, int(args.get("per_page") or args.get("limit") or 20)))
    except (TypeError, ValueError):
        per_page = 20
    return page, per_page, (page - 1) * per_page


def approved_doc_ids(db, user):
    cursor = db[ACCESS_REQUESTS].find(
        {"requester_id": user["_id"], "status": "approved"},
        {"doc_id": 1},
    )
    return [row["doc_id"] for row in cursor]


def accessible_filter(db, user):
    """Documents visible to a user: their division plus approved cross-division docs."""
    return {
        "$or": [
            {"division": user["division"]},
            {"_id": {"$in": approved_doc_ids(db, user)}},
        ]
    }


def has_download_access(db, doc, user) -> bool:
    if str(doc.get("uploaded_by") or "") == str(user["_id"]):
        return True
    if doc.get("division") == user["division"]:
        return True
    return (
        db[ACCESS_REQUESTS].count_documents(
            {
                "doc_id": doc["_id"],
                "requester_id": user["_id"],
                "status": "approved",
            },
            limit=1,
        )
        > 0
    )


def can_manage_document(doc, user) -> bool:
    """Uploaders and admins may archive or delete a document."""
    if user.get("role") == "admin":
        return True
    return bool(doc.get("uploaded_by")) and str(doc["uploaded_by"]) == str(user["_id"])


def request_map(db, user, doc_ids):
    """Map doc_id -> latest access request for this user (one query)."""
    if not doc_ids:
        return {}
    cursor = db[ACCESS_REQUESTS].find(
        {"requester_id": user["_id"], "doc_id": {"$in": list(doc_ids)}}
    ).sort("created_at", -1)
    latest = {}
    for row in cursor:
        latest.setdefault(row["doc_id"], row)
    return latest


def serialize_user(user) -> dict:
    return {
        "id": str(user["_id"]),
        "email": user["email"],
        "name": user.get("name", ""),
        "division": user.get("division", ""),
        "role": user.get("role", "user"),
        "created_at": iso(user.get("created_at")),
    }


def serialize_request(req) -> dict:
    return {
        "id": str(req["_id"]),
        "request_id": str(req["_id"]),
        "doc_id": str(req["doc_id"]),
        "doc_title": req.get("doc_title", ""),
        "requester_id": str(req.get("requester_id")),
        "requester_name": req.get("requester_name", ""),
        "requester_email": req.get("requester_email", ""),
        "requester_division": req.get("requester_division", ""),
        "owner_division": req.get("owner_division", ""),
        "status": req.get("status", "pending"),
        "created_at": iso(req.get("created_at")),
        "decided_at": iso(req.get("decided_at")),
        "decided_by": req.get("decided_by"),
        "decided_by_name": req.get("decided_by_name"),
        "note": req.get("note", ""),
    }


def serialize_document(
    doc,
    *,
    can_download=True,
    access_request=None,
    include_text=False,
    include_activity=False,
    can_manage=False,
):
    ocr_text = doc.get("ocr_text") or ""
    payload = {
        "id": str(doc["_id"]),
        "doc_id": str(doc["_id"]),
        "title": doc.get("title", ""),
        "filename": doc.get("filename", ""),
        "content_type": doc.get("content_type", ""),
        "size": doc.get("size", 0),
        "division": doc.get("division", ""),
        "metadata": doc.get("metadata", {}),
        "ocr_status": doc.get("ocr_status", "skipped"),
        "ocr_engine": doc.get("ocr_engine", ""),
        "ocr_excerpt": ocr_text[:280],
        "uploaded_by": str(doc["uploaded_by"]) if doc.get("uploaded_by") else None,
        "uploader_name": doc.get("uploader_name", ""),
        "created_at": iso(doc.get("created_at")),
        "archived": bool(doc.get("archived")),
        "has_download_access": bool(can_download),
        "can_manage": bool(can_manage),
        "request_status": access_request.get("status") if access_request else None,
        "request_id": str(access_request["_id"]) if access_request else None,
    }
    thumbnail = doc.get("thumbnail")
    if thumbnail:
        payload["thumbnail"] = "data:image/jpeg;base64," + base64.b64encode(thumbnail).decode()
    if include_text:
        payload["ocr_text"] = ocr_text
    if include_activity:
        payload["activity"] = [
            {
                "type": event.get("type", ""),
                "actor_name": event.get("actor_name", ""),
                "at": iso(event.get("at")),
                "detail": event.get("detail", ""),
            }
            for event in (doc.get("activity") or [])[-40:]
        ]
    return payload


def login_required(view):
    from flask import g

    @wraps(view)
    def wrapper(*args, **kwargs):
        from .auth import user_from_request

        user = user_from_request()
        if user is None:
            return error("authentication required", 401)
        g.user = user
        return view(*args, **kwargs)

    return wrapper


def admin_required(view):
    @wraps(view)
    @login_required
    def wrapper(*args, **kwargs):
        from flask import g

        if g.user.get("role") != "admin":
            return error("administrator privileges required", 403)
        return view(*args, **kwargs)

    return wrapper


def owned_document_or_404(db, doc_id):
    obj_id = oid(doc_id)
    if obj_id is None:
        return None
    return db[DOCUMENTS].find_one({"_id": obj_id})
