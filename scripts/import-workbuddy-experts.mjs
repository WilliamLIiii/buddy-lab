import { importWorkBuddyExperts } from '../src/workbuddy-experts.mjs';
import path from 'node:path';
const args = process.argv.slice(2), options = {};
for (let index = 0; index < args.length; index++) {
  const flag = args[index]; if (!['--source', '--data-dir'].includes(flag) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('用法：node scripts/import-workbuddy-experts.mjs --source <已安装插件目录> --data-dir <BuddyLab数据目录>');
  options[flag === '--source' ? 'source' : 'dataDir'] = path.resolve(args[++index]);
}
if (!options.source || !options.dataDir) throw new Error('必须明确传入 --source 和 --data-dir；不会读取默认用户插件目录。');
try { console.log(JSON.stringify(await importWorkBuddyExperts(options), null, 2)); }
catch (error) { console.error(JSON.stringify({ imported: false, code: error.code || 'IMPORT_FAILED', message: error.message })); process.exitCode = 1; }
