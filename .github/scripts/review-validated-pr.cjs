"use strict";

// This is a deterministic CI/CODEOWNERS gate, not a semantic code or security
// review. Only trusted default-branch code runs. No PR content is evaluated.
// REST contract: https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request
// CODEOWNERS is read from the immutable BASE commit, never from the PR.
const {createHash} = require("node:crypto");

const SHA = /^[a-f0-9]{40}$/;
const TRUSTED_REPOSITORY = "williamboglietti/bootstrap";
const ACTIONS_APP_ID = 15368;
const REVIEWER = "github-actions[bot]";

// These reviewed workflow contents define the expected jobs and path filters.
// A change in their BASE version requires human reception of this contract;
// do not infer a new policy from PR-controlled YAML or accept unknown CI jobs.
const CI_CONTRACT = [
    {path: ".github/workflows/verification.yml", sha256: "e577ee169d0c30d68952ebe19da05140aa5356a1968dc71165589bc31db33dcb",
        checks: ["shellcheck", "automation.sh (debian:13)", "automation.sh (ubuntu:24.04)", "review-policy"],
        applies: () => true},
];

function requireCondition(condition, message) {
    if (!condition) throw new Error(`Review refused: ${message}`);
}

function validPath(path) {
    requireCondition(typeof path === "string" && path.length > 0 && !path.startsWith("/") &&
        !/[\\\x00-\x1f\x7f]/.test(path) && !path.split("/").some(part => ["", ".", ".."].includes(part)),
    "unknown or unsafe changed path");
    return path;
}

function sensitive(path) {
    const name = path.split("/").at(-1);
    return path.startsWith(".github/") || ["CODEOWNERS", "docs/CODEOWNERS", ".gitmodules",
        "group_vars/all/ssh_access.yml", "playbooks/ssh-access.yml", "automation.sh", "enroll.sh"].includes(path) ||
        ["AGENTS.md", "CLAUDE.md", "SECURITY.md"].includes(name) ||
        /^(?:LICENSE|COPYING)/i.test(name) || /\.(?:tf|tfvars|pem|key)$/i.test(name) ||
        /(?:^|\/)migrations\//i.test(path) ||
        /vault/i.test(name) || /^\.env(?:\.|$)/.test(name) ||
        /(?:^|\/)(?:\.ssh|\.secrets|secrets)(?:\/|$)/.test(path);
}

function ownerPattern(pattern) {
    requireCondition(pattern && !/[!\[\]\\]/.test(pattern), "unsupported CODEOWNERS pattern");
    const anchored = pattern.startsWith("/") || pattern.replace(/\/$/, "").includes("/");
    const directory = pattern.endsWith("/");
    pattern = pattern.replace(/^\//, "").replace(/\/$/, "");
    requireCondition(pattern && !pattern.split("/").some(part => ["", ".", ".."].includes(part)),
        "ambiguous CODEOWNERS pattern");
    let expression = anchored ? "^" : "(?:^|/)";
    for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i];
        if (char === "*" && pattern[i + 1] === "*") {
            i++;
            if (pattern[i + 1] === "/") { expression += "(?:.*/)?"; i++; }
            else expression += ".*";
        } else if (char === "*") expression += "[^/]*";
        else if (char === "?") expression += "[^/]";
        else expression += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    expression += directory ? "/.*$" : "(?:/.*)?$";
    return new RegExp(expression);
}

function parseCodeowners(text) {
    requireCondition(typeof text === "string" && Buffer.byteLength(text) < 1024 * 1024,
        "missing or oversized CODEOWNERS");
    const rules = [];
    for (const line of text.split(/\r?\n/)) {
        const parts = line.split("#", 1)[0].trim().split(/\s+/);
        if (!parts[0]) continue;
        const [pattern, ...owners] = parts;
        requireCondition(owners.length > 0 && owners.every(owner => /^@[a-z\d_-]+(?:\/[a-z\d_-]+)?$/i.test(owner)),
            "unsupported or ownerless CODEOWNERS rule");
        rules.push(ownerPattern(pattern));
    }
    requireCondition(rules.length > 0, "CODEOWNERS has no understood ownership rules");
    return rules;
}

