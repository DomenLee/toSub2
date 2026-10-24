import hashlib
import json
import os
import pathlib
import re
import sys
import tempfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def replace(target, data, mode=None):
    existing = target.stat() if target.exists() else None
    descriptor, filename = tempfile.mkstemp(prefix=".password-", dir=target.parent)
    try:
        with os.fdopen(descriptor, "wb") as output:
            if existing:
                os.fchown(output.fileno(), existing.st_uid, existing.st_gid)
            os.fchmod(output.fileno(), mode if mode is not None else existing.st_mode & 0o777)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(filename, target)
    finally:
        if os.path.exists(filename):
            os.unlink(filename)


def run(action, root, sha, backup):
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise ValueError("Invalid release SHA")
    secret = root / "secrets/console-password"
    pending = root / "secrets/console-password.pending"
    record = backup / "password-rotation.json"
    if action == "rollback":
        if not record.exists():
            return
        metadata = json.loads(record.read_text())
        current = digest(secret.read_bytes())
        if current == metadata["before"]:
            return
        if current != metadata["after"]:
            raise ValueError("Password changed externally; refusing to overwrite it")
        original = (backup / "console-password").read_bytes()
        if digest(original) != metadata["before"]:
            raise ValueError("Password backup verification failed")
        replace(secret, original)
        return
    if not pending.exists():
        return
    staged = json.loads(pending.read_text())
    password = staged.get("password", "")
    if staged.get("sha") != sha:
        raise ValueError("Staged password belongs to another release")
    if not isinstance(password, str) or not re.fullmatch(r"[A-Za-z0-9]{12}", password) or not re.search(r"[A-Za-z]", password) or not re.search(r"[0-9]", password):
        raise ValueError("Staged password must contain exactly 12 letters and digits")
    if action == "check":
        return
    if action == "complete":
        if not record.exists() or digest(secret.read_bytes()) != json.loads(record.read_text())["after"]:
            raise ValueError("Password activation verification failed")
        pending.unlink()
        return
    if action != "apply":
        raise ValueError("Invalid password operation")
    original = secret.read_bytes()
    updated = (password + "\n").encode()
    replace(backup / "console-password", original, 0o600)
    replace(record, json.dumps({"sha": sha, "before": digest(original), "after": digest(updated)}).encode(), 0o600)
    replace(secret, updated)


if __name__ == "__main__":
    try:
        run(sys.argv[1], pathlib.Path(sys.argv[2]), sys.argv[3], pathlib.Path(sys.argv[4]))
    except Exception:
        sys.exit("Password staging failed; inspect protected files without printing credentials")
