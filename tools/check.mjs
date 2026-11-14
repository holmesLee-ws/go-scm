#!/usr/bin/env node
// 리포 관리자용 검사기. 학습자에게는 필요 없다.
// 검사: 커리큘럼 형식·선수 관계, 국내 근거와 출처 표 대조·조문 번호 없음(R11), 미리 만든 시각 자료 없음(R5), 설정 JSON 유효성.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const read = (p) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");

const LEVELS = ["Explain", "Apply", "Evaluate", "Develop"];
const FIELDS = ["선수", "핵심 질문", "목표", "만들어 볼 것", "국내 근거", "글로벌 비교"];
const OPTIONAL = ["경계·연결"];
const EXEMPT = /^(실무 기준 —|학습자가 고른)/;

// 괄호 밖의 쉼표로만 나눈다.
function splitItems(v) {
  const out = []; let depth = 0, cur = "";
  for (const ch of v) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// 공식 출처로 인정하는 도메인(spec R11). 새 기관을 쓰면 여기와 spec에 함께 더한다.
const OFFICIAL = ["go.kr", "korea.kr", "iccwbo.org", "wcoomd.org", "wto.org", "europa.eu", "ascm.org", "iso.org", "gs1.org", "trade.gov", "hbr.org", "doi.org", "openlibrary.org"];
const sourceProblems = [];

function sourceNames(text) {
  const i = text.indexOf("\n## 출처");
  if (i < 0) return null;
  const names = new Set();
  for (const line of text.slice(i).split("\n")) {
    if (!line.startsWith("| ") || /^\| (이름|---)/.test(line)) continue;
    const m = line.match(/^\| ([^|]+?) \| [^|]+ \| (https?:\/\/[^\s|]+) \| (\d{4}-\d{2}-\d{2}) \|/);
    if (!m) { sourceProblems.push(`출처 표 행 형식 오류(이름 | 종류 | 맨 URL | YYYY-MM-DD | …): ${line.slice(0, 60)}`); continue; }
    const host = new URL(m[2]).hostname.replace(/^www\./, "");
    if (!OFFICIAL.some((d) => host === d || host.endsWith(`.${d}`))) sourceProblems.push(`출처 표 비공식 도메인: ${m[1].trim()} → ${host}`);
    names.add(m[1].trim());
  }
  return names;
}

function parseCurriculum(text) {
  const modules = new Map();
  const problems = [];
  const main = text.split(/^## 겹침 경계/m)[0];
  const blocks = main.split(/^### /m).slice(1);
  const sources = sourceNames(text);
  if (!sources || sources.size === 0) problems.push("출처 표가 없거나 비어 있음(이름 | 종류 | URL | 조회일)");
  for (const m of text.normalize("NFKC").matchAll(/(제\s*\d+\s*조|\d+\s*조\s*(제\s*\d+\s*항|의\s*\d+))/g)) problems.push(`조문 번호 금지: ${m[0]}`);
  const tail = text.slice(main.length);
  for (const m of tail.matchAll(/^### ([FPBLTDXE]\d+)/gm)) problems.push(`${m[1]}: 「겹침 경계」 뒤에 있는 모듈은 검사되지 않으므로 금지`);
  for (const block of blocks) {
    const head = block.split("\n")[0];
    const m = head.match(/^([FPBLTDX]\d+) · (.+)$/);
    if (!m) { problems.push(`모듈 제목 형식 오류: ${head}`); continue; }
    const id = m[1];
    if (modules.has(id)) problems.push(`${id}: 중복 id`);
    const fields = {};
    for (const line of block.split("\n").slice(1)) {
      const f = line.match(/^- ([^:]+): (.+)$/);
      if (f) fields[f[1]] = f[2];
      if (f && !FIELDS.includes(f[1]) && !OPTIONAL.includes(f[1])) problems.push(`${id}: 모르는 칸 「${f[1]}」`);
    }
    if (fields["국내 근거"] && sources) for (const item of splitItems(fields["국내 근거"])) {
      if (EXEMPT.test(item)) continue;
      const name = item.split("(")[0].trim();
      if (!sources.has(name)) problems.push(`${id}: 국내 근거 「${name}」가 출처 표에 없음`);
    }
    for (const name of FIELDS) if (!fields[name]) problems.push(`${id}: 「${name}」 없음`);
    if (fields["목표"] && !LEVELS.some((l) => fields["목표"].startsWith(`${l} — `))) problems.push(`${id}: 목표 수준 형식 오류`);
    const prereq = !fields["선수"] || fields["선수"] === "없음" ? [] : fields["선수"].split(",").map((s) => s.trim());
    modules.set(id, prereq);
  }
  for (const [id, prereq] of modules) for (const p of prereq) if (!modules.has(p)) problems.push(`${id}: 없는 선수 ${p}`);
  const state = new Map();
  const visit = (id, path) => {
    if (state.get(id) === 2 || !modules.has(id)) return;
    if (state.get(id) === 1) { problems.push(`선수 순환: ${[...path, id].join(" → ")}`); return; }
    state.set(id, 1);
    for (const p of modules.get(id)) visit(p, [...path, id]);
    state.set(id, 2);
  };
  for (const id of modules.keys()) visit(id, []);
  problems.push(...sourceProblems);
  return { modules, problems };
}

function findVisualAssets(files) {
  const allowedJs = /^tools\/.*\.m?js$/;
  const visual = /\.(html?|xhtml|css|svgz?|png|jpe?g|gif|webp|avif|ico|bmp|tiff?|heic|heif|pdf|pptx?|key)$/i;
  const script = /\.(m?js|cjs|jsx|tsx?)$/i;
  return files.filter((f) => visual.test(f) || (script.test(f) && !allowedJs.test(f)));
}

function findTemplateMarkup(name, text) {
  const hits = [];
  for (const m of text.matchAll(/(```|~~~)[\s\S]*?\1/g)) if (/<(!doctype|html|svg|style|canvas|script)\b/i.test(m[0])) hits.push(name);
  return hits;
}

function main() {
  const { modules, problems } = parseCurriculum(read("curriculum/map.md"));
  errors.push(...problems);
  if (modules.size === 0) errors.push("모듈을 찾지 못함");

  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const f of findVisualAssets(files)) errors.push(`미리 만든 시각 자료 금지: ${f}`);
  for (const f of files.filter((x) => x.endsWith(".md") && existsSync(join(root, x)))) for (const n of findTemplateMarkup(f, read(f))) errors.push(`복사용 마크업 금지: ${n}`);

  for (const p of [".claude/settings.json", "learner-template/state.json"]) {
    try { JSON.parse(read(p)); } catch (e) { errors.push(`${p}: JSON 오류 ${e.constructor.name}`); }
  }
  if (!existsSync(join(root, "learner-template/log.md"))) errors.push("learner-template/log.md 없음");
  for (const s of readdirSync(join(root, ".claude/skills"))) {
    if (statSync(join(root, ".claude/skills", s)).isDirectory() && !existsSync(join(root, ".claude/skills", s, "SKILL.md"))) errors.push(`스킬 ${s}: SKILL.md 없음`);
  }
  try { execFileSync("git", ["check-ignore", "-q", "learner/state.json"], { cwd: root }); } catch { errors.push("learner/가 git에서 제외되지 않음(.gitignore)"); }

  // 권한이 넓어지는 회귀를 막는다. 바꿀 때는 이 목록도 함께 고친다.
  const ALLOW = ["Edit(/learner/state.json)", "Edit(/learner/log.md)", "Edit(/learner/studio/**/*.html)", "Edit(/learner/work/**)", "WebSearch", "WebFetch", "Bash(open learner/studio/*.html)", "Bash(xdg-open learner/studio/*.html)", "Bash(start \"\" learner/studio/*.html)", "PowerShell(Start-Process learner/studio/*.html)"];
  try {
    const allow = JSON.parse(read(".claude/settings.json")).permissions?.allow ?? [];
    if (JSON.stringify([...allow].sort()) !== JSON.stringify([...ALLOW].sort())) errors.push(`settings.json allow 목록이 고정 목록과 다름: ${allow.filter((a) => !ALLOW.includes(a)).join(", ") || "(누락)"}`);
  } catch {}

  if (errors.length) { console.error(errors.map((e) => `FAIL ${e}`).join("\n")); process.exit(1); }
  console.log(`OK 모듈 ${modules.size}개, 파일 ${files.length}개 검사`);
}

main();
