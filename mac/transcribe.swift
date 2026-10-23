// Transcribes one recorded clip on-device with Apple's SpeechTranscriber and prints {"text": ...} or {"error": ...}.
// The model runs on the Neural Engine and is shared with the system, so Blots ships no weights of its own.
import AVFoundation
import Foundation
import Speech

struct Fail: Error { let message: String }

func reply(_ object: [String: String]) {
  let data = try! JSONSerialization.data(withJSONObject: object)
  FileHandle.standardOutput.write(data + Data("\n".utf8))
}

@main struct Transcribe {
  static func main() async {
    do {
      guard CommandLine.arguments.count == 2 else { throw Fail(message: "Usage: blots-transcribe <audio file>") }
      let file = try AVAudioFile(forReading: URL(fileURLWithPath: CommandLine.arguments[1]))
      var locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current)
      if locale == nil { locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US")) }
      guard let locale else { throw Fail(message: "On-device transcription is not available on this Mac.") }
      let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
      // The first use downloads the system speech model for this language; later uses are offline.
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) { try await request.downloadAndInstall() }
      let analyzer = SpeechAnalyzer(modules: [transcriber])
      async let text = transcriber.results.reduce(into: "") { text, result in text += String(result.text.characters) }
      if let end = try await analyzer.analyzeSequence(from: file) { try await analyzer.finalizeAndFinish(through: end) } else { await analyzer.cancelAndFinishNow() }
      reply(["text": try await text.trimmingCharacters(in: .whitespacesAndNewlines)])
    } catch let error as Fail {
      reply(["error": error.message]); exit(1)
    } catch {
      reply(["error": error.localizedDescription]); exit(1)
    }
  }
}
