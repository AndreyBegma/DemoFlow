// A stand-in for `demoflow run --progress`: stdout written in awkward chunks —
// a line split across two, CRLF, a 9 KiB line, then one more line.
const chunks = [
  '{"type":"progress","pha',
  'se":"app"}\r\nsecond\nthi',
  `rd\n${'x'.repeat(9 * 1024)}`,
  `${'y'.repeat(100)}\nlast\n`,
];

for (const chunk of chunks) {
  process.stdout.write(chunk);
  await new Promise((resolve) => setTimeout(resolve, 30));
}
