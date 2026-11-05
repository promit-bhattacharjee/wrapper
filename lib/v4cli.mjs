// CLI command router for Wrapper v4.2 (.wrapper/{docs,agents,track}).
import fs from 'node:fs';
import path from 'node:path';
import { ensureWrapperDirs, resolveBaseDir } from './io.mjs';
import { withDb } from './db.mjs';
import {
  upsertSpecMeta, upsertSpecReq, getSpecSlice, listSpecs,
  recordTaste, setTasteStatus, listTaste, capturePromptTaste,
  syncDeployment, linkSpecToDeployment,
} from './docs.mjs';
import {
  draftJobRequisition, matchOrHire, hireEmployee, listRoster, getEmployee,
  recordPointEvent, blameDefect,
} from './agents.mjs';
import {
  scheduleSpec, acquireFileLease, releaseFileLeases, provisionWorktree,
} from './scheduler.mjs';
import {
  registerBlindTest, runVerifiedTest, submitTask, verifyTask,
  openRoom, postRoomTurn, closeRoom, buildAgentContext,
  computeScoreboard, inspectHumanReadable,
} from './track.mjs';
import {
  issuePushback, ackPushbacks, auditExternalAgentWorktree, generatePmSitrep, evaluateEditGuard,
} from './monitor.mjs';
import { ensureIdeFiles } from './ide.mjs';

const csv = (v) => (v && v !== true ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);
const s = (v) => (v && v !== true ? String(v) : '');
const outJson = (obj, pretty = true) => console.log(pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj));

export const V4_COMMANDS = new Set([
  'init', 're', 'spec', 'taste', 'deploy', 'hr', 'pm', 'monitor',
  'desk', 'blind-test', 'test', 'submit', 'verify', 'blame', 'room',
  'ctx', 'ide', 'scoreboard', 'inspect',
]);

