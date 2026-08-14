import re
import subprocess

import pytest


def _get_branch_commits() -> list[str]:
    result = subprocess.run(
        ["git", "log", "origin/main..", "--format=%s"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Failed to get branch commits: {result.stderr}")
    return [line for line in result.stdout.splitlines() if line]


BRANCH_COMMITS = _get_branch_commits()


@pytest.mark.parametrize("subject", BRANCH_COMMITS)
def test_commit_is_capitalized(subject: str) -> None:
    assert subject[0].isupper(), f"Commit subject must start with a capital letter: {subject!r}"


@pytest.mark.parametrize("subject", BRANCH_COMMITS)
def test_commit_is_not_single_word(subject: str) -> None:
    assert len(subject.split()) > 1, f"Commit subject must be more than one word: {subject!r}"


@pytest.mark.parametrize("subject", BRANCH_COMMITS)
def test_commit_is_not_wip(subject: str) -> None:
    assert not re.match(r"^(WIP|wip|fixup!|squash!|temp\b|TODO)", subject), (
        f"Commit subject looks like work-in-progress: {subject!r}"
    )


@pytest.mark.parametrize("subject", BRANCH_COMMITS)
def test_commit_is_not_merge(subject: str) -> None:
    assert not re.match(r"^Merge ", subject), (
        f"Merge commits should not appear in a feature branch: {subject!r}"
    )


@pytest.mark.parametrize("subject", BRANCH_COMMITS)
def test_commit_subject_length(subject: str) -> None:
    if subject.startswith('Revert "'):
        return
    assert len(subject) <= 70, (
        f"Commit subject too long ({len(subject)} > 70 chars): {subject!r}"
    )


@pytest.mark.parametrize("subject", BRANCH_COMMITS)
def test_commit_is_not_deploy_to_test(subject: str) -> None:
    assert not re.match(r"^deploy-to-test", subject, re.IGNORECASE), (
        f"Deploy-to-test commits should not be in the branch: {subject!r}"
    )


@pytest.mark.parametrize("subject", BRANCH_COMMITS)
def test_commit_is_not_squash_me(subject: str) -> None:
    assert not re.match(r"^(linting|typing|formatting)\s+fix", subject, re.IGNORECASE), (
        f"Squash-me fix commits should not be in the branch: {subject!r}"
    )
