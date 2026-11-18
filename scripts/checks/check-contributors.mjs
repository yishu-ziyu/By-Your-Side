import { execFileSync } from "node:child_process";

const ALLOWED_EMAILS = new Set([
  "yishuziyu@gmail.com",
  "153627025+yishu-ziyu@users.noreply.github.com",
  "yishu-ziyu@users.noreply.github.com",
  "noreply@anthropic.com",
  "swdzy8y6kw@privaterelay.appleid.com",
]);

function extractEmail(raw) {
  const match = raw.match(/<([^<>]+)>/);
  return match ? match[1].trim().toLowerCase() : "";
}

function collectProblems(target) {
  const output = execFileSync(
    "git",
    ["log", target, "--format=%h%x09%an <%ae>%x09%(trailers:key=Co-authored-by,valueonly=true,separator=%x1f)"],
    { encoding: "utf8", maxBuffer: 1 << 26 },
  );
  const problems = [];
  for (const row of output.split("\n")) {
    if (!row) continue;
    const [sha, author, coauthors = ""] = row.split("\t");
    const authorEmail = extractEmail(author);
    if (!ALLOWED_EMAILS.has(authorEmail)) {
      problems.push(`${sha} Author 不在允许列表：${author}`);
    }
    for (const item of coauthors.split("\x1f")) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      const email = extractEmail(trimmed);
      if (!ALLOWED_EMAILS.has(email)) {
        problems.push(`${sha} Co-authored-by 不在允许列表：${trimmed}`);
      }
    }
  }
  return problems;
}

const target = process.argv[2] || "HEAD";
const problems = collectProblems(target);
if (problems.length > 0) {
  console.error("发现未允许的提交署名（仅允许本人与 Claude）：");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`check:contributors 通过（范围：${target}）。`);