function changedPaths(files, expectedCount) {
    requireCondition(Number.isInteger(expectedCount) && expectedCount > 0 && expectedCount <= 3000 &&
        Array.isArray(files) && files.length === expectedCount, "incomplete changed-file list");
    const paths = [];
    const names = new Set();
    for (const file of files) {
        requireCondition(["added", "removed", "modified", "renamed", "copied", "changed"].includes(file.status),
            "unknown changed-file status");
        const path = validPath(file.filename);
        requireCondition(!names.has(path), "duplicate changed-file entry");
        names.add(path);
        paths.push(path);
        if (["renamed", "copied"].includes(file.status)) {
            paths.push(validPath(file.previous_filename));
        } else requireCondition(!file.previous_filename, "unexplained previous filename");
    }
    return [...new Set(paths)];
}

function checkPr(pr, repo, headSha, baseSha) {
    requireCondition(pr.state === "open" && pr.draft === false && pr.merged === false, "PR is not open and ready");
    requireCondition(pr.head?.repo?.id === repo.id && pr.base?.repo?.id === repo.id,
        "fork or unknown repository");
    requireCondition(pr.base.ref === repo.default_branch && pr.base.sha === baseSha &&
        pr.head.sha === headSha && pr.head.ref !== repo.default_branch, "PR revision or base changed");
    requireCondition([repo.owner.login.toLowerCase(), "williamboglietti-bot"].includes(pr.user?.login?.toLowerCase()),
        "untrusted PR author");
    // 'blocked' is normal while the required approval is still absent.
    requireCondition(pr.mergeable === true && ["clean", "blocked", "unstable", "has_hooks"].includes(pr.mergeable_state),
        "mergeability is unknown, conflicted or behind");
}

function verifyChecks(checks, statuses, expected, headSha, fullName) {
    requireCondition(Array.isArray(checks) && checks.length > 0, "no CI checks exist");
    for (const check of checks) {
        requireCondition(check.head_sha === headSha && check.status === "completed" && check.conclusion === "success",
            "a check is missing, pending, failed, neutral or skipped");
    }
    for (const name of expected) {
        const matches = checks.filter(check => check.name === name);
        requireCondition(matches.length === 1, `missing or ambiguous expected CI check: ${name}`);
        const check = matches[0];
        requireCondition(check.app?.id === ACTIONS_APP_ID && check.app?.slug === "github-actions",
            "expected check did not originate from GitHub Actions");
        const prefix = `https://github.com/${fullName}/actions/runs/`;
        requireCondition(typeof check.details_url === "string" && check.details_url.startsWith(prefix) &&
            /^\d+\/(?:job|jobs)\/\d+$/.test(check.details_url.slice(prefix.length)), "unknown CI provenance URL");
    }
    requireCondition(Array.isArray(statuses), "unknown commit-status response");
    const latest = new Map();
    for (const status of statuses) {
        requireCondition(typeof status.context === "string" && Number.isSafeInteger(status.id), "unknown commit status");
        if (!latest.has(status.context) || latest.get(status.context).id < status.id) latest.set(status.context, status);
    }
    for (const status of latest.values()) requireCondition(status.state === "success", "a commit status is not successful");
}

