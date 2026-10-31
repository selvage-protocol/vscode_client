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
PUBLISH_JOB = "publish"
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
remote_file = Path("remote.json")
remote = json.loads(remote_file.read_text())
if args[0] == "ls-remote":
    origin = args.index("origin")
    flags, patterns = args[1:origin], args[origin + 1:]
    if remote["error"] in patterns:
        print("remote query failed", file=sys.stderr)
        sys.exit(128)
    for ref, sha in remote["refs"].items():
        if "--refs" in flags and ref.endswith("^{}"):
            continue
        if "--tags" in flags and not ref.startswith("refs/tags/"):
            continue
        tails = [ref] + [ref[i + 1:] for i, char in enumerate(ref) if char == "/"]
        if any(fnmatch.fnmatchcase(tail, pattern) for tail in tails for pattern in patterns):
            print(sha + "\\t" + ref)
elif args == ["rev-parse", "HEAD"]:
    print("a" * 40)
elif args[0] == "config" or args[:2] == ["remote", "set-url"]:
    pass
elif args == ["tag", "-a", "v2.0.0", "-m", "v2.0.0"]:
    pass
elif args == ["push", "origin", "v2.0.0"]:
    if not remote.get("reject_push") or remote["exact_tag_after_push"]:
        remote["refs"]["refs/tags/v2.0.0"] = "a" * 40
    if remote.get("reject_push"):
        if remote["exact_tag_after_push"]:
            remote["refs"]["refs/tags/v2.0.0^{}"] = "a" * 40
        remote["error"] = remote.get("error_after_push")
        remote_file.write_text(json.dumps(remote))
        sys.exit(1)
    remote_file.write_text(json.dumps(remote))
else:
    sys.exit("unexpected git command: " + repr(args))
