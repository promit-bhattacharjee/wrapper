// Auto-generator for ultra-concise IDE instruction files (AGENTS.md canonical + CLAUDE.md, GEMINI.md,
// and optional .github/copilot-instructions.md pointers) wired to .wrapper/docs/{deploy.json,specs/}.
// Keeps instructions <35 lines to prevent ETH-Zurich-documented context bloat.
import fs from 'node:fs';
import path from 'node:path';
import { ensureWrapperDirs, readJson, writeAtomic, normSlash } from './io.mjs';
import { listSpecs, syncDeployment } from './docs.mjs';

const MARK_BEGIN = '<!-- wrapper:v4:begin -->';
const MARK_END = '<!-- wrapper:v4:end -->';

function buildCanonicalBlock(baseDir, cliRel) {
  const p = ensureWrapperDirs(baseDir);
  const deploy = fs.existsSync(p.deploy) ? readJson(p.deploy, {}) : syncDeployment(baseDir);
  const specs = listSpecs(baseDir).map((s) => s.feat);
  return [
    MARK_BEGIN,
    '## Wrapper v4.2 Engine (Machine-Compact State)',
    `- State directories: \`.wrapper/docs/\` (specs, taste, deploy), \`.wrapper/agents/\` (roster, teams, ledger), \`.wrapper/track/\` (SQLite WAL matrix, desks, receipts).`,
    `- Living functional specs: ${specs.length ? specs.map((s) => `\`.wrapper/docs/specs/${s}.spec.jsonl\``).join(', ') : '`(run wrapper re spec-upsert to add)`'}.`,
    `- Deployment contract: \`.wrapper/docs/deploy.json\` (\`${deploy.main_branch || 'main'} -> ${deploy.deploy_branch || 'deploy/backend'}\`, gate: \`${deploy.gate || 'ci_green'}\`).`,
    `- Before coding: fetch your surgical slice via \`node ${cliRel} ctx --emp <emp-id>\` (never load raw symbol codes without expansion).`,
    `- Blind TDD & Receipts: Engineers NEVER edit locked QA blind tests. Run \`node ${cliRel} test --emp <emp-id> --task <TK-id> --cmd "<test-cmd>"\` before \`submit\`.`,
    `- Commits: include trailer \`Agent-Id: <emp-id>\` so HR tracks clean passes and git-blame regressions.`,
    `- Human decode on demand: \`node ${cliRel} inspect\`.`,
    MARK_END,
  ].join('\n');
}

function upsertManagedFile(filePath, fullDefaultContent, blockContent, { updateExistingBlock = true } = {}) {
  if (!fs.existsSync(filePath)) {
    writeAtomic(filePath, fullDefaultContent.trimEnd() + '\n');
    return { path: normSlash(filePath), action: 'created' };
  }
  const cur = fs.readFileSync(filePath, 'utf8');
  if (updateExistingBlock && cur.includes(MARK_BEGIN) && cur.includes(MARK_END)) {
    const start = cur.indexOf(MARK_BEGIN);
    const end = cur.indexOf(MARK_END) + MARK_END.length;
    const next = cur.slice(0, start) + blockContent + cur.slice(end);
    if (next !== cur) {
      writeAtomic(filePath, next);
      return { path: normSlash(filePath), action: 'updated_block' };
    }
  }
  return { path: normSlash(filePath), action: 'preserved_existing' };
}

export function ensureIdeFiles(baseDir, { cliPath = '.agents/plugins/wrapper/bin/wrapper.mjs', copilot = false } = {}) {
  const p = ensureWrapperDirs(baseDir);
  const block = buildCanonicalBlock(baseDir, normSlash(cliPath));
  const results = [];

  // 1. AGENTS.md (canonical cross-tool standard read by Codex/ChatGPT, Antigravity, OpenCode, Cursor, Windsurf)
  const agentsMd = path.join(p.base, 'AGENTS.md');
  results.push(upsertManagedFile(
    agentsMd,
    `# Project Agent Instructions\n\n${block}\n`,
    block,
  ));

  // 2. CLAUDE.md (thin pointer for Claude Code)
  const claudeMd = path.join(p.base, 'CLAUDE.md');
  const claudePointer = `# Claude Code Instructions\n\nRead and follow \`AGENTS.md\` in this directory.\n\n${block}\n`;
  results.push(upsertManagedFile(claudeMd, claudePointer, block));

  // 3. GEMINI.md (thin pointer for Gemini / Antigravity)
  const geminiMd = path.join(p.base, 'GEMINI.md');
  const geminiPointer = `# Gemini & Antigravity Instructions\n\nRead and follow \`AGENTS.md\` in this directory.\n\n${block}\n`;
  results.push(upsertManagedFile(geminiMd, geminiPointer, block));

  // 4. Optional GitHub Copilot instructions
  if (copilot) {
    const copilotMd = path.join(p.base, '.github', 'copilot-instructions.md');
    results.push(upsertManagedFile(
      copilotMd,
      `# GitHub Copilot Instructions\n\nFollow \`AGENTS.md\` in the repository root.\n\n${block}\n`,
      block,
    ));
  }

  return results;
}
