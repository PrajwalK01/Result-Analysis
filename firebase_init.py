"""
Shared Firebase initialisation — import get_db() from here in any route file.
Firebase is initialised lazily on first call, safe for both local and Vercel.
"""
import os
import json
import firebase_admin
from firebase_admin import credentials, firestore

_db = None


def init_firebase():
    if firebase_admin._apps:
        return

    firebase_key_env = os.environ.get("FIREBASE_KEY", "").strip()

    if firebase_key_env:
        key_dict = json.loads(firebase_key_env)
        cred = credentials.Certificate(key_dict)
    else:
        base_dir = os.path.dirname(os.path.abspath(__file__))
        key_path = os.path.join(base_dir, "firebase-key.json")
        if not os.path.exists(key_path):
            raise RuntimeError(
                "Firebase credentials not found. "
                "Set FIREBASE_KEY env var or add firebase-key.json to project root."
            )
        cred = credentials.Certificate(key_path)

    firebase_admin.initialize_app(cred)


def get_db():
    global _db
    if _db is None:
        init_firebase()
        _db = firestore.client()
    return _db
