"""REST API for documents, access requests, search and administration."""
import io
import json
import logging
import os
import re

from bson.errors import InvalidId
from flask import Blueprint, current_app, g, jsonify, request, send_file
from pymongo.errors import DuplicateKeyError, PyMongoError
from werkzeug.utils import secure_filename

from .auth import user_from_request
from .db import get_db, get_fs
from .models import ACCESS_REQUESTS, DIVISIONS, DOCUMENTS, METADATA_FIELDS
from .ocr import make_thumbnail, process_file
from .utils import (
    accessible_filter,
    admin_required,
    can_manage_document,
    clean_text,
    error,
    has_download_access,
    iso,
    json_body,
    login_required,
    metadata_filters,
    normalize_metadata,
    oid,
    pagination,
    request_map,
    serialize_document,
    serialize_request,
    utcnow,
)

api_bp = Blueprint("api", __name__, url_prefix="/api")
log = logging.getLogger(__name__)

FIELD_TYPES = {"text", "textarea", "number", "date", "email", "select"}
ACTIVITY_LIMIT = 60


def _activity(kind: str, actor, detail: str = "") -> dict:
    return {
        "type": kind,
        "actor_name": (actor.get("name") or "Anonymous") if actor else "Anonymous",
        "at": utcnow(),
        "detail": detail,
    }


def _record_activity(db, doc_id, event: dict) -> None:
    db[DOCUMENTS].update_one(
        {"_id": doc_id},
        {"$push": {"activity": {"$each": [event], "$slice": -ACTIVITY_LIMIT}}},
    )


@api_bp.get("/health")
def health():
    try:
        get_db().client.admin.command("ping")
        return jsonify({"status": "ok", "database": "ok"})
    except PyMongoError as exc:
        return jsonify({"status": "degraded", "database": "unavailable", "error": str(exc)}), 503


# --------------------------------------------------------------------------- #
# Documents
# --------------------------------------------------------------------------- #
@api_bp.post("/documents/upload")
def upload_document():
    db, fs = get_db(), get_fs()
    user = user_from_request()
    if user is None and current_app.config["REQUIRE_AUTH_FOR_UPLOAD"]:
        return error("authentication required", 401)

    upload = request.files.get("file")
    if upload is None or not upload.filename:
        return error("a file is required (multipart field 'file')", 400)

    original_name = clean_text(upload.filename)
    extension = original_name.rsplit(".", 1)[-1].lower() if "." in original_name else ""
    if extension not in current_app.config["ALLOWED_EXTENSIONS"]:
        return error(
            "unsupported file type",
            400,
            allowed=sorted(current_app.config["ALLOWED_EXTENSIONS"]),
        )

    raw_metadata = request.form.get("metadata", "")
    if raw_metadata:
        try:
            raw_metadata = json.loads(raw_metadata)
        except json.JSONDecodeError:
            return error("metadata must be valid JSON", 400)
        if not isinstance(raw_metadata, dict):
            return error("metadata must be a JSON object", 400)
    else:
        raw_metadata = {}
    for key, value in request.form.items():
        if key in {"metadata", "file", "division"}:
            continue
        raw_metadata.setdefault(key, value)
    metadata = normalize_metadata(raw_metadata)

    division = metadata.get("Division") or request.form.get("division", "")
    division = clean_text(division)
    if user is not None:
        if division and division != user["division"]:
            return error("you can only upload documents to your own division", 403)
        division = user["division"]
    if not division:
        return error("division is required", 400)
    if not db[DIVISIONS].find_one({"name": division}):
        return error("unknown division", 400, division=division)
    metadata["Division"] = division

    data = upload.read()
    if not data:
        return error("uploaded file is empty", 400)

    filename = secure_filename(original_name) or f"upload.{extension}"
    title = clean_text(metadata.get("Title") or os.path.splitext(original_name)[0])
    ocr = process_file(data, filename)
    thumbnail = make_thumbnail(data, filename)

    try:
        gridfs_id = fs.upload_from_stream(
            filename,
            data,
            metadata={"content_type": upload.mimetype or "application/octet-stream"},
        )
    except PyMongoError as exc:
        log.exception("GridFS upload failed")
        return error("could not store file", 500, detail=str(exc))

    now = utcnow()
    doc = {
        "title": title,
        "filename": filename,
        "original_filename": original_name,
        "content_type": upload.mimetype or "application/octet-stream",
        "size": len(data),
        "division": division,
        "metadata": metadata,
        "ocr_text": ocr["text"],
        "ocr_status": ocr["status"],
        "ocr_engine": ocr["engine"],
        "thumbnail": thumbnail,
        "archived": False,
        "activity": [_activity("uploaded", user, filename)],
        "gridfs_id": gridfs_id,
        "uploaded_by": user["_id"] if user else None,
        "uploader_name": user.get("name", "") if user else "Anonymous",
        "created_at": now,
        "updated_at": now,
    }
    doc["search_text"] = " ".join(
        [
            title,
            filename,
            division,
            " ".join(metadata.keys()),
            " ".join(str(v) for v in metadata.values()),
            ocr["text"],
        ]
    )[:500000]

    try:
        result = db[DOCUMENTS].insert_one(doc)
    except PyMongoError as exc:
        fs.delete(gridfs_id)
        log.exception("document insert failed")
        return error("could not save document", 500, detail=str(exc))
    doc["_id"] = result.inserted_id

    payload = serialize_document(
        doc,
        can_download=user is not None,
        can_manage=user is not None,
    )
    return (
        jsonify(
            {
                "success": True,
                "message": "document uploaded",
                "id": str(doc["_id"]),
                "doc_id": str(doc["_id"]),
                "document": payload,
            }
        ),
        201,
    )


