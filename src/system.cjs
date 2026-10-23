const { execFile } = require('node:child_process');
const os = require('node:os');

const run = (file, args) => new Promise(resolve => execFile(file, args, { timeout: 3000 }, (_error, stdout) => resolve(String(stdout || ''))));
const ticks = () => os.cpus().reduce((sum, cpu) => { const t = cpu.times; sum.busy += t.user + t.nice + t.sys + t.irq; sum.total += t.user + t.nice + t.sys + t.irq + t.idle; return sum; }, { busy: 0, total: 0 });
let previous = ticks();

// This Mac's load, as Activity Monitor counts it: CPU across all cores, GPU device utilization, and memory used by apps, wired and compressed pages.
async function systemUse() {
  const now = ticks(), cpu = Math.round((now.busy - previous.busy) / Math.max(1, now.total - previous.total) * 100); previous = now;
  const result = { cpu, ram: { used: null, total: os.totalmem() }, gpu: null };
  if (process.platform !== 'darwin') { result.ram.used = os.totalmem() - os.freemem(); return result; }
  const [vm, gpu] = await Promise.all([run('/usr/bin/vm_stat', []), run('/usr/sbin/ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator', '-k', 'PerformanceStatistics'])]);
  const page = Number(vm.match(/page size of (\d+)/)?.[1] || 16384), pages = name => Number(vm.match(new RegExp(`${name}:\\s+(\\d+)`))?.[1] || 0);
  if (vm) result.ram.used = (pages('Anonymous pages') - pages('Pages purgeable') + pages('Pages wired down') + pages('Pages occupied by compressor')) * page;
  const device = gpu.match(/"Device Utilization %"=(\d+)/); if (device) result.gpu = Number(device[1]);
  return result;
}
module.exports = { systemUse };
