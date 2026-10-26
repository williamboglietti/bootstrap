"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const review = require("../.github/scripts/review-validated-pr.cjs");
const {CI_CONTRACT, changedPaths, parseCodeowners} = review.testing;

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const NEXT = "3".repeat(40);
const ROOT = path.resolve(__dirname, "..");

function fixture() {
    const data = {
        repo: {id: 42, full_name: "williamboglietti/bootstrap", owner: {login: "williamboglietti"}, default_branch: "main"},
        branch: {commit: {sha: BASE}},
        pr: {state: "open", draft: false, merged: false, changed_files: 1,
            head: {sha: HEAD, ref: "codex/routine", repo: {id: 42}},
            base: {sha: BASE, ref: "main", repo: {id: 42}},
            user: {login: "williamboglietti-bot"}, mergeable: true, mergeable_state: "blocked"},
        files: [{filename: "roles/common/tasks/main.yml", status: "modified"}],
        comparison: {status: "ahead", behind_by: 0, ahead_by: 2, merge_base_commit: {sha: BASE}},
        checks: ["shellcheck", "automation.sh (debian:13)", "automation.sh (ubuntu:24.04)", "review-policy"].map((name, index) => ({
            id: index + 1, name, head_sha: HEAD, status: "completed", conclusion: "success",
            app: {id: 15368, slug: "github-actions"},
            details_url: `https://github.com/williamboglietti/bootstrap/actions/runs/100/job/${index + 10}`,
        })),
        statuses: [], reviews: [], calls: [], approved: [], overrides: {},
        contents: Object.fromEntries([".github/CODEOWNERS", ...CI_CONTRACT.map(item => item.path)]
            .map(filename => [filename, fs.readFileSync(path.join(ROOT, filename), "utf8")])),
    };
    const make = (name, get) => {
        const counts = {value: 0};
        const method = async params => {
            counts.value++;
            data.calls.push({name, params});
            if (data.overrides[name]) return {data: await data.overrides[name](params, counts.value)};
            return {data: get(params, counts.value)};
        };
        method.endpointName = name;
        return method;
    };
    const github = {rest: {
        repos: {
            get: make("repo", () => data.repo), getBranch: make("branch", () => data.branch),
            getContent: make("contents", params => ({type: "file", encoding: "base64",
                content: Buffer.from(data.contents[params.path]).toString("base64")})),
            compareCommitsWithBasehead: make("compare", () => data.comparison),
            listCommitStatusesForRef: make("statuses", () => data.statuses),
        },
        pulls: {
            get: make("pr", () => data.pr), listFiles: make("files", () => data.files),
            listReviews: make("reviews", () => data.reviews),
            createReview: make("approve", params => {
                data.approved.push(params);
                return {id: 1000, state: "APPROVED", commit_id: params.commit_id};
            }),
        },
        checks: {listForRef: make("checks", () => data.checks)},
    }};
    github.paginate = async (method, params) => (await method(params)).data;
    const context = {repo: {owner: "williamboglietti", repo: "bootstrap"},
        eventName: "workflow_dispatch", ref: "refs/heads/main", sha: BASE};
    const inputs = {prNumber: "12", headSha: HEAD, baseSha: BASE};
    const core = {info() {}};
    return {data, github, context, inputs, core};
}

async function refuses(modify, pattern = /Review refused/) {
    const state = fixture();
    modify(state);
    await assert.rejects(review(state), pattern);
    assert.equal(state.data.approved.length, 0, "a refused PR must never be approved");
    assert.equal(state.data.calls.some(call => call.name === "approve"), false);
}

test("approves a valid ordinary PR only at its exact immutable head", async () => {
    const state = fixture();
    const result = await review(state);
    assert.equal(result.approved, true);
    assert.equal(state.data.approved.length, 1);
    assert.equal(state.data.approved[0].commit_id, HEAD);
    assert.equal(state.data.approved[0].event, "APPROVE");
    assert.deepEqual(state.data.calls.slice(-2).map(call => call.name), ["pr", "approve"]);
    for (const call of state.data.calls.filter(call => call.name === "contents")) assert.equal(call.params.ref, BASE);
    assert.equal(state.data.calls.filter(call => call.name === "checks").length, 2);
    assert.equal(state.data.calls.filter(call => call.name === "statuses").length, 2);
});

test("allows the repository owner as author", async () => {
    const state = fixture();
    state.data.pr.user.login = "williamboglietti";
    assert.equal((await review(state)).approved, true);
});

test("does not duplicate an exact existing GitHub Actions approval", async () => {
    const state = fixture();
    state.data.reviews = [{id: 99, user: {login: "github-actions[bot]"}, state: "APPROVED", commit_id: HEAD}];
    assert.equal((await review(state)).alreadyApproved, true);
    assert.equal(state.data.approved.length, 0);
});