'''


class ReleaseRetryGuard(unittest.TestCase):
    def setUp(self):
        workflow = yaml.safe_load((ROOT / ".github/workflows/release.yml").read_text())
        self.steps = workflow["jobs"][JOB]["steps"]
        self.tag_body = next(s["run"] for s in workflow["jobs"][PUBLISH_JOB]["steps"]
                             if s.get("name") == "create and push the tag")
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
            "RELEASE_VERSION": TARGET, "RELEASE_COMMIT": "a" * 40,
            "GH_TOKEN": "fixture", "GITHUB_REPOSITORY": "fixture/repository",
            "GITHUB_OUTPUT": str(self.cwd / "output"),
        }
        self.remote([CURRENT_REF])
        self.plan_body = "\n".join(next(s["run"] for s in workflow["jobs"]["plan"]["steps"] if s.get("name") == name)
                                  for name in PLAN_STEPS)
        result = self.run_body(self.plan_body)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.cwd / "output").read_text(), f"version={TARGET}\n")
        self.assertEqual(self.version(), CURRENT)
        (self.cwd / "queries.jsonl").write_text("")

    def remote(self, refs, error=None, reject_push=False, error_after_push=None, exact_tag_after_push=True):
        if not isinstance(refs, dict):
            refs = dict.fromkeys(refs, "a" * 40)
        (self.cwd / "remote.json").write_text(json.dumps(
            {"refs": refs, "error": error, "reject_push": reject_push, "error_after_push": error_after_push,
             "exact_tag_after_push": exact_tag_after_push}))

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

    def test_nested_current_alias_does_not_satisfy_plan_or_retry(self):
        self.remote({"refs/tags/" + CURRENT_REF: "b" * 40})
        for body in (self.plan_body, self.guard["run"]):
            with self.subTest(body=body.splitlines()[0]):
                result = self.run_body(body)
                self.assertNotEqual(result.returncode, 0, "nested current alias accepted as released")
                self.assertIn("v1.2.3", result.stderr)

    def test_nested_target_alias_does_not_block_plan_retry_or_tag_creation(self):
        for stage, body in (("plan", self.plan_body), ("retry", self.guard["run"]),
                            ("tag", self.tag_body)):
            with self.subTest(stage=stage):
                self.remote({CURRENT_REF: "a" * 40, "refs/tags/" + TARGET_REF: "b" * 40})
                result = self.run_body(body)
                self.assertEqual(result.returncode, 0, result.stderr)
                if stage == "tag":
                    refs = json.loads((self.cwd / "remote.json").read_text())["refs"]
                    self.assertEqual(refs[TARGET_REF], "a" * 40)

    def test_exact_target_still_blocks_plan_and_retry_among_aliases(self):
        self.remote({CURRENT_REF: "a" * 40, "refs/tags/" + CURRENT_REF: "b" * 40,
                     TARGET_REF: "a" * 40, "refs/tags/" + TARGET_REF: "b" * 40})
        for body in (self.plan_body, self.guard["run"]):
            with self.subTest(body=body.splitlines()[0]):
                result = self.run_body(body)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("v2.0.0", result.stderr)

    def test_publishing_accepts_only_exact_lightweight_or_peeled_tag(self):
        for annotated in (False, True):
            with self.subTest(annotated=annotated):
                refs = {TARGET_REF: ("b" if annotated else "a") * 40}
                if annotated:
                    refs[TARGET_REF + "^{}"] = "a" * 40
                refs.update({"refs/tags/" + TARGET_REF: "c" * 40,
                             "refs/tags/" + TARGET_REF + "^{}": "d" * 40})
                self.remote(refs)
                (self.cwd / "queries.jsonl").write_text("")
                result = self.run_body(self.tag_body)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse(any(q["args"][0] in ("tag", "push") for q in self.queries()))

    def test_publishing_refuses_exact_conflict_even_if_alias_matches(self):
        self.remote({TARGET_REF: "b" * 40, "refs/tags/" + TARGET_REF: "a" * 40,
                     "refs/tags/" + TARGET_REF + "^{}": "a" * 40})
        result = self.run_body(self.tag_body)
        self.assertNotEqual(result.returncode, 0, "alias hid the conflicting exact tag")
        self.assertIn("not the commit this run releases", result.stderr)

    def test_remote_errors_propagate_before_filtering_at_every_stage(self):
        for stage, body, refs in (("plan", self.plan_body, (CURRENT_REF, TARGET_REF)),
                                  ("retry", self.guard["run"], (CURRENT_REF, TARGET_REF)),
                                  ("tag", self.tag_body, (TARGET_REF,))):
            for ref in refs:
                with self.subTest(stage=stage, ref=ref):
                    self.remote([CURRENT_REF], error=ref)
                    (self.cwd / "queries.jsonl").write_text("")
                    result = self.run_body(body)
                    self.assertEqual(result.returncode, 128, result.stderr)
                    self.assertFalse(any(q["args"][0] in ("tag", "push") for q in self.queries()))

    def test_real_git_tail_match_is_not_exact_presence(self):
        real_git = shutil.which("git")
        self.assertIsNotNone(real_git, "Git must be on PATH")
        bare = self.cwd / "remote.git"

        def git(*args, input=None):
            result = subprocess.run([real_git, *map(str, args)], input=input, cwd=self.cwd,
                                    env=self.env, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout

        git("init", "--bare", "--template=", bare)
        sha = git("--git-dir", bare, "hash-object", "-w", "--stdin", input="fixture\n").strip()
        alias = "refs/tags/" + CURRENT_REF
        git("--git-dir", bare, "update-ref", alias, sha)
        matched = git("ls-remote", "--refs", "--tags", bare, CURRENT_REF)
        self.assertEqual(matched, f"{sha}\t{alias}\n")
        # Read the real local remote through the unmodified workflow bodies, without the stub.
        git("init", "--template=", self.cwd)
        git("remote", "add", "origin", bare)
        self.env["PATH"] = os.environ["PATH"]
        for body in (self.plan_body, self.guard["run"]):
            result = self.run_body(body)
            self.assertNotEqual(result.returncode, 0, "real Git's nested alias counted as current")
        git("--git-dir", bare, "update-ref", CURRENT_REF, sha)
        git("--git-dir", bare, "update-ref", "refs/tags/" + TARGET_REF, sha)
        for body in (self.plan_body, self.guard["run"]):
            result = self.run_body(body)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejected_push_requeries_exact_tag_and_peeled_commit(self):
        self.remote({"refs/tags/" + TARGET_REF: "b" * 40}, reject_push=True)
        result = self.run_body(self.tag_body)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sum(q["args"][0] == "ls-remote" for q in self.queries()), 2)

    def test_rejected_push_without_exact_tag_is_refused(self):
        for refs in ({}, {"refs/tags/" + TARGET_REF: "a" * 40,
                          "refs/tags/" + TARGET_REF + "^{}": "a" * 40}):
            with self.subTest(refs=refs):
                self.remote(refs, reject_push=True, exact_tag_after_push=False)
                result = self.run_body(self.tag_body)
                self.assertNotEqual(result.returncode, 0, "rejected push without an exact tag was accepted")
                self.assertIn("does not exist on the remote after the rejected push", result.stderr)

    def test_rejected_push_remote_error_aborts_before_filtering(self):
        self.remote([], reject_push=True, error_after_push=TARGET_REF)
        result = self.run_body(self.tag_body)
        self.assertEqual(result.returncode, 128, result.stderr)

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
