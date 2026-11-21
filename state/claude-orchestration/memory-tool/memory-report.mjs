import { collectReport, printTop } from './report-data.mjs';
import { writeJson } from './process-data.mjs';

if (process.argv.length > 2) throw new Error('Usage: node memory-report.mjs');
try {
  const { report } = await collectReport();
  const file = await writeJson('memory-report', report);
  printTop(report);
  console.log(JSON.stringify({ file, totals: report.totals, wudf: report.wudf, errors: report.threads.errors }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
