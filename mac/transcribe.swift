// Live on-device transcription with Apple's SpeechTranscriber.
// Reads 16 kHz mono 16-bit PCM from stdin and prints one JSON line per result:
// {"text": ..., "final": false} while words may still change, {"final": true} once they settle.
// The model runs on the Neural Engine and is shared with the system, so Blots ships no weights of its own.
import AVFoundation
import Foundation
import Speech

struct Fail: Error { let message: String }

func emit(_ object: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: object)
  FileHandle.standardOutput.write(data + Data("\n".utf8))
}

@main struct Transcribe {
  static func main() async {
    do {
      var locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current)
      if locale == nil { locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US")) }
      guard let locale else { throw Fail(message: "On-device transcription is not available on this Mac.") }
      let transcriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
      // The first use downloads the system speech model for this language; later uses are offline.
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) { try await request.downloadAndInstall() }
      let source = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
      guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber], considering: source),
            let converter = AVAudioConverter(from: source, to: format) else { throw Fail(message: "The microphone format is not supported.") }
      let (inputs, feed) = AsyncStream<AnalyzerInput>.makeStream()
      let analyzer = SpeechAnalyzer(modules: [transcriber])
      let results = Task.detached {
        for try await result in transcriber.results { emit(["text": String(result.text.characters), "final": result.isFinal]) }
      }
      try await analyzer.start(inputSequence: inputs)
      emit(["ready": true])
      await Task.detached {
        var pending = Data()
        while let data = try? FileHandle.standardInput.read(upToCount: 3200), !data.isEmpty {
          pending += data
          let frames = AVAudioFrameCount(pending.count / 2)
          guard frames > 0, let input = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: frames) else { continue }
          pending.withUnsafeBytes { bytes in memcpy(input.int16ChannelData![0], bytes.baseAddress!, Int(frames) * 2) }
          input.frameLength = frames; pending = pending.suffix(from: pending.startIndex + Int(frames) * 2)
          let capacity = AVAudioFrameCount(Double(frames) * format.sampleRate / source.sampleRate) + 32
          guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { continue }
          var used = false
          converter.convert(to: output, error: nil) { _, status in
            if used { status.pointee = .noDataNow; return nil }
            used = true; status.pointee = .haveData; return input
          }
          if output.frameLength > 0 { feed.yield(AnalyzerInput(buffer: output)) }
        }
      }.value
      feed.finish()
      try await analyzer.finalizeAndFinishThroughEndOfInput()
      try await results.value
    } catch let error as Fail {
      emit(["error": error.message]); exit(1)
    } catch {
      emit(["error": error.localizedDescription]); exit(1)
    }
  }
}
