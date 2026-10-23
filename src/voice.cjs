const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// On-device speech to text through Apple's SpeechTranscriber; the packaged binary is unpacked from the asar archive.
const transcriberPath = () => path.join(__dirname, '..', 'mac', 'blots-transcribe').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);

async function transcribe(audio) {
  if (process.platform !== 'darwin') throw new Error('Voice input is only available on macOS.');
  if (!fs.existsSync(transcriberPath())) throw new Error('The transcriber is not built. Run npm run mac:build.');
  const file = path.join(os.tmpdir(), `blots-voice-${process.pid}-${Date.now()}.wav`);
  fs.writeFileSync(file, audio, { mode: 0o600 });
  try {
    const output = await new Promise(resolve => execFile(transcriberPath(), [file], { timeout: 120000 }, (_error, stdout) => resolve(stdout)));
    const reply = JSON.parse(String(output).trim().split('\n').at(-1) || '{}');
    if (reply.error || typeof reply.text !== 'string') throw new Error(reply.error || 'Transcription failed.');
    return reply.text;
  } finally { fs.rmSync(file, { force: true }); }
}
module.exports = { transcribe };
