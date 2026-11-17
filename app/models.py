"""Collection names, indexes and first-run defaults for the DMS."""
import logging

from pymongo import ASCENDING, DESCENDING
from pymongo.errors import PyMongoError

from .db import get_db

log = logging.getLogger(__name__)

USERS = "users"
DIVISIONS = "divisions"
METADATA_FIELDS = "metadata_fields"
DOCUMENTS = "documents"
ACCESS_REQUESTS = "access_requests"

DEFAULT_DIVISIONS = ("Division A", "Division B")

DEFAULT_METADATA_FIELDS = (
    {
        "key": "Report Type",
        "label": "Report Type",
        "type": "select",
        "options": ["Financial", "HR", "Technical", "Legal", "Operations"],
        "required": False,
        "order": 1,
    },
    {
        "key": "Author",
        "label": "Author",
        "type": "text",
        "options": [],
        "required": False,
        "order": 2,
    },
    {
        "key": "Document Date",
        "label": "Document Date",
        "type": "date",
        "options": [],
        "required": False,
        "order": 3,
    },
)


def ensure_indexes(db) -> None:
    db[USERS].create_index([("email", ASCENDING)], unique=True, name="uniq_email")
    db[DIVISIONS].create_index([("name", ASCENDING)], unique=True, name="uniq_name")
    db[METADATA_FIELDS].create_index([("key", ASCENDING)], unique=True, name="uniq_key")
    db[DOCUMENTS].create_index(
        [("division", ASCENDING), ("created_at", DESCENDING)], name="division_recent"
    )
    db[DOCUMENTS].create_index([("uploaded_by", ASCENDING)], name="uploader")
    db[ACCESS_REQUESTS].create_index(
        [("doc_id", ASCENDING), ("requester_id", ASCENDING), ("status", ASCENDING)],
        name="doc_requester_status",
    )
    db[ACCESS_REQUESTS].create_index(
        [("owner_division", ASCENDING), ("status", ASCENDING)], name="owner_inbox"
    )
    db[ACCESS_REQUESTS].create_index(
        [("requester_id", ASCENDING), ("created_at", DESCENDING)], name="requester_outbox"
    )


def ensure_defaults(db=None) -> None:
    """Create indexes and the default divisions/metadata fields if missing."""
    db = db if db is not None else get_db()
    try:
        ensure_indexes(db)
        for name in DEFAULT_DIVISIONS:
            db[DIVISIONS].update_one(
                {"name": name}, {"$setOnInsert": {"name": name}}, upsert=True
            )
        for field in DEFAULT_METADATA_FIELDS:
            db[METADATA_FIELDS].update_one(
                {"key": field["key"]},
                {"$setOnInsert": {**field, "system": False}},
                upsert=True,
            )
    except PyMongoError as exc:  # keep the app bootable; /api/health reports DB state
        log.warning("MongoDB not ready during startup: %s", exc)