for (const [name, modify] of [
    ["a non-dispatch event", state => {state.context.eventName = "pull_request_target";}],
    ["dispatch on a feature branch", state => {state.context.ref = "refs/heads/codex/change";}],
    ["an unknown repository", state => {state.context.repo.repo = "other";}],
    ["malformed PR number", state => {state.inputs.prNumber = "12; echo no";}],
    ["an unsafe PR number", state => {state.inputs.prNumber = "9999999999999999999999";}],
    ["a short requested head", state => {state.inputs.headSha = "abc123";}],
    ["a dispatch checkout mismatch", state => {state.context.sha = NEXT;}],
    ["a draft", state => {state.data.pr.draft = true;}],
    ["a closed PR", state => {state.data.pr.state = "closed";}],
    ["a fork", state => {state.data.pr.head.repo.id = 77;}],
    ["an untrusted author", state => {state.data.pr.user.login = "other-user";}],
    ["a different base branch", state => {state.data.pr.base.ref = "release";}],
    ["a wrong requested head", state => {state.data.pr.head.sha = NEXT;}],
    ["unknown mergeability", state => {state.data.pr.mergeable = null;}],
    ["a behind merge state", state => {state.data.pr.mergeable_state = "behind";}],
    ["a diverged branch", state => {state.data.comparison.status = "diverged"; state.data.comparison.behind_by = 1;}],
    ["a false comparison ancestor", state => {state.data.comparison.merge_base_commit.sha = NEXT;}],
    ["default advanced before dispatch execution", state => {state.data.branch.commit.sha = NEXT;}],
    ["an incomplete file listing", state => {state.data.pr.changed_files = 2;}],
    ["a large truncated PR", state => {state.data.pr.changed_files = 3001;}],
    ["an unknown file status", state => {state.data.files[0].status = "mystery";}],
    ["a missing CI check", state => {state.data.checks.pop();}],
    ["no checks", state => {state.data.checks = [];}],
    ["duplicate expected checks", state => {state.data.checks.push({...state.data.checks[0]});}],
    ["a check on another revision", state => {state.data.checks[0].head_sha = NEXT;}],
    ["spoofed CI provider", state => {state.data.checks[0].app = {id: 999, slug: "other-app"};}],
    ["spoofed CI details URL", state => {state.data.checks[0].details_url = "https://example.com/actions/runs/100/job/10";}],
    ["an unresolved changes-requested review", state => {state.data.reviews = [{id: 3, user: {login: "williamboglietti"}, state: "CHANGES_REQUESTED"}];}],
    ["an unknown CODEOWNERS syntax", state => {state.data.contents[".github/CODEOWNERS"] = "!roles/ @williamboglietti\n";}],
    ["an ownerless CODEOWNERS carveout", state => {state.data.contents[".github/CODEOWNERS"] += "\n/roles/\n";}],
    ["a changed trusted CI contract", state => {state.data.contents[".github/workflows/validate.yml"] += "\n# unreceived\n";}],
]) test(`refuses ${name}`, () => refuses(modify));

for (const conclusion of ["failure", "skipped", "neutral", "cancelled", "timed_out", "action_required", null]) {
    test(`refuses check conclusion ${conclusion}`, () => refuses(state => {state.data.checks[0].conclusion = conclusion;}));
}
test("refuses a pending check with a stale success conclusion", () => refuses(state => {state.data.checks[0].status = "in_progress";}));
test("refuses an unexpected extra failing check", () => refuses(state => {state.data.checks.push({...state.data.checks[0], name: "another job", conclusion: "failure"});}));
test("refuses a pending latest legacy status", () => refuses(state => {state.data.statuses = [{id: 2, context: "external", state: "pending"}];}));
test("uses latest commit status per context instead of an old pending status", async () => {
    const state = fixture();
    state.data.statuses = [{id: 1, context: "external", state: "pending"}, {id: 2, context: "external", state: "success"}];
    assert.equal((await review(state)).approved, true);
});

for (const filename of ["automation.sh", "enroll.sh", "tests/test-automation.sh", "group_vars/all/ssh_access.yml", "group_vars/all/extra_vault.yml", "playbooks/ssh-access.yml",
    ".github/workflows/validate.yml", ".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS", "AGENTS.md", ".env",
    "LICENSE", "vendor/adapter/LICENSE-MIT", "COPYING.txt", "vendor/adapter/copying.extra",
    "migrations/001.sql", "app/db/migrations/001.sql", "infra/main.tf", "infra/env/production.tfvars",
    "certificates/client.pem", "certificates/client.key"]) {
    test(`refuses sensitive path ${filename}`, () => refuses(state => {state.data.files[0].filename = filename;}));
}
test("honors an additional immutable-base CODEOWNER", () => refuses(state => {state.data.contents[".github/CODEOWNERS"] += "\n/roles/common/ @williamboglietti\n";}));
test("refuses a renamed-away owned path", () => refuses(state => {
    state.data.files = [{filename: "group_vars/all/ordinary.yml", previous_filename: "group_vars/all/ssh_access.yml", status: "renamed"}];
}));
test("refuses a missing previous name on rename", () => refuses(state => {state.data.files[0].status = "renamed";}));
for (const previous_filename of ["vendor/LICENSE.txt", "app/migrations/001.sql", "infra/main.tfvars", "keys/client.pem"]) {
    test(`refuses renamed-away sensitive path ${previous_filename}`, () => refuses(state => {
        state.data.files = [{filename: "src/ordinary.txt", previous_filename, status: "renamed"}];
    }));
}

