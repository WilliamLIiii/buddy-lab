import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const systemEnvironment = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' };
const probe = String.raw`import ctypes,json,os,subprocess
lib=ctypes.CDLL('/usr/lib/libproc.dylib')
lib.proc_pidpath.argtypes=[ctypes.c_int,ctypes.c_void_p,ctypes.c_uint32]
lib.proc_pidpath.restype=ctypes.c_int
rows=[]
for line in subprocess.check_output(['/bin/ps','-eo','pid=,ppid=,uid='],text=True).splitlines():
 fields=line.split()
 if len(fields)!=3: continue
 pid,ppid,uid=map(int,fields);b=ctypes.create_string_buffer(4096)
 ok=lib.proc_pidpath(pid,b,len(b))>0
 rows.append({'pid':pid,'ppid':ppid,'uid':uid,'executable':b.value.decode('utf-8','strict') if ok else None,'executableVerified':ok})
print(json.dumps({'method':'macOS libproc.proc_pidpath','uid':os.getuid(),'rows':rows}))
`;

// lsof's OS txt inventory may retain deleted image paths when proc_pidpath cannot
// resolve them. It is only a negative target-image check, never an exe selector.
export function parseMappedTextEvidence(stdout, requestedPids) {
  const allowed = new Set(requestedPids), maps = new Map(); let current, descriptor;
  for (const line of stdout.split('\n').filter(Boolean)) {
    if (/^p\d+$/.test(line)) { current = Number(line.slice(1)); if (!allowed.has(current)) throw new Error('Unexpected mapped-image PID'); if (!maps.has(current)) maps.set(current, []); descriptor = undefined; continue; }
    if (line === 'ftxt') { descriptor = 'txt'; continue; }
    if (line.startsWith('n') && current && descriptor === 'txt') { const value = line.slice(1); if (!path.posix.isAbsolute(value) || value.includes('\0') || value.includes('\r') || path.posix.normalize(value) !== value) throw new Error('Unresolved mapped-image path'); maps.get(current).push(value); descriptor = undefined; continue; }
    throw new Error('Incomplete mapped-image record');
  }
  if (descriptor !== undefined) throw new Error('Incomplete mapped-image path');
  return maps;
}

function targetImageAbsent(row, prefix) {
  const paths = row.mappedTextPaths;
  return row.mappedTextVerified === true && Array.isArray(paths) && paths.length >= 2 && paths.includes('/usr/lib/dyld') && paths.every(value => typeof value === 'string' && path.posix.isAbsolute(value) && path.posix.normalize(value) === value && !value.includes('\0') && !value.includes('\r') && !value.startsWith(prefix));
}

// Pure classification of independently collected OS facts. command/comm are deliberately ignored.
export function classifyDesktopProcesses({ appPath, executable = 'BuddyLab', helperExecutables = [], rows, currentPid, uid }) {
  const main = path.join(appPath, 'Contents/MacOS', executable), prefix = path.join(appPath, 'Contents') + path.sep;
  const byPid = new Map(rows.map(row => [row.pid, row])), ancestors = new Set(); let cursor = currentPid;
  while (cursor && !ancestors.has(cursor)) { ancestors.add(cursor); cursor = byPid.get(cursor)?.ppid; }
  const mainImages = rows.filter(row => !ancestors.has(row.pid) && row.executableVerified === true && row.executable === main);
  const mainIds = new Set(mainImages.map(row => row.pid));
  const related = pid => { const seen = new Set(); while (pid && !seen.has(pid)) { if (mainIds.has(pid)) return true; seen.add(pid); pid = byPid.get(pid)?.ppid; } return false; };
  const allowedHelpers = new Set(helperExecutables), active = [...mainImages], unknown = []; let unrelatedMappedImages = 0;
  for (const row of rows) {
    if (ancestors.has(row.pid) || mainIds.has(row.pid)) continue;
    if (!row.executableVerified) { if (row.uid === uid) { if (targetImageAbsent(row, prefix)) unrelatedMappedImages++; else unknown.push({ pid: row.pid, reason: 'OS executable identity unavailable' }); } continue; }
    if (row.executable?.startsWith(prefix)) {
      if (allowedHelpers.has(row.executable) && related(row.pid)) active.push(row);
      else unknown.push({ pid: row.pid, reason: 'Bundle executable not a verified related helper' });
    }
  }
  return { status: active.length ? 'active' : unknown.length ? 'unknown' : 'inactive', active: active.map(({ pid, ppid, executable }) => ({ pid, ppid, executable })), unknown, unrelatedMappedImages, ancestorsExcluded: true, commandTextUsedAsIdentity: false };
}

export async function inspectDesktopProcesses({ appPath, executable = 'BuddyLab', helperExecutables = [] }) {
  if (process.platform !== 'darwin') return { status: 'unknown', active: [], unknown: [{ reason: 'Actual executable probe is macOS-only' }] };
  try {
    const result = await run('/usr/bin/python3', ['-I', '-c', probe], { cwd: '/', env: systemEnvironment, timeout: 10000, maxBuffer: 1024 * 1024 });
    const facts = JSON.parse(result.stdout);
    if (facts.method !== 'macOS libproc.proc_pidpath' || !Array.isArray(facts.rows) || !Number.isInteger(facts.uid)) throw new Error('Invalid kernel probe result');
    const unresolved = facts.rows.filter(row => !row.executableVerified && row.uid === facts.uid);
    if (unresolved.length && unresolved.length <= 100) try {
      const images = await run('/usr/sbin/lsof', ['-n', '-P', '-a', '-p', unresolved.map(row => row.pid).join(','), '-d', 'txt', '-F', 'pfn'], { cwd: '/', env: systemEnvironment, timeout: 5000, maxBuffer: 1024 * 1024 });
      if (images.stderr.trim()) throw new Error('Incomplete mapped-image query'); const maps = parseMappedTextEvidence(images.stdout, unresolved.map(row => row.pid));
      for (const row of unresolved) if (maps.has(row.pid)) { row.mappedTextPaths = maps.get(row.pid); row.mappedTextVerified = true; }
    } catch { /* Unresolved targets remain unknown; no argv/comm fallback. */ }
    return { ...classifyDesktopProcesses({ appPath, executable, helperExecutables, rows: facts.rows, currentPid: process.pid, uid: facts.uid }), method: facts.method };
  } catch { return { status: 'unknown', active: [], unknown: [{ reason: 'Cannot establish actual executable facts; no command-text fallback' }], commandTextUsedAsIdentity: false }; }
}
