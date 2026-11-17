from flask import current_app
from gridfs import GridFSBucket
from pymongo import MongoClient


def init_db(app) -> None:
    client = MongoClient(
        app.config["MONGO_URI"],
        serverSelectionTimeoutMS=3000,
        connectTimeoutMS=3000,
    )
    db = client[app.config["MONGO_DB"]]
    app.extensions["mongo_client"] = client
    app.extensions["mongo_db"] = db
    app.extensions["gridfs"] = GridFSBucket(db, bucket_name="documents")


def get_db():
    return current_app.extensions["mongo_db"]


def get_fs() -> GridFSBucket:
    return current_app.extensions["gridfs"]
