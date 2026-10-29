#!/usr/bin/env python3
"""Execute the release planner and retry guard from YAML against fixture files and Git."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
JOB = "bump"
PLAN_STEPS = ("refuse unless the manifest version is released", "derive the version this bump cuts")
GUARD = "recheck release preconditions before bumping"
DISPATCH = "github.event_name == 'workflow_dispatch'"
CURRENT = "1.2.3"
TARGET = "2.0.0"
CURRENT_REF = "refs/tags/v1.2.3"
TARGET_REF = "refs/tags/v2.0.0"

GIT_STUB = '''import fnmatch
import json
import sys
from pathlib import Path

args = sys.argv[1:]
with Path("queries.jsonl").open("a") as log:
    log.write(json.dumps({"args": args, "current": json.loads(Path("package.json").read_text())["version"]}) + "\\n")
if args[:3] not in (["ls-remote", "--refs", "origin"], ["ls-remote", "--tags", "origin"]):
    sys.exit("unexpected git command: " + repr(args))
remote = json.loads(Path("remote.json").read_text())
if remote["error"] in args[3:]:
    print("remote query failed", file=sys.stderr)
    sys.exit(128)
for ref in remote["refs"]:
    if any(fnmatch.fnmatchcase(ref, pattern) for pattern in args[3:]):
        print("a" * 40 + "\\t" + ref)
'''


class ReleaseRetryGuard(unittest.TestCase):
    def setUp(self):
        workflow = yaml.safe_load((ROOT / ".github/workflows/release.yml").read_text())
        self.steps = workflow["jobs"][JOB]["steps"]
        guards = [step for step in self.steps if step.get("name") == GUARD]
        self.assertLessEqual(len(guards), 1)
        self.guard = guards[0] if guards else None
        scratch = Path(os.environ.get("TMPDIR") or ROOT / ".tmp")
        scratch.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="release-retry-", dir=scratch)
        self.addCleanup(self.temp.cleanup)
        self.cwd = Path(self.temp.name)
        (self.cwd / "bin").mkdir()
        git = self.cwd / "bin/git"
        git.write_text(f"#!{sys.executable}\n" + GIT_STUB)
        git.chmod(0o755)
        (self.cwd / "package.json").write_text(json.dumps(
            {"name": "retry-fixture", "version": CURRENT, "private": True}, indent=2) + "\n")
        (self.cwd / "package-lock.json").write_text(json.dumps(
            {"version": CURRENT, "packages": {"": {"version": CURRENT, "name": "retry-fixture"}}},
            indent=2) + "\n")
        (self.cwd / "src/adapter").mkdir(parents=True)
        (self.cwd / "src/adapter/extension.ts").write_text(
            f"const CLIENT = 'selvage-vscode/{CURRENT}';\n")
        (self.cwd / "scripts").mkdir()
        bump = self.cwd / "scripts/bump-version.sh"
        shutil.copy2(ROOT / "scripts/bump-version.sh", bump)
        bump.chmod(0o755)
        bash = shutil.which("bash")
        self.assertIsNotNone(bash, "Bash must be on PATH")
        bump.write_text(f"#!{bash}\n" + bump.read_text().split("\n", 1)[1])
        self.env = {
            "PATH": f"{self.cwd / 'bin'}:{os.environ['PATH']}",
            "HOME": str(self.cwd), "TMPDIR": str(self.cwd),
            "BUMP": "major", "TARGET": TARGET,
            "GITHUB_OUTPUT": str(self.cwd / "output"),
        }
        self.remote([CURRENT_REF])
        plan = "\n".join(next(s["run"] for s in workflow["jobs"]["plan"]["steps"] if s.get("name") == name)
                         for name in PLAN_STEPS)
        result = self.run_body(plan)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.cwd / "output").read_text(), f"version={TARGET}\n")
        self.assertEqual(self.version(), CURRENT)
        (self.cwd / "queries.jsonl").write_text("")

    def remote(self, refs, error=None):
        (self.cwd / "remote.json").write_text(json.dumps({"refs": refs, "error": error}))

    def version(self):
        return json.loads((self.cwd / "package.json").read_text())["version"]

    def queries(self):
        return [json.loads(line) for line in (self.cwd / "queries.jsonl").read_text().splitlines()]

    def run_body(self, body):
        return subprocess.run(["bash", "--noprofile", "--norc", "-e", "-c", body],
                              cwd=self.cwd, env=self.env, capture_output=True, text=True, timeout=10)

    def attempt(self, event="workflow_dispatch"):
        # Only this step's dispatch condition is modeled; no publish or Git write step is run.
        if self.guard is None:
            return self.run_body("")
        skipped = self.guard.get("if") == DISPATCH and event != "workflow_dispatch"
        return self.run_body("" if skipped else self.guard["run"])

    def assert_refused(self, message):
        result = self.attempt()
        self.assertNotEqual(result.returncode, 0, "retry accepted stale remote preconditions")
        self.assertIn(message, result.stderr)
        self.assertEqual(self.version(), CURRENT)

    def test_retry_refuses_current_tag_disappearing_after_plan(self):
        self.remote([])
        self.assert_refused("v1.2.3")

    def test_retry_refuses_target_tag_appearing_after_plan(self):
        self.remote([CURRENT_REF, TARGET_REF])
        self.assert_refused("v2.0.0")

    def test_unchanged_remote_accepts_original_current_and_planned_target(self):
        # A retry consumes the cached plan, not a new derivation from a dispatch input.
        self.env["BUMP"] = "patch"
        result = self.attempt()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.queries(), [
            {"args": ["ls-remote", "--refs", "origin", CURRENT_REF], "current": CURRENT},
            {"args": ["ls-remote", "--refs", "origin", TARGET_REF], "current": CURRENT},
        ])
        self.assertEqual(self.version(), CURRENT)

    def test_remote_errors_fail_closed_for_either_query(self):
        for ref in (CURRENT_REF, TARGET_REF):
            with self.subTest(ref=ref):
                self.remote([CURRENT_REF], error=ref)
                self.assert_refused("remote query failed")

    def test_similarly_named_current_tag_does_not_satisfy_precondition(self):
        self.remote([CURRENT_REF + "-rc.1", CURRENT_REF + "0", "refs/heads/v1.2.3"])
        self.assert_refused("v1.2.3")

    def test_similarly_named_target_tags_do_not_block(self):
        self.remote([CURRENT_REF, TARGET_REF + "-rc.1", TARGET_REF + "0", "refs/heads/v2.0.0"])
        result = self.attempt()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_guard_is_dispatch_only_and_before_first_bump_or_commit(self):
        self.assertIsNotNone(self.guard, "mutation job needs its own retry guard")
        self.assertEqual(self.guard["if"], DISPATCH)
        self.assertEqual(self.guard["env"]["TARGET"], "${{ needs.plan.outputs.version }}")
        guard_index = self.steps.index(self.guard)
        setup_index = next(i for i, s in enumerate(self.steps) if s.get("uses", "").startswith("actions/setup-node@"))
        bump_index = next(i for i, s in enumerate(self.steps) if s.get("name") == "bump the version")
        commit_index = next(i for i, s in enumerate(self.steps) if s.get("name") == "commit and push the bump")
        self.assertLess(setup_index, guard_index)
        self.assertLess(guard_index, bump_index)
        self.assertLess(bump_index, commit_index)

    def test_tag_push_bypasses_guard_with_target_tag_present(self):
        self.remote([TARGET_REF])
        result = self.attempt(event="push")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.queries(), [])
        self.assertEqual(self.version(), CURRENT)


if __name__ == "__main__":
    unittest.main()