test("refuses a push during the review", () => refuses(state => {
    state.data.overrides.pr = (_params, count) => count === 1 ? state.data.pr : {...state.data.pr, head: {...state.data.pr.head, sha: NEXT}};
}));
test("refuses a draft conversion during the review", () => refuses(state => {
    state.data.overrides.pr = (_params, count) => count === 1 ? state.data.pr : {...state.data.pr, draft: true};
}));
test("refuses default advancing during review", () => refuses(state => {
    state.data.overrides.branch = (_params, count) => count === 1 ? state.data.branch : {commit: {sha: NEXT}};
}));
test("refuses the repository changing its default branch during review", () => refuses(state => {
    state.data.overrides.repo = (_params, count) => count === 1 ? state.data.repo : {...state.data.repo, default_branch: "replacement"};
}));
test("refuses a rerun becoming pending before approval", () => refuses(state => {
    state.data.overrides.checks = (_params, count) => count === 1 ? state.data.checks : state.data.checks.map(item => ({...item, status: "queued", conclusion: null}));
}));
test("refuses a new changes-requested review just before approval", () => refuses(state => {
    state.data.overrides.reviews = (_params, count) => count === 1 ? [] : [
        {id: 100, user: {login: "williamboglietti"}, state: "CHANGES_REQUESTED"},
    ];
}));
test("does not claim approval when GitHub's approval permission is disabled", async () => {
    const state = fixture();
    state.data.overrides.approve = () => {throw new Error("403: approval permission disabled");};
    await assert.rejects(review(state), /approval permission disabled/);
    assert.equal(state.data.approved.length, 0);
});
test("API uncertainty prevents any approval", () => refuses(state => {
    state.data.overrides.contents = () => {throw new Error("temporary API failure");};
}, /temporary API failure/));

test("CODEOWNERS subset matches anchored, basename and recursive patterns", () => {
    const rules = parseCodeowners("/group_vars/all/*vault.yml @owner\n.github/ @owner\n*.pem @owner\n/docs/**/private/ @owner\n");
    assert.equal(rules.some(rule => rule.test("group_vars/all/db_vault.yml")), true);
    assert.equal(rules.some(rule => rule.test("nested/.github/inside.yml")), true);
    assert.equal(rules.some(rule => rule.test("keys/client.pem")), true);
    assert.equal(rules.some(rule => rule.test("docs/private/file")), true);
    assert.equal(rules.some(rule => rule.test("docs/nested/private/file")), true);
    assert.equal(rules.some(rule => rule.test("roles/ordinary.yml")), false);
});
test("changed paths reject traversal, backslash and duplicates", () => {
    for (const filename of ["../file", "/file", "a/../file", "a\\file", "a//file"]) {
        assert.throws(() => changedPaths([{filename, status: "modified"}], 1));
    }
    assert.throws(() => changedPaths([{filename: "same", status: "modified"}, {filename: "same", status: "modified"}], 2));
});

test("workflow is dispatch-only, pinned, and never checks out a PR revision", () => {
    const source = fs.readFileSync(path.join(ROOT, ".github/workflows/agent-pr-review.yml"), "utf8");
    assert.match(source, /workflow_dispatch:/);
    assert.doesNotMatch(source, /^  (?:pull_request|pull_request_target|push|schedule|workflow_run):/m);
    assert.match(source, /ref: \$\{\{ github\.sha \}\}/);
    assert.doesNotMatch(source, /ref: .*inputs\.|actions: write|contents: write|id-token: write/);
    assert.equal([...source.matchAll(/uses: ([^\s]+)@([^\s]+)/g)].every(match => /^[a-f0-9]{40}$/.test(match[2])), true);
});

for (const name of ["shellcheck", "automation.sh (debian:13)", "automation.sh (ubuntu:24.04)", "review-policy"]) {
    test(`refuses when required bootstrap check ${name} is missing`, () => refuses(state => {
        state.data.checks = state.data.checks.filter(check => check.name !== name);
    }));
}
for (const filename of ["automation.sh", "enroll.sh"]) {
    test(`refuses ${filename} even without a matching CODEOWNER`, () => refuses(state => {
        state.data.files[0].filename = filename;
        state.data.contents[".github/CODEOWNERS"] = "/.github/ @williamboglietti\n";
    }));
}