async function review({github, context, core, inputs}) {
    const {owner, repo} = context.repo;
    requireCondition(`${owner}/${repo}` === TRUSTED_REPOSITORY, "unexpected repository");
    requireCondition(context.eventName === "workflow_dispatch", "only manual dispatch is supported");
    requireCondition(/^[1-9]\d*$/.test(String(inputs.prNumber)), "invalid pull request number");
    const pull_number = Number(inputs.prNumber);
    requireCondition(Number.isSafeInteger(pull_number) && SHA.test(inputs.headSha) && SHA.test(inputs.baseSha),
        "invalid immutable revision");
    requireCondition(context.sha === inputs.baseSha, "trusted checkout differs from dispatch revision");
    const coordinates = {owner, repo};
    const repository = (await github.rest.repos.get(coordinates)).data;
    requireCondition(repository.full_name === TRUSTED_REPOSITORY && Number.isSafeInteger(repository.id) &&
        context.ref === `refs/heads/${repository.default_branch}`, "dispatch is not on the default branch");
    const branch = await github.rest.repos.getBranch({...coordinates, branch: repository.default_branch});
    requireCondition(branch.data.commit.sha === inputs.baseSha, "default branch advanced after dispatch");
    const readBaseFile = async path => {
        const response = (await github.rest.repos.getContent({...coordinates, path, ref: inputs.baseSha})).data;
        requireCondition(response.type === "file" && response.encoding === "base64" &&
            typeof response.content === "string", "unknown trusted-file response");
        return Buffer.from(response.content, "base64").toString("utf8");
    };
    const ownership = parseCodeowners(await readBaseFile(".github/CODEOWNERS"));
    for (const workflow of CI_CONTRACT) {
        const text = await readBaseFile(workflow.path);
        requireCondition(createHash("sha256").update(text).digest("hex") === workflow.sha256,
            `trusted CI contract changed: ${workflow.path}`);
    }
    const getPr = async () => (await github.rest.pulls.get({...coordinates, pull_number})).data;
    const pr = await getPr();
    checkPr(pr, repository, inputs.headSha, inputs.baseSha);
    const files = await github.paginate(github.rest.pulls.listFiles, {...coordinates, pull_number, per_page: 100});
    const paths = changedPaths(files, pr.changed_files);
    requireCondition(!paths.some(path => sensitive(path) || ownership.some(rule => rule.test(path))),
        "sensitive or CODEOWNERS-owned change requires William");
    const comparison = (await github.rest.repos.compareCommitsWithBasehead({...coordinates,
        basehead: `${inputs.baseSha}...${inputs.headSha}`})).data;
    requireCondition(comparison.status === "ahead" && comparison.behind_by === 0 && comparison.ahead_by > 0 &&
        comparison.merge_base_commit?.sha === inputs.baseSha, "PR branch does not contain the current default branch");
    const expected = CI_CONTRACT.filter(workflow => paths.some(workflow.applies)).flatMap(workflow => workflow.checks);
    const readChecks = async () => {
        const checks = await github.paginate(github.rest.checks.listForRef,
            {...coordinates, ref: inputs.headSha, filter: "latest", per_page: 100});
        const statuses = await github.paginate(github.rest.repos.listCommitStatusesForRef,
            {...coordinates, ref: inputs.headSha, per_page: 100});
        verifyChecks(checks, statuses, expected, inputs.headSha, repository.full_name);
    };
    await readChecks();
    const readReviews = async () => {
        const reviews = await github.paginate(github.rest.pulls.listReviews, {...coordinates, pull_number, per_page: 100});
        const latest = new Map();
        for (const item of reviews) {
            requireCondition(item.user?.login && Number.isSafeInteger(item.id) &&
                ["APPROVED", "CHANGES_REQUESTED", "DISMISSED", "COMMENTED"].includes(item.state), "unknown or pending review metadata");
            if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(item.state) &&
                (!latest.has(item.user.login) || latest.get(item.user.login).id < item.id)) latest.set(item.user.login, item);
        }
        requireCondition(![...latest.values()].some(item => item.state === "CHANGES_REQUESTED"),
            "an unresolved review requests changes");
        return latest;
    };
    await readReviews();
    // Re-read live base and all statuses; the final request immediately before
    // createReview re-checks PR state and both SHAs. commit_id binds approval to
    // this revision even if a push races the final API request (no atomic CAS).
    const finalRepository = (await github.rest.repos.get(coordinates)).data;
    requireCondition(finalRepository.id === repository.id && finalRepository.full_name === repository.full_name &&
        finalRepository.default_branch === repository.default_branch, "repository default branch changed during review");
    const finalBranch = await github.rest.repos.getBranch({...coordinates, branch: repository.default_branch});
    requireCondition(finalBranch.data.commit.sha === inputs.baseSha, "default branch moved during review");
    await readChecks();
    const latestReviews = await readReviews();
    const finalPr = await getPr();
    checkPr(finalPr, repository, inputs.headSha, inputs.baseSha);
    requireCondition(finalPr.changed_files === pr.changed_files, "changed-file metadata changed during review");
    const previous = latestReviews.get(REVIEWER);
    if (previous?.state === "APPROVED" && previous.commit_id === inputs.headSha) {
        core.info(`Already approved exact revision ${inputs.headSha}; no duplicate review.`);
        return {approved: false, alreadyApproved: true, headSha: inputs.headSha};
    }
    const result = (await github.rest.pulls.createReview({...coordinates, pull_number,
        commit_id: inputs.headSha, event: "APPROVE",
        body: `Automated ordinary-change gate: expected CI checks passed for ${inputs.headSha}; ` +
            `current base ${inputs.baseSha}; no changed path belongs to CODEOWNERS or the sensitive-path policy. ` +
            "This is a CI/policy approval, not a semantic code review. No merge or deployment performed.",
    })).data;
    requireCondition(result.state === "APPROVED" && result.commit_id === inputs.headSha, "approval API response is uncertain");
    core.info(`Approved exact revision ${inputs.headSha}; no merge performed.`);
    return {approved: true, headSha: inputs.headSha, reviewId: result.id};
}

module.exports = review;
module.exports.testing = {CI_CONTRACT, changedPaths, parseCodeowners, verifyChecks, checkPr};
