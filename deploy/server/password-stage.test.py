import importlib.util
import json
import os
import pathlib
import tempfile

spec = importlib.util.spec_from_file_location("password_stage", pathlib.Path(__file__).with_name("password-stage.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    (root / "secrets").mkdir()
    backup = root / "backups/release"
    backup.mkdir(parents=True)
    secret = root / "secrets/console-password"
    pending = root / "secrets/console-password.pending"
    original = b"OriginalLongPassword123456789\n"
    secret.write_bytes(original)
    os.chmod(secret, 0o400)
    sha = "a" * 40
    pending.write_text(json.dumps({"sha": sha, "password": "NewPass12AbC"}))
    module.run("check", root, sha, backup)
    assert secret.read_bytes() == original
    module.run("apply", root, sha, backup)
    assert secret.read_text() == "NewPass12AbC\n"
    assert secret.stat().st_mode & 0o777 == 0o400
    assert (backup / "console-password").stat().st_mode & 0o777 == 0o600
    module.run("rollback", root, sha, backup)
    assert secret.read_bytes() == original
    module.run("apply", root, sha, backup)
    module.run("complete", root, sha, backup)
    assert not pending.exists()
    pending.write_text(json.dumps({"sha": "b" * 40, "password": "NewPass12AbC"}))
    try:
        module.run("check", root, sha, backup)
        raise AssertionError("must reject a different release")
    except ValueError:
        pass
    os.chmod(secret, 0o600)
    secret.write_text("ExternalChange123\n")
    try:
        module.run("rollback", root, sha, backup)
        raise AssertionError("must preserve an external credential change")
    except ValueError:
        pass
    assert secret.read_text() == "ExternalChange123\n"

print("PASS: staged 12-character password, release binding, file permissions, rollback and external-change guard")
