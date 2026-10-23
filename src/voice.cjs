const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Live on-device speech to text through Apple's SpeechTranscriber; the packaged binary is unpacked from the asar archive.
const transcriberPath = () => path.join(__dirname, '..', 'mac', 'blots-transcribe').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);

// Bridges one voice socket to a transcriber: binary messages are 16 kHz mono PCM, "end" finishes, and each JSON result line goes back.
function streamVoice(ws) {
  const fail = message => { ws.send(JSON.stringify({ error: message })); ws.close(); };
  if (process.platform !== 'darwin') return fail('Voice input is only available on macOS.');
  if (!fs.existsSync(transcriberPath())) return fail('The transcriber is not built. Run npm run mac:build.');
  const child = spawn(transcriberPath(), [], { stdio: ['pipe', 'pipe', 'ignore'] });
  let buffered = '';
  child.stdout.on('data', chunk => {
    const lines = (buffered + chunk).split('\n'); buffered = lines.pop();
    for (const line of lines) if (line.trim()) ws.send(line);
  });
  child.stdin.on('error', () => {});
  child.on('error', error => fail(error.message));
  child.on('close', () => ws.close());
  ws.on('message', (data, binary) => { if (binary) child.stdin.write(data); else if (String(data) === 'end') child.stdin.end(); });
  ws.on('close', () => { if (child.exitCode === null) child.kill(); });
}
module.exports = { streamVoice };
