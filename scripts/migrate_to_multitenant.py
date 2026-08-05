"""
Phase 2 — One-off migration script: single-college → multi-tenant.

Run this ONCE against production data before deploying the multi-tenant code.

What it does:
  1. Creates Colleges/jvit (CollegeName: "Jnanavikas Institute of Technology").
  2. Adds College: "jvit" to every existing doc in UserLogin that lacks it.
  3. For every {year}_result_{sem}_{branch} collection (old format):
       - Reads all docs.
       - Writes them into jvit_{year}_result_{sem}_{branch} (new format).
       - Deletes the old collection in batches of ≤500.
  4. Adds College: "jvit" to every existing doc in AuditLogs that lacks it.
  5. Migrates legacy lookups/{doc} → lookups/jvit_{doc}.

Safe to re-run — skips docs that already have a College field.

Usage:
  cd "Result_Analysis_fixed (4)"
  python scripts/migrate_to_multitenant.py

Set FIREBASE_KEY env var or have firebase-key.json in the project root.
"""

import sys
import os
import re

# Make the project root importable
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from firebase_init import get_db
from firebase_admin import firestore

COLLEGE_CODE = "jvit"
COLLEGE_NAME = "Jnanavikas Institute of Technology"
BATCH_SIZE   = 450   # stay safely below the Firestore 500-op batch limit

# Old result collection pattern: {year}_result_{sem}_{branch}
# Must NOT start with a college slug (i.e. not already migrated)
_OLD_RESULT_RE = re.compile(
    r'^(?!jvit_)[a-z0-9]+_result_[a-z0-9]+_[a-z0-9]+$'
)

# Old lookup document names
OLD_LOOKUP_DOCS = ['branches', 'semesters', 'academicYears']


def batch_write(db, operations):
    """Execute a list of (ref, data, is_set) tuples in batches of BATCH_SIZE."""
    for i in range(0, len(operations), BATCH_SIZE):
        batch = db.batch()
        for ref, data, is_set in operations[i:i + BATCH_SIZE]:
            if is_set:
                batch.set(ref, data, merge=True)
            else:
                batch.delete(ref)
        batch.commit()


def step1_create_college_doc(db):
    print("\n[Step 1] Creating Colleges/jvit …")
    ref = db.collection('Colleges').document(COLLEGE_CODE)
    if ref.get().exists:
        print("  ✓ Already exists, skipping.")
        return
    ref.set({
        'CollegeName': COLLEGE_NAME,
        'Status':      'Active',
        'createdAt':   firestore.SERVER_TIMESTAMP,
        'createdBy':   'migration_script',
    })
    print("  ✓ Created.")


def step2_migrate_user_logins(db):
    print("\n[Step 2] Adding College field to UserLogin docs …")
    docs = list(db.collection('UserLogin').stream())
    ops = []
    skipped = 0
    for doc in docs:
        data = doc.to_dict() or {}
        if data.get('College'):
            skipped += 1
            continue
        # Creator has no College field — skip docs with role Creator
        if data.get('UserRole') == 'Creator':
            skipped += 1
            continue
        ops.append((doc.reference, {'College': COLLEGE_CODE}, True))

    print(f"  Found {len(docs)} docs. {skipped} already have College or are Creator.")
    if ops:
        batch_write(db, ops)
        print(f"  ✓ Updated {len(ops)} docs.")
    else:
        print("  ✓ Nothing to update.")


def step3_migrate_result_collections(db):
    print("\n[Step 3] Migrating result collections …")

    # List all top-level collections and find old-format result ones
    all_collections = [c.id for c in db.collections()]
    old_result_cols  = [c for c in all_collections if _OLD_RESULT_RE.match(c)]

    if not old_result_cols:
        print("  ✓ No old-format result collections found.")
        return

    total_migrated = 0
    for old_col in old_result_cols:
        new_col = f"{COLLEGE_CODE}_{old_col}"
        print(f"  Migrating: {old_col!r} → {new_col!r}")

        docs = list(db.collection(old_col).stream())
        if not docs:
            print(f"    (empty collection, skipping)")
            continue

        write_ops  = []
        delete_ops = []
        skipped    = 0
        for doc in docs:
            data = doc.to_dict() or {}
            # Add College field to each document
            new_data = {**data, 'College': COLLEGE_CODE}
            new_ref  = db.collection(new_col).document(doc.id)
            write_ops.append((new_ref, new_data, True))
            delete_ops.append((doc.reference, None, False))

        batch_write(db, write_ops)
        batch_write(db, delete_ops)
        print(f"    ✓ Migrated {len(write_ops)} docs, deleted old collection.")
        total_migrated += len(write_ops)

    print(f"  ✓ Total result docs migrated: {total_migrated}")


def step4_migrate_audit_logs(db):
    print("\n[Step 4] Adding College field to AuditLogs docs …")
    docs = list(db.collection('AuditLogs').stream())
    ops = []
    skipped = 0
    for doc in docs:
        data = doc.to_dict() or {}
        if data.get('College') is not None:  # already has it (even if '')
            skipped += 1
            continue
        # Creator-generated audit logs (no college) get '' not 'jvit'
        actor_role = data.get('ActorRole', '')
        college_val = '' if actor_role == 'Creator' else COLLEGE_CODE
        ops.append((doc.reference, {'College': college_val}, True))

    print(f"  Found {len(docs)} docs. {skipped} already migrated.")
    if ops:
        batch_write(db, ops)
        print(f"  ✓ Updated {len(ops)} docs.")
    else:
        print("  ✓ Nothing to update.")


def step5_migrate_lookups(db):
    print("\n[Step 5] Migrating lookups docs …")
    for doc_name in OLD_LOOKUP_DOCS:
        old_ref = db.collection('lookups').document(doc_name)
        new_ref = db.collection('lookups').document(f'{COLLEGE_CODE}_{doc_name}')
        old_doc = old_ref.get()

        if not old_doc.exists:
            print(f"  lookups/{doc_name}: not found, skipping.")
            continue

        if new_ref.get().exists:
            print(f"  lookups/{COLLEGE_CODE}_{doc_name}: already exists, skipping.")
            continue

        new_ref.set(old_doc.to_dict() or {})
        # Do NOT delete the old doc — in case of rollback needs
        print(f"  ✓ Copied lookups/{doc_name} → lookups/{COLLEGE_CODE}_{doc_name}")


def main():
    print("=" * 60)
    print("  Multi-Tenant Migration: JVIT → jvit")
    print("=" * 60)
    print(f"  College code : {COLLEGE_CODE}")
    print(f"  College name : {COLLEGE_NAME}")
    print()
    confirm = input("Type 'yes' to proceed: ").strip().lower()
    if confirm != 'yes':
        print("Aborted.")
        sys.exit(0)

    db = get_db()
    step1_create_college_doc(db)
    step2_migrate_user_logins(db)
    step3_migrate_result_collections(db)
    step4_migrate_audit_logs(db)
    step5_migrate_lookups(db)

    print("\n" + "=" * 60)
    print("  Migration complete!")
    print("=" * 60)


if __name__ == '__main__':
    main()
