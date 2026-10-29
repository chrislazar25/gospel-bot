import json
import re
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

image = sys.argv[1]
assert re.fullmatch(r"[a-zA-Z0-9./_:@-]+", image)
output = Path(sys.argv[2] if len(sys.argv) > 2 else ".audit/evidence/cloud-smoke")
output.mkdir(parents=True, exist_ok=True)


def docker(*args, **options):
    return subprocess.run(["docker", *args], text=True, capture_output=True,
                          timeout=120, **options)


mutations = [
    ("receipt-mutation", "/app/dist/green-api.js",
     "parsed.chatId !== delivery.target", "false"),
    ("status-permission-mutation", "/verification/run.mjs",
     "passed('read-only status role reports the confirmed delivery');",
     "await client.query('GRANT UPDATE(evidence) ON deliveries TO gospel_status');"
     "passed('read-only status role reports the confirmed delivery');"),
]
for name, path, before, after in mutations:
    tag = "gospel-smoke-negative:" + uuid.uuid4().hex
    try:
        with tempfile.TemporaryDirectory(prefix="gospel-smoke-negative-") as temp:
            script = ("const fs=require('node:fs');"
                      f"const path={json.dumps(path)};"
                      "const source=fs.readFileSync(path,'utf8');"
                      f"if(!source.includes({json.dumps(before)}))throw Error('mutation target missing');"
                      f"fs.writeFileSync(path,source.replace({json.dumps(before)},{json.dumps(after)}));")
            contents = (f"FROM {image}\nUSER root\nRUN "
                        + json.dumps(["node", "-e", script]) + "\nUSER node\n")
            Path(temp, "Dockerfile").write_text(contents)
            build = docker("build", "--platform", "linux/amd64", "-t", tag, temp)
            assert build.returncode == 0, build.stderr
        result = docker("run", "--rm", "--platform", "linux/amd64", "--network", "none", tag)
        rejected = (result.returncode == 1 and "cloud_smoke_failed" in result.stderr
                    and "cloud_smoke_verified" not in result.stdout)
        report = {"image": image, "mutation": name, "path": path,
                  "before": before, "after": after, "exitCode": result.returncode,
                  "stderr": result.stderr, "result": "PASS" if rejected else "FAIL"}
        Path(output, name + ".json").write_text(json.dumps(report, indent=2) + "\n")
        assert rejected, f"{name} survived the test"
        print("PASS", name)
    finally:
        docker("image", "rm", tag)

name = "gospel-smoke-interrupt-" + uuid.uuid4().hex[:8]
try:
    start = docker("run", "-d", "--platform", "linux/amd64", "--network", "none",
                   "--name", name, image)
    assert start.returncode == 0, start.stderr
    for attempt in range(100):
        logs = docker("logs", name)
        assert "cloud_smoke_verified" not in logs.stdout, "Interruption window missed"
        if "fourteen synthetic content dates" in logs.stdout:
            break
        time.sleep(.2)
    else:
        raise AssertionError("Smoke never reached the interruption checkpoint")
    assert docker("kill", "--signal=TERM", name).returncode == 0
    stopped = docker("wait", name)
    assert stopped.returncode == 0 and stopped.stdout.strip() == "1", stopped
    logs = docker("logs", name)
    assert "cloud_smoke_failed" in logs.stderr
    assert "cloud_smoke_verified" not in logs.stdout
    changes = docker("diff", name)
    assert changes.returncode == 0 and "gospel-cloud-smoke-" not in changes.stdout
    report = {"image": image, "signal": "SIGTERM", "exitCode": 1,
              "stderr": logs.stderr, "filesystemChanges": changes.stdout,
              "temporaryDatabaseAndKeysRemoved": True, "result": "PASS"}
    Path(output, "interruption.json").write_text(json.dumps(report, indent=2) + "\n")
    print("PASS interruption cleanup")
finally:
    docker("rm", "-f", name)
