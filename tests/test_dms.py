import io
import json
import uuid

import pymupdf
import pytest

from app import create_app
from app.db import get_db
from app.models import (
    ACCESS_REQUESTS,
    DIVISIONS,
    DOCUMENTS,
    METADATA_FIELDS,
    USERS,
    ensure_defaults,
)

PASSWORD = "passw0rd"


@pytest.fixture(scope="session")
def app():
    db_name = f"triad_dms_test_{uuid.uuid4().hex[:10]}"
    application = create_app(
        MONGO_DB=db_name,
        TESTING=True,
        JWT_SECRET="test-secret-key-long-enough-for-hs256",
        SEED_DEFAULTS=True,
    )
    yield application
    client = application.extensions["mongo_client"]
    client.drop_database(db_name)
    client.close()


@pytest.fixture(autouse=True)
def fresh_database(app):
    with app.app_context():
        db = get_db()
        for name in (USERS, DIVISIONS, DOCUMENTS, ACCESS_REQUESTS, METADATA_FIELDS):
            db[name].delete_many({})
        db["documents.files"].delete_many({})
        db["documents.chunks"].delete_many({})
        ensure_defaults(db)
    yield


@pytest.fixture()
def client(app):
    return app.test_client()


def register(client, email, division="Division A", name="Test User"):
    response = client.post(
        "/api/auth/register",
        json={"name": name, "email": email, "password": PASSWORD, "division": division},
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def auth(token):
    return {"Authorization": f"Bearer {token}"}


def make_pdf(text):
    document = pymupdf.open()
    page = document.new_page()
    page.insert_text((72, 72), text, fontsize=12)
    data = document.tobytes()
    document.close()
    return data


def upload(
    client,
    token=None,
    *,
    division="Division A",
    metadata=None,
    filename="report.pdf",
    content=None,
    text="Confidential quarterly budget report",
):
    payload = {"Division": division, "Report Type": "Financial"}
    if metadata:
        payload.update(metadata)
    data = {
        "file": (
            io.BytesIO(content if content is not None else make_pdf(text)),
            filename,
        ),
        "metadata": json.dumps(payload),
    }
    headers = auth(token) if token else {}
    return client.post(
        "/api/documents/upload", data=data, content_type="multipart/form-data", headers=headers
    )


# --------------------------------------------------------------------------- #
# Authentication
# --------------------------------------------------------------------------- #
def test_register_login_and_me(client):
    created = register(client, "alice@example.com")
    assert created["user"]["division"] == "Division A"
    assert created["user"]["role"] == "user"
    assert created["token"]

    login = client.post(
        "/api/auth/login", json={"email": "alice@example.com", "password": PASSWORD}
    )
    assert login.status_code == 200
    token = login.get_json()["token"]

    me = client.get("/api/auth/me", headers=auth(token))
    assert me.status_code == 200
    assert me.get_json()["user"]["email"] == "alice@example.com"

    assert client.get("/api/auth/me").status_code == 401

    wrong = client.post(
        "/api/auth/login", json={"email": "alice@example.com", "password": "not-the-pass"}
    )
    assert wrong.status_code == 401

    duplicate = client.post(
        "/api/auth/register",
        json={
            "name": "Alice Again",
            "email": "alice@example.com",
            "password": PASSWORD,
            "division": "Division A",
        },
    )
    assert duplicate.status_code == 409

    unknown_division = client.post(
        "/api/auth/register",
        json={
            "name": "Zed",
            "email": "zed@example.com",
            "password": PASSWORD,
            "division": "Division Z",
        },
    )
    assert unknown_division.status_code == 400


# --------------------------------------------------------------------------- #
# Upload / RBAC
# --------------------------------------------------------------------------- #
def test_anonymous_upload_compatibility_and_auth_required_for_reading(client):
    response = upload(client)
    assert response.status_code == 201, response.get_json()
    body = response.get_json()
    assert body["doc_id"]
    assert body["document"]["division"] == "Division A"
    assert body["document"]["ocr_status"] in {
        "extracted",
        "ocr",
        "empty",
        "unavailable",
        "failed",
    }
    assert client.get("/api/documents").status_code == 401


def test_division_isolation(client):
    alice = register(client, "alice@example.com", "Division A")
    bob = register(client, "bob@example.com", "Division B")

    created = upload(client, alice["token"], metadata={"Title": "Board minutes"})
    assert created.status_code == 201
    doc_id = created.get_json()["doc_id"]

    alice_list = client.get("/api/documents", headers=auth(alice["token"])).get_json()
    assert alice_list["total"] == 1
    assert alice_list["documents"][0]["has_download_access"] is True

    bob_list = client.get("/api/documents", headers=auth(bob["token"])).get_json()
    assert bob_list["total"] == 0

    own_division = client.get(
        "/api/documents",
        query_string={"division": "Division A"},
        headers=auth(alice["token"]),
    ).get_json()
    assert own_division["total"] == 1

    other_division = client.get(
        "/api/documents",
        query_string={"division": "Division B"},
        headers=auth(alice["token"]),
    ).get_json()
    assert other_division["total"] == 0

    assert (
        client.get(f"/api/documents/{doc_id}/download", headers=auth(bob["token"])).status_code
        == 403
    )
    assert (
        client.get(f"/api/documents/{doc_id}/download", headers=auth(alice["token"])).status_code
        == 200
    )

    detail = client.get(f"/api/documents/{doc_id}", headers=auth(bob["token"]))
    assert detail.status_code == 200
    document = detail.get_json()["document"]
    assert document["can_download"] is False
    assert document["ocr_excerpt"] == ""

    cross_upload = upload(client, alice["token"], division="Division B")
    assert cross_upload.status_code == 403


def test_metadata_storage_and_filters(client):
    alice = register(client, "alice@example.com", "Division A")
    first = upload(
        client,
        alice["token"],
        metadata={"Title": "Q3 Financial Report", "Author": "Finance Team"},
    )
    assert first.status_code == 201
    upload(
        client,
        alice["token"],
        metadata={
            "Title": "Hiring Plan",
            "Report Type": "HR",
            "Author": "People Team",
        },
        text="Employee handbook and hiring plan",
    )

    filtered = client.get(
        "/api/documents",
        query_string={"Report Type": "Financial"},
        headers=auth(alice["token"]),
    ).get_json()
    assert filtered["total"] == 1
    assert filtered["documents"][0]["metadata"]["Author"] == "Finance Team"

    by_author = client.get(
        "/api/documents",
        query_string={"Author": "People Team"},
        headers=auth(alice["token"]),
    ).get_json()
    assert by_author["total"] == 1
    assert by_author["documents"][0]["title"] == "Hiring Plan"


def test_ocr_search_and_metadata_search(client):
    alice = register(client, "alice@example.com", "Division A")
    created = upload(
        client,
        alice["token"],
        metadata={"Title": "Q3 Financial Report"},
        text="The quarterly budget is confidential and must not be shared.",
    )
    assert created.status_code == 201
    document = created.get_json()["document"]
    assert document["ocr_status"] in {"extracted", "ocr"}, document
    assert "quarterly" in document["ocr_excerpt"].lower()

    ocr_match = client.get(
        "/api/search", query_string={"q": "quarterly budget"}, headers=auth(alice["token"])
    ).get_json()
    assert ocr_match["total"] == 1
    assert ocr_match["results"][0]["id"] == created.get_json()["doc_id"]
    assert "quarterly" in ocr_match["results"][0]["snippet"].lower()

    metadata_match = client.get(
        "/api/search", query_string={"q": "Financial"}, headers=auth(alice["token"])
    ).get_json()
    assert metadata_match["total"] == 1

    no_match = client.get(
        "/api/search", query_string={"q": "nonexistent-term"}, headers=auth(alice["token"])
    ).get_json()
    assert no_match["total"] == 0


# --------------------------------------------------------------------------- #
# Cross-division access workflow
# --------------------------------------------------------------------------- #
def test_access_request_approval_workflow(client):
    alice = register(client, "alice@example.com", "Division A")
    bob = register(client, "bob@example.com", "Division B")

    doc_id = upload(client, alice["token"], metadata={"Title": "Budget 2026"}).get_json()["doc_id"]

    request = client.post(
        "/api/access/request", json={"doc_id": doc_id}, headers=auth(bob["token"])
    )
    assert request.status_code == 201, request.get_json()
    request_id = request.get_json()["request_id"]

    duplicate = client.post(
        "/api/access/request", json={"doc_id": doc_id}, headers=auth(bob["token"])
    )
    assert duplicate.status_code == 200
    assert duplicate.get_json()["request_id"] == request_id

    assert (
        client.get(f"/api/documents/{doc_id}/download", headers=auth(bob["token"])).status_code
        == 403
    )

    inbox = client.get(
        "/api/access/requests", query_string={"type": "incoming"}, headers=auth(alice["token"])
    ).get_json()
    assert inbox["pending_incoming"] == 1
    assert inbox["requests"][0]["can_decide"] is True

    forbidden = client.post(
        "/api/access/approve", json={"request_id": request_id}, headers=auth(bob["token"])
    )
    assert forbidden.status_code == 403

    approved = client.post(
        "/api/access/approve", json={"request_id": request_id}, headers=auth(alice["token"])
    )
    assert approved.status_code == 200
    assert approved.get_json()["status"] == "approved"

    download = client.get(f"/api/documents/{doc_id}/download", headers=auth(bob["token"]))
    assert download.status_code == 200
    assert download.data

    bob_list = client.get("/api/documents", headers=auth(bob["token"])).get_json()
    assert bob_list["total"] == 1
    assert bob_list["documents"][0]["has_download_access"] is True
    assert bob_list["documents"][0]["request_status"] == "approved"

    search = client.get(
        "/api/search", query_string={"q": "quarterly"}, headers=auth(bob["token"])
    ).get_json()
    assert search["total"] == 1


def test_rejection_and_reapply(client):
    alice = register(client, "alice@example.com", "Division A")
    bob = register(client, "bob@example.com", "Division B")
    doc_id = upload(client, alice["token"]).get_json()["doc_id"]

    request_id = client.post(
        "/api/access/request", json={"doc_id": doc_id}, headers=auth(bob["token"])
    ).get_json()["request_id"]

    rejected = client.post(
        "/api/access/approve",
        json={"request_id": request_id, "action": "reject"},
        headers=auth(alice["token"]),
    )
    assert rejected.status_code == 200
    assert rejected.get_json()["status"] == "rejected"

    assert (
        client.get(f"/api/documents/{doc_id}/download", headers=auth(bob["token"])).status_code
        == 403
    )

    detail = client.get(f"/api/documents/{doc_id}", headers=auth(bob["token"])).get_json()
    assert detail["document"]["request_status"] == "rejected"

    again = client.post(
        "/api/access/request", json={"doc_id": doc_id}, headers=auth(bob["token"])
    )
    assert again.status_code == 201
    assert again.get_json()["request"]["status"] == "pending"

    same_division = client.post(
        "/api/access/request", json={"doc_id": doc_id}, headers=auth(alice["token"])
    )
    assert same_division.status_code == 400


# --------------------------------------------------------------------------- #
# Dynamic metadata administration
# --------------------------------------------------------------------------- #
def test_admin_metadata_fields_lifecycle_and_dynamic_filtering(client):
    admin = register(client, "admin@triad.ai")
    assert admin["user"]["role"] == "admin"
    user = register(client, "alice@example.com")

    forbidden = client.post(
        "/api/metadata-fields",
        json={"key": "Priority", "type": "select", "options": ["High", "Low"]},
        headers=auth(user["token"]),
    )
    assert forbidden.status_code == 403

    created = client.post(
        "/api/metadata-fields",
        json={
            "key": "Priority",
            "label": "Priority",
            "type": "select",
            "options": ["High", "Low"],
            "order": 4,
        },
        headers=auth(admin["token"]),
    )
    assert created.status_code == 201, created.get_json()
    field_id = created.get_json()["field"]["id"]

    duplicate = client.post(
        "/api/metadata-fields",
        json={"key": "Priority", "type": "text"},
        headers=auth(admin["token"]),
    )
    assert duplicate.status_code == 409

    updated = client.put(
        f"/api/metadata-fields/{field_id}",
        json={"label": "Urgency"},
        headers=auth(admin["token"]),
    )
    assert updated.status_code == 200
    assert updated.get_json()["field"]["label"] == "Urgency"

    listed = client.get("/api/metadata-fields", headers=auth(user["token"])).get_json()
    assert any(field["key"] == "Priority" for field in listed["fields"])

    upload(
        client,
        user["token"],
        metadata={"Priority": "High", "Title": "Escalation"},
    )
    filtered = client.get(
        "/api/documents", query_string={"Priority": "High"}, headers=auth(user["token"])
    ).get_json()
    assert filtered["total"] == 1

    deleted = client.delete(
        f"/api/metadata-fields/{field_id}", headers=auth(admin["token"])
    )
    assert deleted.status_code == 200


def test_admin_can_add_divisions_and_register_into_them(client):
    admin = register(client, "admin@triad.ai")
    created = client.post(
        "/api/divisions", json={"name": "Division C"}, headers=auth(admin["token"])
    )
    assert created.status_code == 201

    divisions = client.get("/api/divisions").get_json()["divisions"]
    assert {division["name"] for division in divisions} >= {"Division A", "Division B", "Division C"}

    charlie = register(client, "charlie@example.com", "Division C")
    assert charlie["user"]["division"] == "Division C"


def test_health_endpoint(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.get_json()["status"] == "ok"
