// Computes a github-readme-stats style rank from all-time totals, including
// private contributions visible to the token owner, and writes an SVG card.
// Usage: GH_TOKEN=... node rank.mjs <login> <output.svg>
import { writeFileSync } from "node:fs";

const [login, output = "github-rank.svg"] = process.argv.slice(2);
const token = process.env.GH_TOKEN;
if (!login || !token) {
  console.error("Usage: GH_TOKEN=... node rank.mjs <login> [output.svg]");
  process.exit(1);
}

async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors ?? json));
  return json.data;
}

const { user } = await gql(
  `query($login: String!) {
    user(login: $login) {
      createdAt
      followers { totalCount }
      prs: pullRequests { totalCount }
      issues { totalCount }
    }
  }`,
  { login },
);

// contributionsCollection spans at most one year, so walk year by year.
let commits = 0;
let reviews = 0;
const now = new Date();
for (let from = new Date(user.createdAt); from < now; ) {
  const to = new Date(Math.min(new Date(from).setFullYear(from.getFullYear() + 1) - 1, now));
  const { user: u } = await gql(
    `query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          totalCommitContributions
          restrictedContributionsCount
          totalPullRequestReviewContributions
        }
      }
    }`,
    { login, from: from.toISOString(), to: to.toISOString() },
  );
  const c = u.contributionsCollection;
  commits += c.totalCommitContributions + c.restrictedContributionsCount;
  reviews += c.totalPullRequestReviewContributions;
  from = new Date(to.getTime() + 1);
}

let stars = 0;
for (let cursor = null, more = true; more; ) {
  const { user: u } = await gql(
    `query($login: String!, $cursor: String) {
      user(login: $login) {
        repositories(first: 100, after: $cursor, ownerAffiliations: OWNER, isFork: false) {
          nodes { stargazerCount }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`,
    { login, cursor },
  );
  const r = u.repositories;
  stars += r.nodes.reduce((sum, n) => sum + n.stargazerCount, 0);
  ({ hasNextPage: more, endCursor: cursor } = r.pageInfo);
}

const stats = {
  commits,
  prs: user.prs.totalCount,
  issues: user.issues.totalCount,
  reviews,
  stars,
  followers: user.followers.totalCount,
};

// Same formula as github-readme-stats calculateRank (all-commits mode).
const exponentialCdf = (x) => 1 - 2 ** -x;
const logNormalCdf = (x) => x / (1 + x);
const weights = [
  [2, exponentialCdf(stats.commits / 1000)],
  [3, exponentialCdf(stats.prs / 50)],
  [1, exponentialCdf(stats.issues / 25)],
  [1, exponentialCdf(stats.reviews / 2)],
  [4, logNormalCdf(stats.stars / 50)],
  [1, logNormalCdf(stats.followers / 10)],
];
const totalWeight = weights.reduce((sum, [w]) => sum + w, 0);
const percentile = (1 - weights.reduce((sum, [w, v]) => sum + w * v, 0) / totalWeight) * 100;
const thresholds = [1, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100];
const levels = ["S", "A+", "A", "A-", "B+", "B", "B-", "C+", "C"];
const level = levels[thresholds.findIndex((t) => percentile <= t)];

const rows = [
  ["Total commits", stats.commits],
  ["Total PRs", stats.prs],
  ["Total issues", stats.issues],
  ["PR reviews", stats.reviews],
  ["Stars earned", stats.stars],
  ["Followers", stats.followers],
];
const radius = 40;
const circumference = 2 * Math.PI * radius;
const progress = circumference * (1 - (100 - percentile) / 100);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="200" viewBox="0 0 420 200">
  <style>
    .bg { fill: #ffffff; } .title { fill: #2f80ed; } .text { fill: #434d58; } .ring-bg { stroke: #2f80ed33; } .ring { stroke: #2f80ed; }
    @media (prefers-color-scheme: dark) {
      .bg { fill: #0d1117; } .title { fill: #58a6ff; } .text { fill: #c9d1d9; } .ring-bg { stroke: #58a6ff33; } .ring { stroke: #58a6ff; }
    }
    text { font-family: "Segoe UI", Ubuntu, Sans-Serif; }
  </style>
  <rect class="bg" width="420" height="200" rx="6"/>
  <text class="title" x="24" y="34" font-size="18" font-weight="600">${login}'s GitHub Rank</text>
  ${rows
    .map(
      ([label, value], i) =>
        `<text class="text" x="24" y="${66 + i * 22}" font-size="14">${label}:</text>` +
        `<text class="text" x="200" y="${66 + i * 22}" font-size="14" font-weight="700">${value.toLocaleString("en-US")}</text>`,
    )
    .join("\n  ")}
  <g transform="translate(340 115)">
    <circle class="ring-bg" r="${radius}" fill="none" stroke-width="6"/>
    <circle class="ring" r="${radius}" fill="none" stroke-width="6" stroke-linecap="round"
      stroke-dasharray="${circumference}" stroke-dashoffset="${progress}" transform="rotate(-90)"/>
    <text class="text" y="10" font-size="28" font-weight="800" text-anchor="middle">${level}</text>
  </g>
</svg>
`;

writeFileSync(output, svg);
console.log(JSON.stringify({ ...stats, percentile: +percentile.toFixed(2), level }));