@api_bp.get("/documents")
@login_required
def list_documents():
    db = get_db()
    query = accessible_filter(db, g.user)

    archived = request.args.get("archived", "").strip().lower()
    include_archived = request.args.get("include_archived", "").strip().lower()
    if archived in {"1", "true", "yes"}:
        query = {"$and": [query, {"archived": True}]}
    elif include_archived not in {"1", "true", "yes"}:
        query = {"$and": [query, {"archived": {"$ne": True}}]}

    division = request.args.get("division", "").strip()
    if division:
        query = {"$and": [query, {"division": division}]}
    metadata_query = metadata_filters(request.args)
    if metadata_query:
        query = {"$and": [query, metadata_query]}

    sort_key = request.args.get("sort", "created_at")
    if sort_key not in {"created_at", "title", "size"}:
        sort_key = "created_at"
    direction = 1 if request.args.get("order") == "asc" else -1

    page, per_page, skip = pagination(request.args)
    total = db[DOCUMENTS].count_documents(query)
    cursor = (
        db[DOCUMENTS]
        .find(query)
        .sort(sort_key, direction)
        .skip(skip)
        .limit(per_page)
    )
    docs = list(cursor)
    requests_for_user = request_map(db, g.user, [doc["_id"] for doc in docs])

    items = [
        serialize_document(
            doc,
            can_download=has_download_access(db, doc, g.user),
            access_request=requests_for_user.get(doc["_id"]),
            can_manage=can_manage_document(doc, g.user),
        )
        for doc in docs
    ]
    return jsonify(
        {
            "success": True,
            "documents": items,
            "total": total,
            "page": page,
            "per_page": per_page,
            "pages": max(1, (total + per_page - 1) // per_page),
        }
    )


@api_bp.get("/documents/<doc_id>")
@login_required
def document_details(doc_id):
    db = get_db()
    doc = db[DOCUMENTS].find_one({"_id": oid(doc_id)})
    if doc is None:
        return error("document not found", 404)

    can_download = has_download_access(db, doc, g.user)
    latest = db[ACCESS_REQUESTS].find_one(
        {"doc_id": doc["_id"], "requester_id": g.user["_id"]},
        sort=[("created_at", -1)],
    )
    payload = serialize_document(
        doc,
        can_download=can_download,
        access_request=latest,
        include_text=can_download,
        include_activity=True,
        can_manage=can_manage_document(doc, g.user),
    )
    if not can_download:
        payload.pop("ocr_text", None)
        payload["ocr_excerpt"] = ""
    payload["can_download"] = can_download
    return jsonify({"success": True, "document": payload})


@api_bp.get("/documents/<doc_id>/download")
@login_required
def download_document(doc_id):
    db, fs = get_db(), get_fs()
    doc = db[DOCUMENTS].find_one({"_id": oid(doc_id)})
    if doc is None:
        return error("document not found", 404)
    if not has_download_access(db, doc, g.user):
        return error(
            "access denied: request access from this document's division",
            403,
            doc_id=str(doc["_id"]),
        )
    try:
        stream = fs.open_download_stream(doc["gridfs_id"])
        payload = stream.read()
    except Exception:
        log.exception("could not read GridFS file")
        return error("file not found in storage", 404)

    _record_activity(db, doc["_id"], _activity("downloaded", g.user, doc.get("filename", "")))
    return send_file(
        io.BytesIO(payload),
        mimetype=doc.get("content_type", "application/octet-stream"),
        as_attachment=True,
        download_name=doc.get("filename", "document"),
    )


@api_bp.post("/documents/<doc_id>/archive")
@login_required
def archive_document(doc_id):
    db = get_db()
    doc = db[DOCUMENTS].find_one({"_id": oid(doc_id)})
    if doc is None:
        return error("document not found", 404)
    if not can_manage_document(doc, g.user):
        return error("only the uploader or an administrator can archive this document", 403)

    data, err = json_body(required=False)
    if err:
        return err
    archived = data.get("archived", True)
    if isinstance(archived, str):
        archived = archived.strip().lower() in {"1", "true", "yes", "on"}
    else:
        archived = bool(archived)

    event = _activity("archived" if archived else "restored", g.user, doc.get("title", ""))
    db[DOCUMENTS].update_one(
        {"_id": doc["_id"]},
        {
            "$set": {"archived": archived, "updated_at": utcnow()},
            "$push": {"activity": {"$each": [event], "$slice": -ACTIVITY_LIMIT}},
        },
    )
    doc = db[DOCUMENTS].find_one({"_id": doc["_id"]})
    payload = serialize_document(
        doc,
        can_download=has_download_access(db, doc, g.user),
        include_text=True,
        include_activity=True,
        can_manage=True,
    )
    return jsonify({"success": True, "archived": archived, "document": payload})


@api_bp.delete("/documents/<doc_id>")
@login_required
def delete_document(doc_id):
    db, fs = get_db(), get_fs()
    doc = db[DOCUMENTS].find_one({"_id": oid(doc_id)})
    if doc is None:
        return error("document not found", 404)
    if not can_manage_document(doc, g.user):
        return error("only the uploader or an administrator can delete this document", 403)

    try:
        fs.delete(doc["gridfs_id"])
    except Exception:
        log.warning("could not delete GridFS file for %s", doc["_id"])
    db[ACCESS_REQUESTS].delete_many({"doc_id": doc["_id"]})
    db[DOCUMENTS].delete_one({"_id": doc["_id"]})
    return jsonify({"success": True, "message": "document deleted", "doc_id": str(doc["_id"])})


# --------------------------------------------------------------------------- #
# Cross-division access requests
# --------------------------------------------------------------------------- #
@api_bp.post("/access/request")
@login_required
def request_access():
    data, err = json_body()
    if err:
        return err
    doc_id = oid(data.get("doc_id"))
    if doc_id is None:
        return error("doc_id is required", 400)

    db = get_db()
    doc = db[DOCUMENTS].find_one({"_id": doc_id})
    if doc is None:
        return error("document not found", 404)
    if doc["division"] == g.user["division"]:
        return error("you already have access to this document", 400)

    existing = db[ACCESS_REQUESTS].find_one(
        {"doc_id": doc_id, "requester_id": g.user["_id"], "status": {"$in": ["pending", "approved"]}},
        sort=[("created_at", -1)],
    )
    if existing:
        return jsonify(
            {
                "success": True,
                "message": f"request already {existing['status']}",
                "request_id": str(existing["_id"]),
                "request": serialize_request(existing),
            }
        )

    req = {
        "doc_id": doc_id,
        "doc_title": doc.get("title", ""),
        "requester_id": g.user["_id"],
        "requester_name": g.user.get("name", ""),
        "requester_email": g.user["email"],
        "requester_division": g.user["division"],
        "owner_division": doc["division"],
        "status": "pending",
        "note": clean_text(data.get("note", ""))[:500],
        "created_at": utcnow(),
        "decided_at": None,
        "decided_by": None,
        "decided_by_name": None,
    }
    result = db[ACCESS_REQUESTS].insert_one(req)
    req["_id"] = result.inserted_id
    _record_activity(db, doc_id, _activity("access_requested", g.user, g.user.get("division", "")))
    return (
        jsonify(
            {
                "success": True,
                "message": "access request created",
                "request_id": str(req["_id"]),
                "request": serialize_request(req),
            }
        ),
        201,
    )


def _decide_request(action: str):
    data, err = json_body()
    if err:
        return err
    request_id = oid(data.get("request_id"))
    if request_id is None:
        return error("request_id is required", 400)
    if "action" in data:
        action = str(data.get("action", "")).strip().lower()

    if action not in {"approve", "reject"}:
        return error("action must be 'approve' or 'reject'", 400)
    status = "approved" if action == "approve" else "rejected"

    db = get_db()
    req = db[ACCESS_REQUESTS].find_one({"_id": request_id})
    if req is None:
        return error("access request not found", 404)
    doc = db[DOCUMENTS].find_one({"_id": req["doc_id"]})
    if doc is None:
        return error("document not found", 404)
    if g.user["division"] != doc["division"]:
        return error("only members of the owning division can decide this request", 403)
    if req.get("requester_id") == g.user["_id"]:
        return error("you cannot decide your own access request", 403)

    if req["status"] != "pending":
        if req["status"] == status:
            return jsonify({"success": True, "request": serialize_request(req)})
        return error(f"request already {req['status']}", 409)

    db[ACCESS_REQUESTS].update_one(
        {"_id": request_id},
        {
            "$set": {
                "status": status,
                "decided_at": utcnow(),
                "decided_by": str(g.user["_id"]),
                "decided_by_name": g.user.get("name", ""),
            }
        },
    )
    _record_activity(
        db,
        doc["_id"],
        _activity(
            "access_approved" if status == "approved" else "access_rejected",
            g.user,
            f"{req.get('requester_name', '')} ({req.get('requester_division', '')})",
        ),
    )
    req = db[ACCESS_REQUESTS].find_one({"_id": request_id})
    return jsonify(
        {
            "success": True,
            "message": f"request {status}",
            "request_id": str(request_id),
            "status": status,
            "request": serialize_request(req),
        }
    )


@api_bp.post("/access/approve")
@login_required
def approve_access():
    return _decide_request("approve")


@api_bp.post("/access/reject")
@login_required
def reject_access():
    return _decide_request("reject")


@api_bp.get("/access/requests")
@login_required
def list_access_requests():
    db = get_db()
    kind = request.args.get("type", "all").lower()
    incoming = {"owner_division": g.user["division"]}
    outgoing = {"requester_id": g.user["_id"]}

    if kind == "incoming":
        query = incoming
    elif kind == "outgoing":
        query = outgoing
    else:
        query = {"$or": [incoming, outgoing]}

    page, per_page, skip = pagination(request.args)
    total = db[ACCESS_REQUESTS].count_documents(query)
    rows = (
        db[ACCESS_REQUESTS]
        .find(query)
        .sort("created_at", -1)
        .skip(skip)
        .limit(per_page)
    )
    items = []
    for req in rows:
        item = serialize_request(req)
        item["can_decide"] = (
            req.get("status") == "pending"
            and req.get("owner_division") == g.user["division"]
            and req.get("requester_id") != g.user["_id"]
        )
        items.append(item)

    payload = {
        "success": True,
        "requests": items,
        "total": total,
        "pending_incoming": db[ACCESS_REQUESTS].count_documents(
            {"owner_division": g.user["division"], "status": "pending"}
        ),
        "pending_outgoing": db[ACCESS_REQUESTS].count_documents(
            {"requester_id": g.user["_id"], "status": "pending"}
        ),
    }
    return jsonify(payload)


# --------------------------------------------------------------------------- #
# Search
# --------------------------------------------------------------------------- #
def _snippet(doc, term: str, length: int = 220) -> str:
    lowered = term.lower()
    candidates = [
        doc.get("ocr_text", ""),
        doc.get("title", ""),
        " ".join(str(v) for v in doc.get("metadata", {}).values()),
    ]
    for text in candidates:
        if not text:
            continue
        idx = text.lower().find(lowered)
        if idx >= 0:
            start = max(0, idx - length // 3)
            end = min(len(text), idx + len(term) + length)
            snippet = text[start:end].strip()
            return ("…" if start > 0 else "") + snippet + ("…" if end < len(text) else "")
    return (doc.get("ocr_text") or "")[:length]


@api_bp.get("/search")
@login_required
def search_documents():
    db = get_db()
    term = clean_text(request.args.get("q", ""))
    if not term:
        return jsonify({"success": True, "query": "", "results": [], "documents": [], "total": 0})

    pattern = {"$regex": re.escape(term), "$options": "i"}
    query = {
        "$and": [
            accessible_filter(db, g.user),
            {"archived": {"$ne": True}},
            {"$or": [{"search_text": pattern}, {"title": pattern}, {"ocr_text": pattern}]},
        ]
    }
    division = request.args.get("division", "").strip()
    if division:
        query["$and"].append({"division": division})
    metadata_query = metadata_filters(request.args)
    if metadata_query:
        query["$and"].append(metadata_query)

    page, per_page, skip = pagination(request.args)
    per_page = min(per_page, 50)
    total = db[DOCUMENTS].count_documents(query)
    rows = (
        db[DOCUMENTS]
        .find(query)
        .sort("created_at", -1)
        .skip(skip)
        .limit(per_page)
    )

    results = []
    for doc in rows:
        item = serialize_document(
            doc, can_download=True, can_manage=can_manage_document(doc, g.user)
        )
        item["snippet"] = _snippet(doc, term)
        results.append(item)

    return jsonify(
        {
            "success": True,
            "query": term,
            "results": results,
            "documents": results,
            "total": total,
            "page": page,
            "per_page": per_page,
        }
    )


@api_bp.get("/stats")
@login_required
def workspace_stats():
    db = get_db()
    visible = {"$and": [accessible_filter(db, g.user), {"archived": {"$ne": True}}]}
    documents = db[DOCUMENTS].count_documents(visible)
    mine = db[DOCUMENTS].count_documents(
        {"$and": [{"uploaded_by": g.user["_id"]}, {"archived": {"$ne": True}}]}
    )
    ocr_indexed = db[DOCUMENTS].count_documents(
        {"$and": [visible, {"ocr_status": {"$in": ["extracted", "ocr"]}}]}
    )
    pending_incoming = db[ACCESS_REQUESTS].count_documents(
        {"owner_division": g.user["division"], "status": "pending"}
    )
    pending_outgoing = db[ACCESS_REQUESTS].count_documents(
        {"requester_id": g.user["_id"], "status": "pending"}
    )
    return jsonify(
        {
            "success": True,
            "stats": {
                "documents": documents,
                "my_documents": mine,
                "ocr_indexed": ocr_indexed,
                "ocr_coverage": round((ocr_indexed / documents) * 100) if documents else 0,
                "pending_incoming": pending_incoming,
                "pending_outgoing": pending_outgoing,
            },
        }
    )


# --------------------------------------------------------------------------- #
# Dynamic metadata fields & divisions (admin)
# --------------------------------------------------------------------------- #
def _serialize_field(field) -> dict:
    return {
        "id": str(field["_id"]),
        "key": field["key"],
        "label": field.get("label", field["key"]),
        "type": field.get("type", "text"),
        "options": field.get("options", []),
        "required": bool(field.get("required", False)),
        "order": field.get("order", 0),
        "system": bool(field.get("system", False)),
    }


def _validate_field_payload(data, *, partial=False):
    allowed = FIELD_TYPES
    key = clean_text(data.get("key", ""))
    label = clean_text(data.get("label", "")) or key
    field_type = str(data.get("type", "text")).lower()
    options = data.get("options") or []

    if not partial or "key" in data:
        if not key:
            return None, error("key is required", 400)
        if len(key) > 80:
            return None, error("key must be 80 characters or fewer", 400)
    if field_type not in allowed:
        return None, error("invalid field type", 400, allowed=sorted(allowed))
    if isinstance(options, str):
        options = [part.strip() for part in options.split(",") if part.strip()]
    if not isinstance(options, list) or not all(isinstance(o, str) for o in options):
        return None, error("options must be a list of strings", 400)
    if field_type == "select" and not options:
        return None, error("select fields need at least one option", 400)
    try:
        order = int(data.get("order", 0))
    except (TypeError, ValueError):
        return None, error("order must be an integer", 400)

    return {
        "key": key,
        "label": label,
        "type": field_type,
        "options": [clean_text(o)[:120] for o in options],
        "order": order,
        "required": bool(data.get("required", False)),
    }, None


@api_bp.get("/metadata-fields")
@login_required
def list_metadata_fields():
    rows = get_db()[METADATA_FIELDS].find().sort([("order", 1), ("key", 1)])
    return jsonify({"success": True, "fields": [_serialize_field(f) for f in rows]})


@api_bp.post("/metadata-fields")
@admin_required
def create_metadata_field():
    data, err = json_body()
    if err:
        return err
    payload, err = _validate_field_payload(data)
    if err:
        return err
    payload.update({"created_at": utcnow(), "system": False})
    try:
        result = get_db()[METADATA_FIELDS].insert_one(payload)
    except DuplicateKeyError:
        return error("a field with this key already exists", 409)
    payload["_id"] = result.inserted_id
    return jsonify({"success": True, "field": _serialize_field(payload)}), 201


@api_bp.put("/metadata-fields/<field_id>")
@admin_required
def update_metadata_field(field_id):
    data, err = json_body()
    if err:
        return err
    db = get_db()
    field = db[METADATA_FIELDS].find_one({"_id": oid(field_id)})
    if field is None:
        return error("field not found", 404)

    merged = {
        "key": data.get("key", field["key"]),
        "label": data.get("label", field.get("label")),
        "type": data.get("type", field.get("type", "text")),
        "options": data.get("options", field.get("options", [])),
        "order": data.get("order", field.get("order", 0)),
        "required": data.get("required", field.get("required", False)),
    }
    payload, err = _validate_field_payload(merged)
    if err:
        return err
    if payload["key"] != field["key"]:
        return error("field keys are immutable; create a new field instead", 400)

    db[METADATA_FIELDS].update_one({"_id": field["_id"]}, {"$set": payload})
    field = db[METADATA_FIELDS].find_one({"_id": field["_id"]})
    return jsonify({"success": True, "field": _serialize_field(field)})


@api_bp.delete("/metadata-fields/<field_id>")
@admin_required
def delete_metadata_field(field_id):
    db = get_db()
    field = db[METADATA_FIELDS].find_one({"_id": oid(field_id)})
    if field is None:
        return error("field not found", 404)
    db[METADATA_FIELDS].delete_one({"_id": field["_id"]})
    return jsonify({"success": True, "message": "field deleted"})


@api_bp.get("/divisions")
def list_divisions():
    rows = get_db()[DIVISIONS].find().sort("name", 1)
    return jsonify(
        {"success": True, "divisions": [{"id": str(d["_id"]), "name": d["name"]} for d in rows]}
    )


@api_bp.post("/divisions")
@admin_required
def create_division():
    data, err = json_body()
    if err:
        return err
    name = clean_text(data.get("name", ""))[:80]
    if not name:
        return error("division name is required", 400)
    try:
        result = get_db()[DIVISIONS].insert_one({"name": name, "created_at": utcnow()})
    except DuplicateKeyError:
        return error("division already exists", 409)
    return (
        jsonify(
            {
                "success": True,
                "division": {"id": str(result.inserted_id), "name": name},
            }
        ),
        201,
    )
