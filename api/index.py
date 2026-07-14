import sys
import os

# Add project root to Python path so 'routes', 'templates', 'static' are found
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from app import app   # noqa: E402  — Vercel looks for "app" as the WSGI handler