export async function runV4Command(cmd, pos, flags, selfCliRel = '.agents/plugins/wrapper/bin/wrapper.mjs') {
  const baseDir = resolveBaseDir(flags.dir);
  const compact = !!flags.compact;
  const print = (o) => outJson(o, !compact);

  switch (cmd) {
    case 'init': {
      const p = ensureWrapperDirs(baseDir);
      await withDb(baseDir, () => {});
      const deploy = syncDeployment(baseDir, { service: s(flags.service) || undefined });
      const ide = ensureIdeFiles(baseDir, { cliPath: selfCliRel, copilot: !!flags.copilot });
      return print({
        ok: true,
        wrapper_root: p.root.replace(/\\/g, '/'),
        directories: ['docs', 'agents', 'track'],
        founding_staff: ['emp-re (Farhana Karim)', 'emp-hr (Tariq Mahmud)'],
        deploy_target: `${deploy.main_branch}->${deploy.deploy_branch}`,
        ide_files: ide,
      });
    }

    case 're':
    case 'spec': {
      const [sub] = pos;
      if (sub === 'list' || !sub) return print(listSpecs(baseDir));
      const feat = s(flags.feat) || pos[1];
      if (sub === 'meta') {
        return print(upsertSpecMeta(baseDir, feat, {
          intent: flags.goal || flags['fast-lane'] ? { goal: s(flags.goal), fast_lane: !!flags['fast-lane'] } : undefined,
          plan: flags.plan ? { summary: s(flags.plan) } : undefined,
          radius: (flags.own || flags.ro || flags.shared)
            ? { own: csv(flags.own), ro: csv(flags.ro), shared: csv(flags.shared) }
            : undefined,
        }));
      }
      if (sub === 'upsert') {
        const rec = await upsertSpecReq(baseDir, feat, {
          id: s(flags.id),
          s: s(flags.slice) || 'core',
          w: s(flags.when),
          do: s(flags.do),
          err: csv(flags.err),
          f: csv(flags.files),
          t: s(flags['test-id']) || undefined,
          reset_on_change: !!flags.reset,
        });
        ensureIdeFiles(baseDir, { cliPath: selfCliRel });
        return print(rec);
      }
      if (sub === 'slice') {
        return print(getSpecSlice(baseDir, feat, csv(flags.req), { expand: !flags.raw }));
      }
      if (sub === 'requisition') {
        return print(draftJobRequisition(baseDir, {
          archetype: s(flags.archetype),
          role: s(flags.role),
          level: s(flags.level),
          domain: s(flags.domain) || feat,
          tech: csv(flags.tech),
          files: csv(flags.files),
          jd: s(flags.jd),
          team: s(flags.team) || feat,
          ceoConfirmed: !!flags['ceo-confirmed'],
        }));
      }
      throw new Error(`Unknown ${cmd} subcommand "${sub}" (list|meta|upsert|slice|requisition)`);
    }

    case 'taste': {
      const [sub] = pos;
      if (sub === 'record') {
        return print(recordTaste(baseDir, {
          key: s(flags.key),
          rule: s(flags.rule) || pos.slice(1).join(' '),
          scope: s(flags.scope) || 'all',
          status: s(flags.status) || 'inbox',
          confidence: flags.conf ? Number(flags.conf) : 0.8,
          source: s(flags.source) || 'ceo',
        }));
      }
      if (sub === 'approve') return print(setTasteStatus(baseDir, pos[1] || s(flags.key), 'approved'));
      if (sub === 'reject') return print(setTasteStatus(baseDir, pos[1] || s(flags.key), 'rejected'));
      return print(listTaste(baseDir, { status: s(flags.status) || null }));
    }

    case 'deploy': {
      const [sub] = pos;
      if (sub === 'link') {
        return print(linkSpecToDeployment(baseDir, s(flags.feat) || pos[1], { sha: s(flags.sha) || null }));
      }
      return print(syncDeployment(baseDir, {
        service: s(flags.service) || undefined,
        deploy_branch: s(flags['deploy-branch']) || undefined,
      }));
    }

    case 'hr': {
      const [sub] = pos;
      if (sub === 'roster' || !sub) {
        return print(listRoster(baseDir, { includeTerminated: !!flags.all, expand: !!flags.expand }));
      }
      if (sub === 'card') {
        const emp = getEmployee(baseDir, pos[1] || s(flags.emp));
        if (!emp) throw new Error('Employee not found');
        return print(emp);
      }
      if (sub === 'match') {
        return print(matchOrHire(baseDir, {
          archetype: s(flags.archetype),
          role: s(flags.role) || 'eng',
          level: s(flags.level),
          domain: s(flags.domain),
          team: s(flags.team) || s(flags.domain),
          tech: csv(flags.tech),
          files: csv(flags.files),
          jd: s(flags.jd),
          ceoConfirmed: !!flags['ceo-confirmed'],
        }, {
          name: s(flags.name) || null,
          handle: s(flags.handle) || null,
          forceHire: !!flags.force,
        }));
      }
      if (sub === 'hire') {
        const req = draftJobRequisition(baseDir, {
          archetype: s(flags.archetype) || 'ECA-L2',
          role: s(flags.role),
          level: s(flags.level),
          domain: s(flags.domain) || 'general',
          team: s(flags.team) || s(flags.domain) || 'core',
          tech: csv(flags.tech).length ? csv(flags.tech) : ['general'],
          files: csv(flags.files),
          jd: s(flags.jd),
          ceoConfirmed: true,
        });
        return print(hireEmployee(baseDir, req, {
          name: s(flags.name) || null,
          handle: s(flags.handle) || null,
          manager: s(flags.mgr) || null,
          inst: s(flags.inst) || null,
        }));
      }
      if (sub === 'points') {
        return print(await recordPointEvent(baseDir, {
          empId: s(flags.emp),
          code: s(flags.code),
          taskId: s(flags.task) || null,
          evidence: s(flags.evidence) || pos.slice(1).join(' '),
          lesson: s(flags.lesson) || null,
          touchedFiles: csv(flags.files),
        }));
      }
      throw new Error(`Unknown hr subcommand "${sub}" (roster|card|match|hire|points)`);
    }

    case 'pm':
    case 'monitor': {
      const [sub] = pos;
      if (cmd === 'monitor' && (!sub || sub === 'sitrep')) {
        return print(await generatePmSitrep(baseDir, { teamId: s(flags.team) || null }));
      }
      if (sub === 'sitrep' || !sub) {
        return print(await generatePmSitrep(baseDir, { teamId: s(flags.team) || null }));
      }
      if (sub === 'schedule') {
        return print(await scheduleSpec(baseDir, s(flags.feat) || pos[1], {
          pmId: s(flags.pm) || null,
          autoStaff: flags['no-staff'] ? false : true,
          tech: csv(flags.tech).length ? csv(flags.tech) : ['general'],
          level: s(flags.level) || 'L2',
          provisionWorktrees: !!flags.worktrees,
        }));
      }
      if (sub === 'pushback') {
        return print(await issuePushback(baseDir, {
          empId: s(flags.emp),
          fromPm: s(flags.from) || 'PM',
          taskId: s(flags.task) || null,
          severity: s(flags.severity) || 'warn',
          message: s(flags.msg) || pos.slice(1).join(' '),
        }));
      }
      if (sub === 'ack') {
        await ackPushbacks(baseDir, s(flags.emp) || pos[1]);
        return print({ ok: true, acked_for: s(flags.emp) || pos[1] });
      }
      if (sub === 'audit') {
        const res = await auditExternalAgentWorktree(baseDir, {
          empId: s(flags.emp),
          tool: s(flags.tool) || 'chatgpt',
          cwd: s(flags.cwd) || null,
          taskId: s(flags.task) || null,
        });
        if (!res.ok) process.exitCode = 2;
        return print(res);
      }
      throw new Error(`Unknown ${cmd} subcommand "${sub}" (sitrep|schedule|pushback|ack|audit)`);
    }

    case 'desk': {
      const [sub] = pos;
      const empId = s(flags.emp) || pos[1];
      if (sub === 'lease') {
        const res = await acquireFileLease(baseDir, {
          empId,
          filePath: s(flags.file) || pos[2],
          mode: s(flags.mode) || 'rw',
          taskId: s(flags.task) || null,
        });
        if (!res.ok) process.exitCode = 2;
        return print(res);
      }
      if (sub === 'release') {
        const count = await releaseFileLeases(baseDir, empId, { releaseBlindTests: !!flags.all });
        return print({ ok: true, released: count });
      }
      if (sub === 'worktree') {
        return print(provisionWorktree(baseDir, empId));
      }
      const p = ensureWrapperDirs(baseDir);
      const deskFile = path.join(p.desksDir, `${empId}.json`);
      return print(fs.existsSync(deskFile) ? JSON.parse(fs.readFileSync(deskFile, 'utf8')) : { emp: empId, queue: [] });
    }

    case 'blind-test': {
      return print(await registerBlindTest(baseDir, {
        qaId: s(flags.qa),
        taskId: s(flags.task),
        testFile: s(flags.file),
      }));
    }

    case 'test': {
      const res = await runVerifiedTest(baseDir, {
        empId: s(flags.emp) || s(flags.as) || 'emp-unknown',
        taskId: s(flags.task) || null,
        cmd: s(flags.cmd) || pos.join(' '),
        cwd: s(flags.cwd) || null,
        tokensUsed: Number(flags.tokens || 0),
      });
      if (res.receipt.exit_code !== 0) process.exitCode = res.receipt.exit_code > 0 ? res.receipt.exit_code : 1;
      return print(res.receipt);
    }

    case 'submit': {
      const res = await submitTask(baseDir, {
        empId: s(flags.emp) || s(flags.as),
        taskId: s(flags.task) || pos[0],
        receiptId: s(flags.receipt) || null,
        cwd: s(flags.cwd) || null,
        tokensUsed: Number(flags.tokens || 0),
      });
      if (!res.ok) process.exitCode = 2;
      return print(res);
    }

    case 'verify': {
      return print(await verifyTask(baseDir, {
        verifierId: s(flags.verifier) || s(flags.as),
        taskId: s(flags.task) || pos[0],
        approve: !flags.reject,
        note: s(flags.note) || '',
        cwd: s(flags.cwd) || null,
      }));
    }

    case 'blame': {
      return print(await blameDefect(baseDir, {
        repoDir: s(flags.repo) || null,
        file: s(flags.file) || pos[0],
        line: Number(flags.line || 1),
        fixCommit: s(flags['fix-commit']) || null,
        taskId: s(flags.task) || null,
        note: s(flags.note) || '',
      }));
    }

    case 'room': {
      const [sub] = pos;
      if (sub === 'open') {
        return print(await openRoom(baseDir, {
          topic: s(flags.topic) || pos.slice(1).join(' '),
          feat: s(flags.feat) || null,
          chairId: s(flags.chair) || 'CEO',
          members: csv(flags.members),
        }));
      }
      if (sub === 'say') {
        return print(await postRoomTurn(baseDir, {
          roomId: s(flags.room) || pos[1],
          empId: s(flags.emp) || s(flags.as),
          kind: s(flags.kind) || 'propose',
          body: s(flags.body) || pos.slice(2).join(' '),
        }));
      }
      if (sub === 'close') {
        return print(await closeRoom(baseDir, {
          roomId: s(flags.room) || pos[1],
          chairId: s(flags.chair) || 'CEO',
          resolution: s(flags.resolution) || pos.slice(2).join(' '),
        }));
      }
      throw new Error(`Unknown room subcommand "${sub}" (open|say|close)`);
    }

    case 'ctx': {
      return print(await buildAgentContext(baseDir, {
        empId: s(flags.emp) || pos[0],
        taskId: s(flags.task) || null,
      }));
    }

    case 'ide': {
      return print(ensureIdeFiles(baseDir, { cliPath: selfCliRel, copilot: !!flags.copilot }));
    }

    case 'scoreboard': {
      return print(await computeScoreboard(baseDir));
    }

    case 'inspect': {
      return print(await inspectHumanReadable(baseDir, pos[0] || 'all'));
    }

    default:
      throw new Error(`Unhandled v4 command "${cmd}"`);
  }
}

// Optional v4 hook bridge invoked from Claude hooks when a .wrapper/ directory exists in cwd.
export async function handleV4ClaudeHook(ev, input, cwd) {
  let cur = path.resolve(cwd || process.cwd());
  let wrapperBase = null;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(cur, '.wrapper'))) { wrapperBase = cur; break; }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  if (!wrapperBase) return null;

  if (ev === 'UserPromptSubmit' && input.prompt) {
    try { capturePromptTaste(wrapperBase, String(input.prompt), 'claude_hook'); } catch {}
    return null;
  }

  if (ev === 'PreToolUse') {
    const empId = process.env.WRAPPER_EMP || input.emp_id || null;
    const fp = input.tool_input?.file_path || input.tool_input?.notebook_path;
    if (empId && fp) {
      return evaluateEditGuard(wrapperBase, { empId, tool: 'claude', filePath: fp });
    }
  }
  return null;
}
